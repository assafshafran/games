// Logic tests: geometry, laser detection, calibration maths and the scenario
// engine. No browser and no hardware, so every assertion is an exact number.
//
//   node test/logic.mjs
//
// Browser-only behaviour (module loading, the two windows finding each other,
// canvas rendering, the camera path) is covered by test/browser.mjs.

import { homographyFromQuads, applyHomography, invertHomography, orderCorners } from '../js/homography.js';
import { ShotDetector } from '../js/detect.js';
import { pointInPolygon } from '../js/geometry.js';
import { ScenarioEngine, validateScenario } from '../js/scenario.js';
import { buildScenario, listScenarios } from '../js/library.js';
import { findProjectedQuad } from '../js/calibrate.js';
import { readFile } from 'node:fs/promises';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS', name); }
  else { fail++; console.log('  FAIL', name, extra); }
};

const UNIT = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

// ---------------------------------------------------------------------------

function testHomography() {
  console.log('homography');

  // The camera sees a 1920x1080 arena as an oblique quad.
  const arena = [{ x: 0, y: 0 }, { x: 1920, y: 0 }, { x: 1920, y: 1080 }, { x: 0, y: 1080 }];
  const cam = [{ x: 112, y: 96 }, { x: 585, y: 60 }, { x: 622, y: 401 }, { x: 88, y: 365 }];
  const h = homographyFromQuads(cam, arena);
  ok('solves', h !== null);

  for (let i = 0; i < 4; i++) {
    const p = applyHomography(h, cam[i].x, cam[i].y);
    ok(`corner ${i} maps exactly`, Math.hypot(p.x - arena[i].x, p.y - arena[i].y) < 1e-6, JSON.stringify(p));
  }

  // A homography preserves lines and incidence, so the arena centre is where
  // the quad's diagonals cross. It is not the average of the corners, which
  // perspective pulls toward the far edge.
  const cross = (a, b, c, d) => {
    const t = ((a.x - c.x) * (c.y - d.y) - (a.y - c.y) * (c.x - d.x))
            / ((a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x));
    return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
  };
  const centre = applyHomography(h, ...Object.values(cross(cam[0], cam[2], cam[1], cam[3])));
  ok('diagonal crossing maps to arena centre',
    Math.abs(centre.x - 960) < 1 && Math.abs(centre.y - 540) < 1, JSON.stringify(centre));

  const back = applyHomography(invertHomography(h), centre.x, centre.y);
  const truth = cross(cam[0], cam[2], cam[1], cam[3]);
  ok('inverse round-trips', Math.hypot(back.x - truth.x, back.y - truth.y) < 1e-6, JSON.stringify(back));

  ok('rejects collinear points',
    homographyFromQuads([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }], arena) === null);
  ok('rejects duplicate corners',
    homographyFromQuads([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 0, y: 5 }], arena) === null);

  const shuffled = [cam[2], cam[0], cam[3], cam[1]];
  const ordered = orderCorners(shuffled);
  ok('orders shuffled corners to TL,TR,BR,BL',
    ordered.every((p, i) => p.x === cam[i].x && p.y === cam[i].y), JSON.stringify(ordered));
}

// ---------------------------------------------------------------------------

function testDetector() {
  console.log('laser detection');

  const w = 160;
  const h = 120;
  const frame = (dots) => {
    const a = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const o = i << 2;
      a[o] = 30; a[o + 1] = 34; a[o + 2] = 40; a[o + 3] = 255;
    }
    for (const d of dots) {
      for (let y = d.y - d.r; y <= d.y + d.r; y++) {
        for (let x = d.x - d.r; x <= d.x + d.r; x++) {
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          if (Math.hypot(x - d.x, y - d.y) > d.r) continue;
          const o = (y * w + x) << 2;
          a[o] = d.c[0]; a[o + 1] = d.c[1]; a[o + 2] = d.c[2];
        }
      }
    }
    return a;
  };

  const det = new ShotDetector(w, h);
  ok('first frame only seeds the background', det.detect(frame([]), 0) === null);
  ok('a quiet frame stays quiet', det.detect(frame([]), 50) === null);

  // A saturated red dot scores about 119 on perceptual luma, which is why the
  // detector thresholds on peak channel instead. This is the regression test.
  const red = det.detect(frame([{ x: 100, y: 60, r: 3, c: [255, 60, 60] }]), 100);
  ok('finds a red laser dot', red !== null, JSON.stringify(red));
  ok('locates it within 2px', red && Math.hypot(red.x - 100, red.y - 60) < 2, red && `${red.x},${red.y}`);
  ok('classifies it red', red?.color === 'red', red?.color);
  ok('a steady dot does not fire twice',
    det.detect(frame([{ x: 100, y: 60, r: 3, c: [255, 60, 60] }]), 140) === null);

  det.reset();
  det.detect(frame([]), 200);
  det.detect(frame([]), 220);
  const green = det.detect(frame([{ x: 40, y: 30, r: 3, c: [60, 255, 90] }]), 240);
  ok('classifies a green laser', green?.color === 'green', green?.color);

  // A large bright area is the projector, not a laser.
  det.reset();
  det.detect(frame([]), 300);
  ok('rejects a large bright region',
    det.detect(frame([{ x: 80, y: 60, r: 55, c: [250, 250, 250] }]), 320) === null);

  // Two shots in quick succession at the same place are one trigger pull.
  det.reset();
  det.detect(frame([]), 400);
  ok('accepts the first of a burst', det.detect(frame([{ x: 50, y: 50, r: 3, c: [255, 70, 70] }]), 420) !== null);
  det.detect(frame([]), 440);
  ok('suppresses a repeat within the dedupe window',
    det.detect(frame([{ x: 52, y: 51, r: 3, c: [255, 70, 70] }]), 460) === null);
  det.detect(frame([]), 700);
  ok('accepts the same spot once the window has passed',
    det.detect(frame([{ x: 52, y: 51, r: 3, c: [255, 70, 70] }]), 720) !== null);
}

// ---------------------------------------------------------------------------

function testCalibration() {
  console.log('calibration');

  const w = 320;
  const h = 240;
  const truth = [{ x: 38, y: 26 }, { x: 283, y: 52 }, { x: 262, y: 196 }, { x: 57, y: 172 }];

  // The camera's view: the projected quad, plus a lamp and a pale floor that
  // are lit in both frames and must therefore cancel in the difference.
  const scene = (lit) => {
    const a = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) << 2;
        let v = 18;
        if (x > 250 && x < 300 && y > 10 && y < 40) v = 245;
        if (y > 210) v = 90;
        if (lit && pointInPolygon(x, y, truth)) v = 232;
        a[o] = v; a[o + 1] = v; a[o + 2] = v; a[o + 3] = 255;
      }
    }
    return a;
  };

  const dark = scene(false);
  const res = findProjectedQuad(scene(true), dark, w, h);
  ok('locates the projection', !res.error, res.error ?? '');
  if (res.error) return;

  const err = res.corners.map((c, i) => Math.hypot(c.x - truth[i].x, c.y - truth[i].y));
  ok('corners within 3px', Math.max(...err) < 3, err.map((e) => e.toFixed(1)).join(','));
  ok('ignores the always-on lamp',
    res.corners.every((c) => c.x < 290 || c.y > 45), JSON.stringify(res.corners));

  const toArena = homographyFromQuads(res.corners, UNIT);
  ok('homography solves from detected corners', toArena !== null);

  const toCam = homographyFromQuads(UNIT, res.corners);
  const target = { x: 0.25, y: 0.75 };
  const cam = applyHomography(toCam, target.x, target.y);
  const roundTrip = applyHomography(toArena, cam.x, cam.y);
  ok('arena to camera and back',
    Math.hypot(roundTrip.x - target.x, roundTrip.y - target.y) < 1e-6, JSON.stringify(roundTrip));

  ok('reports a dim projection instead of guessing', !!findProjectedQuad(dark, dark, w, h).error);
}

// ---------------------------------------------------------------------------

const centroid = (poly) => ({
  x: poly.reduce((s, p) => s + p.x, 0) / poly.length,
  y: poly.reduce((s, p) => s + p.y, 0) / poly.length,
});

// Where an actor's zone (or its whole outline) sits right now.
function aim(engine, actorId, zoneIndex = null) {
  const p = engine.placements().find((q) => q.actor.id === actorId);
  if (!p || !p.visible) return null;
  return centroid(zoneIndex === null ? p.outline : p.zones[zoneIndex]);
}

function run(id, seed) {
  const scenario = buildScenario(id, seed);
  const engine = new ScenarioEngine(scenario);
  engine.start(0);
  return { engine, scenario };
}

// Step time forward until a given stage is reached.
function advanceTo(engine, stageId, limit = 20000) {
  for (let t = 0; t < limit; t += 50) {
    engine.update(t);
    if (engine.stageId === stageId) return t;
  }
  return -1;
}

function testHostageRescue() {
  console.log('hostage rescue: branching');

  {
    const { engine } = run('hostage_rescue', 7);
    ok('starts at the briefing', engine.stageId === 'brief', engine.stageId);
    const t = advanceTo(engine, 'standoff');
    ok('briefing leads to the standoff', t > 0, engine.stageId);

    const head = aim(engine, 'hostile', 0);
    ok('the hostile head is exposed', head !== null);
    const shot = engine.shoot(head.x, head.y, t + 100);
    ok('head shot lands on the hostile', shot.actor === 'hostile' && shot.zone === 'head', JSON.stringify(shot));
    ok('head shot wins', engine.finished && engine.outcome === 'win', `${engine.finished}/${engine.outcome}`);
  }

  {
    const { engine } = run('hostage_rescue', 7);
    const t = advanceTo(engine, 'standoff');
    const body = aim(engine, 'hostage');
    const shot = engine.shoot(body.x, body.y, t + 100);
    ok('hostage hit is attributed to the hostage', shot.actor === 'hostage' && shot.role === 'noshoot', JSON.stringify(shot));
    ok('hostage hit is penalised', shot.score < 0, String(shot.score));
    ok('hostage hit loses', engine.outcome === 'lose', String(engine.outcome));
  }

  {
    const { engine } = run('hostage_rescue', 7);
    const t = advanceTo(engine, 'standoff');
    for (let k = t; k < t + 12000; k += 50) engine.update(k);
    ok('waiting too long loses', engine.outcome === 'lose', String(engine.outcome));
  }

  {
    // Where the two overlap, the shot must count against the hostage in front:
    // the shooter did not have a clear angle.
    const { engine } = run('hostage_rescue', 7);
    const t = advanceTo(engine, 'standoff');
    const hostage = engine.placements().find((p) => p.actor.id === 'hostage');
    const topOfHead = Math.min(...hostage.outline.map((p) => p.y));
    const shot = engine.shoot(hostage.state.x, topOfHead + 0.02, t + 100);
    ok('a contested shot goes to the front actor', shot.actor === 'hostage', JSON.stringify(shot));
  }
}

function testDrills() {
  console.log('drills: scoring and completion');

  {
    const { engine, scenario } = run('steel_speed', 3);
    scenario.stages.run.actors.forEach((a, i) => {
      const c = aim(engine, a.id);
      engine.shoot(c.x, c.y, 500 + i * 300);
    });
    ok('clearing the rack wins', engine.outcome === 'win', String(engine.outcome));
    ok('five plates score 25', engine.score === 25, String(engine.score));
    ok('five hits, no misses', engine.stats.hits === 5 && engine.stats.misses === 0, JSON.stringify(engine.stats));
    ok('splits are recorded', engine.log[1].split === 300, String(engine.log[1].split));
  }

  {
    const { engine } = run('steel_speed', 3);
    const shot = engine.shoot(0.02, 0.02, 100);
    ok('a clean miss scores zero', shot.score === 0 && shot.actor === null, JSON.stringify(shot));
    ok('the miss is counted', engine.stats.misses === 1, JSON.stringify(engine.stats));
  }

  {
    const { engine } = run('mozambique', 5);
    const t = advanceTo(engine, 'engage');
    const centre = aim(engine, 'hostile', 1);
    engine.shoot(centre.x, centre.y, t + 100);
    ok('a centre hit does not end the drill', !engine.finished);
    const head = aim(engine, 'hostile', 0);
    engine.shoot(head.x, head.y, t + 400);
    ok('the head shot ends it', engine.outcome === 'win', String(engine.outcome));
    ok('head scores 10 and centre 7', engine.score === 17, String(engine.score));
  }

  {
    const { engine, scenario } = run('shoot_no_shoot', 11);
    const civilian = scenario.stages.run.actors.find((a) => a.type === 'civilian');
    ok('this seed includes a bystander', !!civilian);
    if (civilian) {
      const showAt = civilian.track.find((k) => k.visible === true).t;
      engine.update(showAt + 100);
      const c = aim(engine, civilian.id);
      ok('the bystander is visible in its window', c !== null);
      const shot = engine.shoot(c.x, c.y, showAt + 120);
      ok('shooting a bystander ends the run', engine.outcome === 'lose', String(engine.outcome));
      ok('shooting a bystander is penalised', shot.score < 0, String(shot.score));
    }
  }

  {
    const { engine, scenario } = run('shoot_no_shoot', 11);
    const first = scenario.stages.run.actors[0];
    const showAt = first.track.find((k) => k.visible === true).t;
    engine.update(0);
    ok('a hidden target cannot be hit', aim(engine, first.id) === null);
    engine.update(showAt + 100);
    ok('it becomes hittable in its window', aim(engine, first.id) !== null);
  }
}

function testLibrary() {
  console.log('every scenario, every seed');
  let bad = 0;
  const scenarios = listScenarios();
  for (const meta of scenarios) {
    for (let seed = 1; seed <= 200; seed++) {
      const problems = validateScenario(buildScenario(meta.id, seed));
      if (problems.length) { bad++; console.log('    ', meta.id, seed, problems.join('; ')); }
    }
  }
  ok(`${scenarios.length} scenarios x 200 seeds are all valid`, bad === 0, `${bad} invalid`);

  // A scenario that cannot be finished would strand the shooter mid-drill.
  const deadEnd = validateScenario({
    id: 'x', start: 'a',
    stages: { a: { actors: [], transitions: [] } },
  });
  ok('a dead-end stage is rejected', deadEnd.some((p) => p.includes('dead end')), deadEnd.join('; '));

  const dangling = validateScenario({
    id: 'x', start: 'a',
    stages: { a: { actors: [], duration: 100, transitions: [{ on: 'timeout', goto: 'nowhere' }] } },
  });
  ok('a transition to a missing stage is rejected', dangling.some((p) => p.includes('nowhere')), dangling.join('; '));
}

// The shipped example is documentation people will copy, so it has to stay
// valid as the format changes.
async function testShippedScenarios() {
  console.log('shipped scenario files');
  const raw = await readFile(new URL('../scenarios/bank-holdup.json', import.meta.url), 'utf8');
  const scenario = JSON.parse(raw);
  const problems = validateScenario(scenario);
  ok('bank-holdup.json is valid', problems.length === 0, problems.join('; '));

  // The teller must be a no-shoot. If the archetype ever loses that, a
  // scenario shipped as an example would reward hitting a bystander.
  const teller = scenario.stages.contact.actors.find((a) => a.id === 'teller');
  const engine = new ScenarioEngine(scenario);
  engine.start(0);
  advanceTo(engine, 'contact');
  const place = engine.placements().find((p) => p.actor.id === 'teller');
  ok('the teller is a no-shoot', place.actor.spec.role === 'noshoot', place.actor.spec.role);
  ok('the teller has no stray role field', teller.role === undefined, String(teller.role));

  const shot = engine.shoot(place.state.x, place.state.y - 0.1, 5000);
  ok('hitting the teller is penalised', shot.score < 0, String(shot.score));
  ok('hitting the teller branches to a losing stage',
    engine.stageId === 'teller_hit', engine.stageId);
}

// ---------------------------------------------------------------------------

await testShippedScenarios();
testHomography();
testDetector();
testCalibration();
testHostageRescue();
testDrills();
testLibrary();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
