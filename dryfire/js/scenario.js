// The scenario engine: a branching state machine over stages.
//
// A scenario is a graph of stages. Each stage shows something (drawn actors,
// or a video clip), places hit regions, and lists transitions saying where a
// given outcome leads. A hostage drill and a branching video scenario are the
// same object with a different media field, which is why one engine covers
// both: the engine never inspects the footage, it only tracks time, regions
// and outcomes. The arena renderer is responsible for putting pixels on the
// projector to match.
//
// Time is measured from the moment a stage begins, so a track authored against
// a video clip lines up with that clip's own timeline.

import { sampleTrack, transformPolygon, pointInPolygon } from './geometry.js';
import { archetype, resolveHit, isKnownArchetype } from './actors.js';

// Front-most actor wins a contested shot. A hostage stands in front of the
// hostile behind them, so a shot into the overlap must count against the
// hostage: the shooter did not have a clear angle and should not be rewarded.
const DEFAULT_Z = { noshoot: 10, threat: 0 };

export const OUTCOME = {
  WIN: 'win',
  LOSE: 'lose',
};

export class ScenarioEngine {
  constructor(scenario, { aspect = 16 / 9, onEvent = () => {} } = {}) {
    this.scenario = scenario;
    this.aspect = aspect;
    this.onEvent = onEvent;
    this.reset();
  }

  reset() {
    this.stage = null;
    this.stageId = null;
    this.stageStart = 0;
    this.elapsed = 0;
    this.actors = [];
    this.finished = false;
    this.outcome = null;
    this.log = [];
    this.score = 0;
    this.startedAt = 0;
    this.firstShotAt = null;
    this.lastShotAt = null;
    this.stats = { shots: 0, hits: 0, misses: 0, noshoot: 0, best: 0 };
  }

  start(now) {
    this.reset();
    this.startedAt = now;
    this._enterStage(this.scenario.start, now);
  }

  _enterStage(id, now) {
    const stage = this.scenario.stages[id];
    if (!stage) {
      this._finish(OUTCOME.LOSE, `scenario is missing stage "${id}"`, now);
      return;
    }

    this.stage = stage;
    this.stageId = id;
    this.stageStart = now;
    this.elapsed = 0;

    this.actors = (stage.actors ?? []).map((a) => {
      const spec = archetype(a.type);
      return {
        def: a,
        spec,
        id: a.id,
        z: a.z ?? DEFAULT_Z[spec.role] ?? 0,
        down: false,
        downAt: null,
        fired: false,
      };
    });
    // Draw and hit-test order are the same list read in opposite directions.
    this.actors.sort((p, q) => p.z - q.z);

    this.onEvent('stage', { id, stage, actors: this.actors });

    if (stage.outcome) {
      this._finish(stage.outcome, stage.caption ?? '', now);
    }
  }

  _finish(outcome, reason, now) {
    if (this.finished) return;
    this.finished = true;
    this.outcome = outcome;
    this.onEvent('finish', {
      outcome,
      reason,
      score: this.score,
      stats: this.stats,
      log: this.log,
      durationMs: now - this.startedAt,
    });
  }

  // Where each actor's polygons sit right now. Recomputed once per frame and
  // handed to both the renderer and the hit test.
  placements() {
    const out = [];
    for (const actor of this.actors) {
      const state = sampleTrack(actor.def.track, this.elapsed);
      if (!state.visible || actor.down) {
        out.push({ actor, state, visible: false, outline: null, zones: [] });
        continue;
      }
      out.push({
        actor,
        state,
        visible: true,
        outline: transformPolygon(actor.spec.outline, state, this.aspect),
        zones: actor.spec.zones.map((z) => transformPolygon(z.poly, state, this.aspect)),
      });
    }
    return out;
  }

  update(now) {
    if (this.finished || !this.stage) return;
    this.elapsed = now - this.stageStart;

    // A hostile left alone long enough gets its shot off first.
    for (const actor of this.actors) {
      const fireAt = actor.def.fireAt;
      if (fireAt == null || actor.down || actor.fired) continue;
      if (this.elapsed >= fireAt) {
        actor.fired = true;
        this.onEvent('threatFired', { actor });
        if (this._transition('threatFired', { actor: actor.id }, now)) return;
      }
    }

    const duration = this.stage.duration;
    if (duration != null && this.elapsed >= duration) {
      if (this._transition('timeout', {}, now)) return;
      this._finish(OUTCOME.LOSE, 'ran out of time', now);
    }
  }

  // Feed a shot in arena coordinates (0..1 on both axes).
  shoot(x, y, now, meta = {}) {
    if (this.finished || !this.stage) return null;
    this.elapsed = now - this.stageStart;

    const placed = this.placements();
    let result = null;

    // Front to back, so the nearest actor claims the shot.
    for (let i = placed.length - 1; i >= 0; i--) {
      const p = placed[i];
      if (!p.visible) continue;
      const hit = resolveHit(p.actor.spec, p, x, y, pointInPolygon);
      if (hit) {
        result = { actor: p.actor, ...hit };
        break;
      }
    }

    const record = {
      t: now - this.startedAt,
      stageTime: this.elapsed,
      x, y,
      stage: this.stageId,
      actor: result?.actor.id ?? null,
      role: result?.actor.spec.role ?? null,
      zone: result?.zone ?? null,
      score: result?.score ?? 0,
      split: this.lastShotAt == null ? null : now - this.lastShotAt,
      color: meta.color ?? 'unknown',
    };

    this.stats.shots++;
    if (this.firstShotAt == null) this.firstShotAt = now - this.startedAt;
    this.lastShotAt = now;

    if (!result) {
      this.stats.misses++;
    } else if (result.actor.spec.role === 'noshoot') {
      this.stats.noshoot++;
    } else {
      this.stats.hits++;
      if (record.score > this.stats.best) this.stats.best = record.score;
    }

    this.score += record.score;
    this.log.push(record);
    this.onEvent('shot', record);

    if (result) this._applyHit(result, now);
    return record;
  }

  _applyHit(result, now) {
    const actor = result.actor;

    if (actor.spec.role === 'noshoot') {
      this.onEvent('noshootHit', { actor, zone: result.zone });
      if (this._transition('noshootHit', { actor: actor.id }, now)) return;
      this._finish(OUTCOME.LOSE, `hit ${actor.def.label ?? actor.id}`, now);
      return;
    }

    // A drill can demand a specific zone, which is how a hostage rescue
    // refuses to accept anything but a head shot. An empty list means nothing
    // drops this target: the drill ends through its own transitions instead,
    // which is what lets one demand a sequence of hits.
    const required = actor.def.downOn;
    const goesDown = !required || required.includes(result.zone);
    if (goesDown) {
      actor.down = true;
      actor.downAt = now;
      this.onEvent('actorDown', { actor, zone: result.zone });
    }

    if (this._transition('hit', { actor: actor.id, zone: result.zone }, now)) return;

    const live = this.actors.filter((a) => a.spec.role === 'threat' && !a.down);
    if (live.length === 0) {
      if (this._transition('allThreatsDown', {}, now)) return;
      this._finish(OUTCOME.WIN, 'all threats neutralised', now);
    }
  }

  // Has the run already recorded enough qualifying hits?
  //
  // This is what lets a drill demand a sequence rather than a single shot: the
  // failure drill's head shot should only finish it once the body has been
  // hit twice. The shot being judged is already in the log, so a requirement
  // can also count the hit that triggered the transition.
  _satisfied({ actor, zone, count = 1 }) {
    let n = 0;
    for (const r of this.log) {
      if (actor != null && r.actor !== actor) continue;
      if (zone != null && r.zone !== zone) continue;
      if (++n >= count) return true;
    }
    return false;
  }

  // Find the first transition matching this event and follow it.
  // Returns true if the stage changed or the scenario ended.
  _transition(on, ctx, now) {
    for (const t of this.stage.transitions ?? []) {
      if (t.on !== on) continue;
      if (t.actor != null && t.actor !== ctx.actor) continue;
      if (t.zone != null && t.zone !== ctx.zone) continue;
      if (t.requires && !this._satisfied(t.requires)) continue;

      if (t.outcome) {
        this._finish(t.outcome, t.reason ?? '', now);
        return true;
      }
      this._enterStage(t.goto, now);
      return true;
    }
    return false;
  }
}

// Reject a malformed scenario up front rather than failing mid-drill in front
// of a loaded projector. Returns an array of human-readable problems.
export function validateScenario(s) {
  const problems = [];
  if (!s || typeof s !== 'object') return ['scenario is not an object'];
  if (!s.id) problems.push('missing id');
  if (!s.stages || typeof s.stages !== 'object') return [...problems, 'missing stages'];
  if (!s.stages[s.start]) problems.push(`start stage "${s.start}" does not exist`);

  for (const [id, stage] of Object.entries(s.stages)) {
    for (const t of stage.transitions ?? []) {
      if (!t.outcome && !s.stages[t.goto]) {
        problems.push(`stage "${id}" transitions to unknown stage "${t.goto}"`);
      }
      if (t.requires && !(t.requires.count > 0)) {
        problems.push(`stage "${id}" has a transition requiring a count of ${t.requires.count}`);
      }
    }
    for (const a of stage.actors ?? []) {
      if (!a.id) problems.push(`stage "${id}" has an actor with no id`);
      if (!a.track || !a.track.length) {
        problems.push(`actor "${a.id}" in stage "${id}" has no track`);
      }
      // An unknown type would fall back to a plain hostile. For an actor meant
      // to be a no-shoot that silently turns a penalty into a reward, so a
      // typo has to be an error rather than a default.
      if (!isKnownArchetype(a.type)) {
        problems.push(`actor "${a.id}" in stage "${id}" has unknown type "${a.type}"`);
      }
      if (a.role != null) {
        problems.push(`actor "${a.id}" in stage "${id}" sets "role", which is ignored: choose a type whose role is what you want`);
      }
    }
    const terminal = stage.outcome != null;
    const canLeave = (stage.transitions ?? []).length > 0;
    if (!terminal && !canLeave && stage.duration == null) {
      problems.push(`stage "${id}" is a dead end: no transitions, no duration, no outcome`);
    }
  }
  return problems;
}
