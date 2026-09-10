// Shapes and motion shared by both kinds of scenario.
//
// Vector actors and video actors are hit-tested by exactly the same code. An
// actor owns a polygon in its own local space plus a track of keyframes; the
// track places that polygon on the arena at a given moment. For a vector actor
// the polygon is also what gets drawn. For a video actor it is invisible and
// simply follows whatever the footage shows, which is what makes a branching
// video scenario work without the engine understanding video at all.
//
// All arena coordinates are normalised to 0..1 on both axes, so a scenario
// authored on one projector runs unchanged on another.

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// Sample a keyframe track at time t (ms into the stage).
//
// Keyframes are {t, x, y, scale?, rotation?, visible?} sorted by t. Values are
// interpolated linearly between neighbours and held flat outside the range.
// `visible` is deliberately not interpolated: a target is either there or it
// is not, and a half-present target cannot be fairly scored.
export function sampleTrack(keys, t) {
  if (!keys || keys.length === 0) {
    return { x: 0.5, y: 0.5, scale: 1, rotation: 0, visible: true };
  }
  const withDefaults = (k) => ({
    x: k.x, y: k.y,
    scale: k.scale ?? 1,
    rotation: k.rotation ?? 0,
    visible: k.visible !== false,
  });

  if (t <= keys[0].t) return withDefaults(keys[0]);
  if (t >= keys[keys.length - 1].t) return withDefaults(keys[keys.length - 1]);

  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].t <= t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const span = b.t - a.t;
  const f = span <= 0 ? 0 : clamp((t - a.t) / span, 0, 1);

  return {
    x: lerp(a.x, b.x, f),
    y: lerp(a.y, b.y, f),
    scale: lerp(a.scale ?? 1, b.scale ?? 1, f),
    rotation: lerp(a.rotation ?? 0, b.rotation ?? 0, f),
    // Hold the outgoing keyframe's state until the next one is actually
    // reached, so a target vanishes at its keyframe rather than fading out
    // of scoring somewhere in between.
    visible: a.visible !== false,
  };
}

// Place a local-space polygon on the arena using a sampled track state.
// Local coordinates are in units where 1 is the actor's nominal full height,
// centred on x = 0 with y = 0 at the actor's feet.
export function transformPolygon(local, state, aspect = 16 / 9) {
  const cos = Math.cos(state.rotation);
  const sin = Math.sin(state.rotation);
  const out = new Array(local.length);

  for (let i = 0; i < local.length; i++) {
    const p = local[i];
    const lx = p.x * state.scale;
    const ly = p.y * state.scale;
    const rx = lx * cos - ly * sin;
    const ry = lx * sin + ly * cos;
    // Divide x by the aspect ratio so an actor stays square on a widescreen
    // arena instead of being stretched horizontally by the 0..1 mapping.
    out[i] = { x: state.x + rx / aspect, y: state.y + ry };
  }
  return out;
}

// Crossing-number point-in-polygon test. Points exactly on an edge are not
// guaranteed either way, which is acceptable: the scoring zones below always
// have a lower-scoring region behind them to catch a boundary miss.
export function pointInPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function polygonBounds(poly) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

// Build a rectangle in local actor space, used for video hit boxes where a
// full polygon is more precision than the footage justifies.
export function rect(x, y, w, h) {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}
