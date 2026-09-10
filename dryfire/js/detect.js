// Laser shot detection from a camera frame.
//
// A laser hit is a very small, very bright dot that was not there a moment
// ago. Projected arena content is also bright, so brightness alone cannot
// separate the two. Three tests together do:
//
//   1. high peak channel - the dot saturates at least one colour channel
//   2. a rise since the last frame - it appeared, rather than being lit all along
//   3. a small compact blob - projected content changes over large regions,
//      a laser dot covers a handful of pixels
//
// Test 3 carries most of the discrimination, so the size ceiling matters more
// than the brightness floor when tuning a real setup.
//
// Brightness here is the peak channel, max(r, g, b), not perceptual luma.
// Luma weights red at roughly 0.3, so a saturated red laser dot scores about
// 119 out of 255 and would sit under any threshold high enough to ignore a
// projected white background. Peak channel scores it 255, and treats red and
// green lasers alike.

export const DEFAULT_PARAMS = {
  minValue: 215,  // 0-255 peak-channel floor for a candidate pixel
  minRise: 40,    // peak channel must exceed the previous frame by this much
  minPixels: 2,   // reject single-pixel sensor noise
  maxPixels: 900, // reject projector content and room light changes
  maxAspect: 3.5, // a dot is roughly round; reject streaks and bars
  dedupeMs: 110,  // one trigger pull can light several frames
  dedupePx: 45,   // ...and the dot can wander slightly between them
};

export class ShotDetector {
  constructor(width, height, params = {}) {
    this.params = { ...DEFAULT_PARAMS, ...params };
    this._alloc(width, height);
    this.lastShot = null;
    // Retained for the tuning view, so an operator can see what the detector
    // considered without re-running the pass.
    this.lastStats = { candidates: 0, clusters: 0, rejected: 0 };
  }

  _alloc(width, height) {
    this.width = width;
    this.height = height;
    const n = width * height;
    this.prevValue = new Uint8ClampedArray(n);
    this.curValue = new Uint8ClampedArray(n);
    this.mask = new Uint8Array(n);
    this.labels = new Int32Array(n);
    this.hasPrev = false;
  }

  resize(width, height) {
    if (width === this.width && height === this.height) return;
    this._alloc(width, height);
  }

  reset() {
    this.hasPrev = false;
    this.lastShot = null;
  }

  // Analyse one RGBA frame. Returns the best shot as
  // {x, y, pixels, intensity, color} in camera pixels, or null.
  detect(rgba, now = performance.now()) {
    const { width: w, height: h, params: p, mask, prevValue, curValue } = this;
    const n = w * h;
    let candidates = 0;

    for (let i = 0; i < n; i++) {
      const o = i << 2;
      const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
      const value = r > g ? (r > b ? r : b) : (g > b ? g : b);

      // The first frame has nothing to compare against, so it only seeds the
      // background. Without this a bright scene would fire on startup.
      const hit = this.hasPrev && value >= p.minValue && value - prevValue[i] >= p.minRise ? 1 : 0;
      if (hit) candidates++;

      mask[i] = hit;
      curValue[i] = value;
      prevValue[i] = value;
    }

    this.hasPrev = true;
    this.lastStats = { candidates, clusters: 0, rejected: 0 };
    if (candidates < p.minPixels) return null;

    const clusters = this._cluster();
    this.lastStats.clusters = clusters.length;

    // Rank surviving clusters by total brightness: the laser is the brightest
    // compact thing in the frame.
    let best = null;
    for (const c of clusters) {
      const bw = c.maxX - c.minX + 1;
      const bh = c.maxY - c.minY + 1;
      const aspect = Math.max(bw / bh, bh / bw);
      if (c.pixels < p.minPixels || c.pixels > p.maxPixels || aspect > p.maxAspect) {
        this.lastStats.rejected++;
        continue;
      }
      if (!best || c.sum > best.sum) best = c;
    }
    if (!best) return null;

    const shot = {
      x: best.sumX / best.pixels,
      y: best.sumY / best.pixels,
      pixels: best.pixels,
      intensity: best.sum / best.pixels,
      color: classifyColor(rgba, best, w),
    };

    if (this._isDuplicate(shot, now)) return null;
    this.lastShot = { x: shot.x, y: shot.y, t: now };
    return shot;
  }

  _isDuplicate(shot, now) {
    const last = this.lastShot;
    if (!last || now - last.t > this.params.dedupeMs) return false;
    return Math.hypot(shot.x - last.x, shot.y - last.y) <= this.params.dedupePx;
  }

  // Connected components over the candidate mask, 8-connected so a dot split
  // by a diagonal of dim pixels still reads as one blob.
  _cluster() {
    const { width: w, height: h, mask, labels, curValue } = this;
    labels.fill(0);
    const out = [];
    const stack = [];

    for (let start = 0; start < w * h; start++) {
      if (!mask[start] || labels[start]) continue;
      const id = out.length + 1;
      const c = { pixels: 0, sum: 0, sumX: 0, sumY: 0, minX: w, maxX: 0, minY: h, maxY: 0 };

      stack.push(start);
      labels[start] = id;
      while (stack.length) {
        const i = stack.pop();
        const x = i % w;
        const y = (i / w) | 0;

        c.pixels++;
        c.sum += curValue[i];
        c.sumX += x;
        c.sumY += y;
        if (x < c.minX) c.minX = x;
        if (x > c.maxX) c.maxX = x;
        if (y < c.minY) c.minY = y;
        if (y > c.maxY) c.maxY = y;

        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            const ni = ny * w + nx;
            if (mask[ni] && !labels[ni]) {
              labels[ni] = id;
              stack.push(ni);
            }
          }
        }
      }
      out.push(c);
    }
    return out;
  }
}

// A laser dot often blows out to white at its core, so the usable colour
// signal sits in the surrounding halo. Averaging the bounding box picks it up.
function classifyColor(rgba, cluster, w) {
  let r = 0, g = 0, b = 0, count = 0;
  for (let y = cluster.minY; y <= cluster.maxY; y++) {
    for (let x = cluster.minX; x <= cluster.maxX; x++) {
      const o = (y * w + x) << 2;
      r += rgba[o];
      g += rgba[o + 1];
      b += rgba[o + 2];
      count++;
    }
  }
  if (!count) return 'unknown';
  r /= count; g /= count; b /= count;
  if (r > g + 12 && r > b + 12) return 'red';
  if (g > r + 12 && g > b + 12) return 'green';
  return 'unknown';
}
