// Actor archetypes: the silhouettes that appear on the arena and the scoring
// zones inside them.
//
// Local space runs from y = -1 at the top of the head to y = 0 at the feet,
// centred on x = 0. An actor's track places its feet, so a figure that walks
// or grows stays planted instead of sliding off its own base.
//
// Zones are listed high value first and tested in that order, so a shot inside
// the head also inside the torso box scores as a head shot.

import { rect } from './geometry.js';

// A rough human silhouette. Deliberately blocky: it is a scoring boundary, and
// an operator tuning a drill needs to be able to see where the edges are.
const HUMANOID = [
  { x: -0.065, y: -1.00 }, { x: 0.065, y: -1.00 },
  { x: 0.075, y: -0.90 }, { x: 0.055, y: -0.845 },
  { x: 0.180, y: -0.795 }, { x: 0.205, y: -0.520 },
  { x: 0.150, y: -0.500 }, { x: 0.160, y: -0.300 },
  { x: 0.140, y: 0.0 }, { x: 0.035, y: 0.0 },
  { x: 0.030, y: -0.290 }, { x: -0.030, y: -0.290 },
  { x: -0.035, y: 0.0 }, { x: -0.140, y: 0.0 },
  { x: -0.160, y: -0.300 }, { x: -0.150, y: -0.500 },
  { x: -0.205, y: -0.520 }, { x: -0.180, y: -0.795 },
  { x: -0.055, y: -0.845 }, { x: -0.075, y: -0.90 },
];

// Only the head and one shoulder clear the hostage in front. This is the whole
// difficulty of a hostage drill, so the shape is defined explicitly rather than
// derived by clipping, which would silently change if the hostage moved.
const PEEKING_HEAD = [
  { x: -0.075, y: -1.00 }, { x: 0.075, y: -1.00 },
  { x: 0.085, y: -0.885 }, { x: 0.175, y: -0.830 },
  { x: 0.185, y: -0.700 }, { x: -0.060, y: -0.700 },
  { x: -0.070, y: -0.860 },
];

const CIRCLE = (() => {
  const pts = [];
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * 0.5, y: -0.5 + Math.sin(a) * 0.5 });
  }
  return pts;
})();

export const ARCHETYPES = {
  // Armed hostile. The default thing to shoot.
  threat: {
    role: 'threat',
    outline: HUMANOID,
    baseScore: 3,
    zones: [
      { id: 'head', poly: rect(-0.075, -1.0, 0.15, 0.155), score: 10 },
      { id: 'centre', poly: rect(-0.145, -0.80, 0.29, 0.30), score: 7 },
    ],
  },

  // Hostile with only the head clear of a hostage. Body shots simply miss.
  threat_peek: {
    role: 'threat',
    outline: PEEKING_HEAD,
    baseScore: 4,
    zones: [{ id: 'head', poly: rect(-0.075, -1.0, 0.15, 0.155), score: 10 }],
  },

  // A person who must not be shot. Any hit anywhere is a penalty.
  hostage: {
    role: 'noshoot',
    outline: HUMANOID,
    baseScore: 0,
    penalty: -25,
    zones: [],
  },

  // Bystander. Same rule as a hostage, smaller penalty.
  civilian: {
    role: 'noshoot',
    outline: HUMANOID,
    baseScore: 0,
    penalty: -15,
    zones: [],
  },

  // Steel plate for speed drills. One value, no zones to think about.
  plate: {
    role: 'threat',
    outline: CIRCLE,
    baseScore: 5,
    zones: [],
  },

  // An invisible hit box tracking a hostile in video footage.
  video_region: {
    role: 'threat',
    outline: rect(-0.5, -1.0, 1.0, 1.0),
    baseScore: 5,
    zones: [],
  },

  // The same, for someone in the footage who must not be shot. This is a
  // separate archetype rather than a flag on the actor because role decides
  // whether a hit scores or ends the run, and that must not depend on a field
  // the engine might not read.
  video_noshoot: {
    role: 'noshoot',
    outline: rect(-0.5, -1.0, 1.0, 1.0),
    baseScore: 0,
    penalty: -25,
    zones: [],
  },
};

export function isKnownArchetype(name) {
  return Object.prototype.hasOwnProperty.call(ARCHETYPES, name);
}

export function archetype(name) {
  return ARCHETYPES[name] ?? ARCHETYPES.threat;
}

// Resolve a shot against one placed actor. Returns {zone, score} for the
// highest-value zone containing the point, or null if the shot missed.
// `polys` holds the actor's outline and zones already transformed to arena
// space, so the caller can transform once per frame instead of once per test.
export function resolveHit(spec, polys, px, py, pointInPolygon) {
  for (let i = 0; i < polys.zones.length; i++) {
    if (pointInPolygon(px, py, polys.zones[i])) {
      return { zone: spec.zones[i].id, score: spec.zones[i].score };
    }
  }
  if (pointInPolygon(px, py, polys.outline)) {
    return {
      zone: spec.role === 'noshoot' ? 'body' : 'peripheral',
      score: spec.role === 'noshoot' ? (spec.penalty ?? -15) : spec.baseScore,
    };
  }
  return null;
}
