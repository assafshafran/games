// Finding the projected arena in the camera image.
//
// The arena window flashes black, then white. Differencing the two camera
// frames leaves exactly the area the projector lights: everything else in the
// room is unchanged and cancels. That is far more robust than thresholding a
// single bright frame, which also catches lamps, windows and pale walls.
//
// From that difference mask, the four corners of the lit quad are the points
// furthest out along each diagonal. This assumes the lit area is convex, which
// a projected rectangle always is, however oblique the camera angle.

import { orderCorners } from './homography.js';

export const DEFAULT_DIFF_THRESHOLD = 45;

// Peak-channel difference between the lit and unlit frames.
export function differenceMask(litRgba, darkRgba, width, height, threshold = DEFAULT_DIFF_THRESHOLD) {
  const n = width * height;
  const mask = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const o = i << 2;
    const a = Math.max(litRgba[o], litRgba[o + 1], litRgba[o + 2]);
    const b = Math.max(darkRgba[o], darkRgba[o + 1], darkRgba[o + 2]);
    if (a - b >= threshold) { mask[i] = 1; count++; }
  }
  return { mask, count };
}

// Largest 4-connected region in the mask, returned as its pixel indices.
// 4-connectivity is deliberate here: it will not bridge two bright areas that
// merely touch at a corner, which would drag a corner estimate off the screen.
export function largestRegion(mask, width, height) {
  const seen = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let best = null;

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    const pixels = [];

    while (head < tail) {
      const i = queue[head++];
      pixels.push(i);
      const x = i % width;
      const y = (i / width) | 0;

      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; queue[tail++] = i - 1; }
      if (x < width - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; queue[tail++] = i + 1; }
      if (y > 0 && mask[i - width] && !seen[i - width]) { seen[i - width] = 1; queue[tail++] = i - width; }
      if (y < height - 1 && mask[i + width] && !seen[i + width]) { seen[i + width] = 1; queue[tail++] = i + width; }
    }
    if (!best || pixels.length > best.length) best = pixels;
  }
  return best;
}

// Corners of a convex region: extremes along both diagonals.
export function extremeCorners(pixels, width) {
  let tl = null, tr = null, br = null, bl = null;
  let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;

  for (const i of pixels) {
    const x = i % width;
    const y = (i / width) | 0;
    const sum = x + y;
    const diff = x - y;
    if (sum < minSum) { minSum = sum; tl = { x, y }; }
    if (sum > maxSum) { maxSum = sum; br = { x, y }; }
    if (diff > maxDiff) { maxDiff = diff; tr = { x, y }; }
    if (diff < minDiff) { minDiff = diff; bl = { x, y }; }
  }
  return [tl, tr, br, bl];
}

// Full pass. Returns {corners, coverage, pixels} or {error} if the projection
// could not be located, so the console can say why rather than fail silently.
export function findProjectedQuad(litRgba, darkRgba, width, height, opts = {}) {
  const threshold = opts.threshold ?? DEFAULT_DIFF_THRESHOLD;
  const minCoverage = opts.minCoverage ?? 0.02;

  const { mask, count } = differenceMask(litRgba, darkRgba, width, height, threshold);
  const total = width * height;
  if (count / total < minCoverage) {
    return { error: 'The projected image is too dim or too small in the camera view. Aim the camera at the screen, turn the room lights down, and try again.' };
  }

  const region = largestRegion(mask, width, height);
  if (!region || region.length / total < minCoverage) {
    return { error: 'Found bright pixels but no single large lit area. Check that the camera sees the whole projected image.' };
  }

  const corners = extremeCorners(region, width);
  if (corners.some((c) => !c)) return { error: 'Could not locate four corners.' };

  const ordered = orderCorners(corners);
  if (!ordered) return { error: 'Could not order the corners.' };

  // A quad far smaller than the region that produced it means the lit area is
  // not really a quadrilateral, usually a reflection merged into the screen.
  const area = quadArea(ordered);
  if (area <= 0 || region.length / area < 0.55) {
    return { error: 'The lit area is not a clean rectangle. Look for a reflection or a second bright surface in the camera view.' };
  }

  return { corners: ordered, coverage: region.length / total, pixels: region.length };
}

export function quadArea(q) {
  let a = 0;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    a += q[j].x * q[i].y - q[i].x * q[j].y;
  }
  return Math.abs(a / 2);
}
