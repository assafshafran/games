// Stopping the system from shooting itself.
//
// The arena draws a marker where each shot landed. That marker is projected
// onto the same surface the camera is watching, and it is small, bright, and
// appears suddenly, which is the exact signature the detector looks for. So a
// single real shot is detected, drawn, seen, detected again slightly offset,
// drawn again, and the run fills with a wandering trail of phantom hits.
//
// Making the marker look less like a laser helps but cannot be relied on: how
// large and bright it lands in the camera depends on the projector, the room,
// and the camera's own gain. The reliable fix is that the console already
// knows every point it asked the arena to draw, so it can ignore detections
// that come back from those points while the marker is still on screen.
//
// The cost is that a genuine second shot into the same small area within the
// marker's lifetime is dropped. That is the right trade: a missing hit on a
// fast double-tap is a worse score, while a feedback loop makes the whole run
// meaningless.

// The radius the arena's hit marker grows to, as a fraction of arena width.
// It lives here, rather than in the renderer that draws it, so the suppression
// radius below can be checked against it: if the marker ever grew past the
// suppressed area, the feedback loop would reopen silently.
export const MARKER_MAX_RADIUS = 1 / 90;

export const DEFAULT_SUPPRESSION = {
  // Fraction of arena width. Comfortably larger than MARKER_MAX_RADIUS, since
  // a phantom detection lands on the marker's leading edge, not its centre.
  radius: 0.05,
  // Should match how long a marker stays visible.
  ms: 1000,
};

export class ShotSuppressor {
  constructor({ radius, ms, aspect = 16 / 9 } = {}) {
    this.radius = radius ?? DEFAULT_SUPPRESSION.radius;
    this.ms = ms ?? DEFAULT_SUPPRESSION.ms;
    this.aspect = aspect;
    this.zones = [];
  }

  // Record a point the arena is about to draw a marker at.
  mark(x, y, now) {
    this.prune(now);
    this.zones.push({ x, y, until: now + this.ms });
  }

  // Arena coordinates run 0..1 on both axes over a rectangle that is not
  // square, so a circle on the projector is not a circle in these units.
  // Distances are measured in fractions of arena width to keep the suppressed
  // area round on screen rather than stretched.
  distance(ax, ay, bx, by) {
    return Math.hypot(ax - bx, (ay - by) / this.aspect);
  }

  blocked(x, y, now) {
    this.prune(now);
    return this.zones.some((z) => this.distance(x, y, z.x, z.y) <= this.radius);
  }

  prune(now) {
    if (this.zones.length) this.zones = this.zones.filter((z) => z.until > now);
  }

  clear() {
    this.zones = [];
  }
}
