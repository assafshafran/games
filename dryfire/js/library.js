// Built-in scenarios.
//
// Each entry is a builder rather than a literal so a drill can place its
// targets differently on every run. Shooting the same three positions twenty
// times trains the positions, not the skill, so anything that would otherwise
// be memorised is drawn from the run's seeded generator.
//
// Coordinates are 0..1 across the arena, y downward. Actor tracks place feet.

// Small deterministic generator, so a session can be replayed from its seed.
export function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];
const between = (rng, lo, hi) => lo + rng() * (hi - lo);

// A target that simply stands still for the whole stage.
const stand = (x, y, scale) => [{ t: 0, x, y, scale }];

// A pop-up: hidden, visible for a window, then gone again.
const popup = (x, y, scale, showAt, hideAt) => [
  { t: 0, x, y, scale, visible: false },
  { t: showAt, x, y, scale, visible: true },
  { t: hideAt, x, y, scale, visible: false },
];

const win = (caption) => ({ outcome: 'win', caption, actors: [], transitions: [] });
const lose = (caption) => ({ outcome: 'lose', caption, actors: [], transitions: [] });

// ---------------------------------------------------------------------------

function zeroing() {
  return {
    id: 'zeroing',
    name: 'Zeroing',
    description: 'Three static plates. Confirms calibration and point of aim before anything moves.',
    difficulty: 'warm-up',
    tags: ['static'],
    start: 'run',
    stages: {
      run: {
        backdrop: 'range',
        caption: 'Hit all three plates',
        duration: 60000,
        actors: [
          { id: 'p1', type: 'plate', track: stand(0.25, 0.55, 0.16) },
          { id: 'p2', type: 'plate', track: stand(0.50, 0.50, 0.16) },
          { id: 'p3', type: 'plate', track: stand(0.75, 0.55, 0.16) },
        ],
        transitions: [
          { on: 'allThreatsDown', outcome: 'win', reason: 'all plates down' },
          { on: 'timeout', outcome: 'lose', reason: 'ran out of time' },
        ],
      },
    },
  };
}

function mozambique(rng) {
  const x = between(rng, 0.35, 0.65);
  return {
    id: 'mozambique',
    name: 'Failure Drill',
    description: 'Two to the centre, one to the head, against a par time. The head only counts once the body is hit.',
    difficulty: 'standard',
    tags: ['timed', 'zones'],
    start: 'brief',
    stages: {
      brief: {
        backdrop: 'range',
        caption: 'Two centre, then one head',
        duration: 1800,
        actors: [],
        transitions: [{ on: 'timeout', goto: 'engage' }],
      },
      engage: {
        backdrop: 'range',
        duration: 12000,
        actors: [
          {
            id: 'hostile',
            type: 'threat',
            track: stand(x, 0.94, 0.8),
            // Nothing drops this target. A head shot would otherwise leave no
            // threats standing and win the drill by the default rule, before
            // the sequence below had been satisfied.
            downOn: [],
          },
        ],
        transitions: [
          // The head shot only finishes the drill once centre mass has been
          // hit twice, which is the drill. A head shot before that scores but
          // does not end the run.
          {
            on: 'hit',
            actor: 'hostile',
            zone: 'head',
            requires: { actor: 'hostile', zone: 'centre', count: 2 },
            outcome: 'win',
            reason: 'failure drill complete',
          },
          { on: 'timeout', outcome: 'lose', reason: 'par time expired' },
        ],
      },
    },
  };
}

function hostageRescue(rng) {
  // The hostile stands behind and slightly to one side, so only the top of the
  // head is clear. Which side is randomised: a shooter should not be able to
  // pre-aim the gap.
  const side = rng() < 0.5 ? -1 : 1;
  const hx = between(rng, 0.42, 0.58);
  const hostageScale = 0.8;
  const threatScale = 0.95;

  return {
    id: 'hostage_rescue',
    name: 'Hostage Rescue',
    description: 'A hostile behind a hostage with only the head exposed. Head shot ends it, any hit on the hostage fails, and waiting too long fails.',
    difficulty: 'hard',
    tags: ['branching', 'no-shoot', 'precision'],
    start: 'brief',
    stages: {
      brief: {
        backdrop: 'room',
        caption: 'Hostage taken. Only a clear head shot is acceptable.',
        duration: 2600,
        actors: [],
        transitions: [{ on: 'timeout', goto: 'standoff' }],
      },
      standoff: {
        backdrop: 'room',
        caption: '',
        duration: 9000,
        actors: [
          {
            id: 'hostile',
            type: 'threat_peek',
            label: 'hostage taker',
            // Sways slightly, so the shot is not a static aim-and-wait.
            track: [
              { t: 0, x: hx + side * 0.075, y: 0.94, scale: threatScale },
              { t: 2500, x: hx + side * 0.095, y: 0.94, scale: threatScale },
              { t: 5000, x: hx + side * 0.06, y: 0.945, scale: threatScale },
              { t: 9000, x: hx + side * 0.09, y: 0.94, scale: threatScale },
            ],
            downOn: ['head'],
            fireAt: 8200,
          },
          {
            id: 'hostage',
            type: 'hostage',
            label: 'hostage',
            z: 20,
            track: [
              { t: 0, x: hx, y: 0.94, scale: hostageScale },
              { t: 2500, x: hx + side * 0.02, y: 0.94, scale: hostageScale },
              { t: 5000, x: hx - side * 0.015, y: 0.945, scale: hostageScale },
              { t: 9000, x: hx + side * 0.015, y: 0.94, scale: hostageScale },
            ],
          },
        ],
        transitions: [
          { on: 'hit', actor: 'hostile', zone: 'head', goto: 'neutralised' },
          { on: 'noshootHit', goto: 'hostage_hit' },
          { on: 'threatFired', goto: 'too_slow' },
          { on: 'timeout', goto: 'too_slow' },
        ],
      },
      neutralised: win('Hostile down. Hostage safe.'),
      hostage_hit: lose('You hit the hostage.'),
      too_slow: lose('Too slow. The hostile fired first.'),
    },
  };
}

function shootNoShoot(rng) {
  // Six figures appear one at a time in randomised positions; roughly half
  // are civilians. The shooter has to identify before firing.
  const lanes = [0.16, 0.32, 0.48, 0.64, 0.80];
  const actors = [];
  let t = 600;
  let threats = 0;

  for (let i = 0; i < 6; i++) {
    const isThreat = rng() < 0.55;
    if (isThreat) threats++;
    const lane = pick(rng, lanes) + between(rng, -0.03, 0.03);
    const show = t;
    const hide = t + between(rng, 1500, 2300);
    actors.push({
      id: `f${i}`,
      type: isThreat ? 'threat' : 'civilian',
      label: isThreat ? 'hostile' : 'bystander',
      track: popup(lane, between(rng, 0.90, 0.97), between(rng, 0.62, 0.78), show, hide),
    });
    t = hide + between(rng, 250, 800);
  }

  // Guarantee at least one hostile, otherwise the drill cannot be won.
  if (threats === 0) actors[0].type = 'threat';

  return {
    id: 'shoot_no_shoot',
    name: 'Shoot / No-Shoot',
    description: 'Figures appear one at a time. Some are armed, some are bystanders. One wrong shot ends the run.',
    difficulty: 'standard',
    tags: ['no-shoot', 'identification'],
    start: 'run',
    stages: {
      run: {
        backdrop: 'street',
        caption: 'Identify before you fire',
        duration: t + 900,
        actors,
        transitions: [
          { on: 'noshootHit', goto: 'civilian_hit' },
          { on: 'allThreatsDown', outcome: 'win', reason: 'all hostiles neutralised' },
          { on: 'timeout', outcome: 'lose', reason: 'hostiles left standing' },
        ],
      },
      civilian_hit: lose('You shot a bystander.'),
    },
  };
}

function advancingThreat(rng) {
  const x = between(rng, 0.38, 0.62);
  // Scale grows as the figure closes, which reads as approaching on a flat
  // projected image and makes the target easier as time runs out.
  return {
    id: 'advancing_threat',
    name: 'Advancing Threat',
    description: 'A hostile closes on you and fires at seven seconds. It gets easier to hit and more expensive to wait.',
    difficulty: 'standard',
    tags: ['moving', 'timed'],
    start: 'run',
    stages: {
      run: {
        backdrop: 'street',
        caption: 'Stop the threat',
        duration: 7400,
        actors: [
          {
            id: 'hostile',
            type: 'threat',
            track: [
              { t: 0, x, y: 0.72, scale: 0.30 },
              { t: 3500, x: x + between(rng, -0.08, 0.08), y: 0.84, scale: 0.55 },
              { t: 7000, x: x + between(rng, -0.05, 0.05), y: 0.97, scale: 0.95 },
            ],
            fireAt: 7000,
          },
        ],
        transitions: [
          { on: 'threatFired', goto: 'hit_by_threat' },
          { on: 'allThreatsDown', outcome: 'win', reason: 'threat stopped' },
          { on: 'timeout', goto: 'hit_by_threat' },
        ],
      },
      hit_by_threat: lose('The hostile reached you.'),
    },
  };
}

function steelSpeed(rng) {
  const actors = [];
  for (let i = 0; i < 5; i++) {
    actors.push({
      id: `plate${i}`,
      type: 'plate',
      track: stand(0.12 + i * 0.19 + between(rng, -0.02, 0.02), between(rng, 0.40, 0.62), 0.13),
    });
  }
  return {
    id: 'steel_speed',
    name: 'Steel Speed',
    description: 'Five plates, fastest time wins. Pure speed and transitions, no decisions.',
    difficulty: 'warm-up',
    tags: ['timed', 'speed'],
    start: 'run',
    stages: {
      run: {
        backdrop: 'range',
        caption: 'Clear the rack',
        duration: 30000,
        actors,
        transitions: [
          { on: 'allThreatsDown', outcome: 'win', reason: 'rack cleared' },
          { on: 'timeout', outcome: 'lose', reason: 'ran out of time' },
        ],
      },
    },
  };
}

function roomClearing(rng) {
  // Three rooms in sequence. Each is its own stage, so a mistake in room one
  // ends the run rather than being averaged away over the whole scenario.
  const stages = {};
  const roomIds = ['room1', 'room2', 'room3'];

  roomIds.forEach((id, idx) => {
    const count = 2 + Math.floor(rng() * 2);
    const actors = [];
    let t = 500;
    for (let i = 0; i < count; i++) {
      const isThreat = i === 0 ? true : rng() < 0.6;
      const show = t;
      const hide = t + between(rng, 1800, 2600);
      actors.push({
        id: `${id}_f${i}`,
        type: isThreat ? 'threat' : 'civilian',
        label: isThreat ? 'hostile' : 'bystander',
        track: popup(between(rng, 0.15, 0.85), between(rng, 0.90, 0.97), between(rng, 0.62, 0.80), show, hide),
      });
      t = hide - between(rng, 400, 1000);
    }

    const next = roomIds[idx + 1];
    stages[id] = {
      backdrop: 'room',
      caption: `Room ${idx + 1}`,
      duration: t + 2600,
      actors,
      transitions: [
        { on: 'noshootHit', goto: 'civilian_hit' },
        next
          ? { on: 'allThreatsDown', goto: next }
          : { on: 'allThreatsDown', outcome: 'win', reason: 'all rooms clear' },
        { on: 'timeout', outcome: 'lose', reason: 'hostiles left standing' },
      ],
    };
  });

  stages.civilian_hit = lose('You shot a bystander.');

  return {
    id: 'room_clearing',
    name: 'Room Clearing',
    description: 'Three rooms in sequence, mixed hostiles and bystanders. Clear one to move to the next.',
    difficulty: 'hard',
    tags: ['branching', 'no-shoot', 'sequence'],
    start: 'room1',
    stages,
  };
}

export const LIBRARY = [
  { id: 'zeroing', build: zeroing },
  { id: 'steel_speed', build: steelSpeed },
  { id: 'mozambique', build: mozambique },
  { id: 'advancing_threat', build: advancingThreat },
  { id: 'shoot_no_shoot', build: shootNoShoot },
  { id: 'room_clearing', build: roomClearing },
  { id: 'hostage_rescue', build: hostageRescue },
];

export function buildScenario(id, seed = Date.now()) {
  const entry = LIBRARY.find((e) => e.id === id) ?? LIBRARY[0];
  const scenario = entry.build(makeRng(seed));
  scenario.seed = seed;
  return scenario;
}

// Metadata for the console list, without building every scenario.
export function listScenarios() {
  return LIBRARY.map((e) => {
    const s = e.build(makeRng(1));
    return {
      id: s.id, name: s.name, description: s.description,
      difficulty: s.difficulty, tags: s.tags ?? [],
    };
  });
}
