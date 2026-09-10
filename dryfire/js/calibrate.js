// Finding the projected arena in the camera image.
//
// The arena window flashes black, then white. Differencing the two camera
// frames leaves the area the projector lights: everything else in the room is
// unchanged and cancels. That is far more robust than thresholding a single
// bright frame, which also catches lamps, windows and pale walls.
//
// From that difference, the four corners of the lit quad are the points
// furthest out along each diagonal. This assumes the lit area is convex, which
// a projected rectangle always is, however oblique the camera angle.
//
// Two things make this harder in a real room than it sounds:
//
//   Auto-exposure. A webcam shown a white screen stops down within about a
//   second, and shown black it opens up, which erases most of the difference
//   the method depends on. So the caller flashes several times at different
//   settle delays and accumulates the per-pixel maximum: a short delay beats
//   auto-exposure, a longer one accommodates a slow projector, and taking the
//   max over all of them needs only one of the attempts to have worked.
//
//   Projector brightness. A fixed threshold that suits a bright projector in a
//   dark room rejects a dim one entirely, so the threshold is chosen from the
//   difference itself.

import { orderCorners } from './homography.js';

// Floor for the adaptive threshold. Below this, sensor noise and the camera's
// own gain drift start forming regions of their own.
export const MIN_THRESHOLD = 14;

// Per-pixel peak-channel difference between the lit and unlit frames.
export function peakDifference(litRgba, darkRgba, width, height) {
  const n = width * height;
  const diff = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) {
    const o = i << 2;
    const a = Math.max(litRgba[o], litRgba[o + 1], litRgba[o + 2]);
    const b = Math.max(darkRgba[o], darkRgba[o + 1], darkRgba[o + 2]);
    diff[i] = a > b ? a - b : 0;
  }
  return diff;
}

// Keep the larger of two difference maps at every pixel. Used to combine
// several flash cycles, so one good cycle carries the result.
export function accumulateMax(into, next) {
  for (let i = 0; i < into.length; i++) if (next[i] > into[i]) into[i] = next[i];
  return into;
}

export function meanPeak(rgba, width, height) {
  const n = width * height;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const o = i << 2;
    sum += Math.max(rgba[o], rgba[o + 1], rgba[o + 2]);
  }
  return sum / n;
}

// Otsu's method: pick the threshold that best splits the difference histogram
// into two groups. The projected area and the rest of the room are exactly
// that kind of two-group split, and choosing from the data means a dim
// projector works without anyone touching a slider.
export function otsuThreshold(diff) {
  const hist = new Float64Array(256);
  for (let i = 0; i < diff.length; i++) hist[diff[i]]++;

  const total = diff.length;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];

  let sumB = 0;
  let weightB = 0;
  let best = 0;
  let bestVariance = -1;

  for (let v = 0; v < 256; v++) {
    weightB += hist[v];
    if (weightB === 0) continue;
    const weightF = total - weightB;
    if (weightF === 0) break;

    sumB += v * hist[v];
    const meanB = sumB / weightB;
    const meanF = (sum - sumB) / weightF;
    const variance = weightB * weightF * (meanB - meanF) * (meanB - meanF);
    if (variance > bestVariance) { bestVariance = variance; best = v; }
  }
  // Otsu picks the last level belonging to the background, so the first
  // foreground level is one above it. Callers compare with >=, so return that.
  return best + 1;
}

// Largest 4-connected region in a thresholded map, returned as pixel indices.
// 4-connectivity is deliberate: it will not bridge two bright areas that merely
// touch at a corner, which would drag a corner estimate off the screen.
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

// Corners of a convex region: the extremes along both diagonals.
export function extremeCorners(pixels, width) {
  let tl = null, tr = null, br = null, bl = null;
  let minSum = Infinity, maxSum = -Infinity, minDiff = Infinity, maxDiff = -Infinity;

  for (const i of pixels) {
    const x = i % width;
    const y = (i / width) | 0;
    const sum = x + y;
    const d = x - y;
    if (sum < minSum) { minSum = sum; tl = { x, y }; }
    if (sum > maxSum) { maxSum = sum; br = { x, y }; }
    if (d > maxDiff) { maxDiff = d; tr = { x, y }; }
    if (d < minDiff) { minDiff = d; bl = { x, y }; }
  }
  return [tl, tr, br, bl];
}

export function quadArea(q) {
  let a = 0;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    a += q[j].x * q[i].y - q[i].x * q[j].y;
  }
  return Math.abs(a / 2);
}

// Locate the projection in an accumulated difference map.
//
// Always returns a `diagnostics` object, on success and on failure alike, so
// the console can show the operator what the camera actually saw instead of
// only telling them it did not work.
export function quadFromDifference(diff, width, height, opts = {}) {
  const total = width * height;
  const minCoverage = opts.minCoverage ?? 0.015;

  let peak = 0;
  let sum = 0;
  for (let i = 0; i < diff.length; i++) {
    sum += diff[i];
    if (diff[i] > peak) peak = diff[i];
  }
  const meanDiff = sum / total;

  const threshold = Math.max(MIN_THRESHOLD, opts.threshold ?? otsuThreshold(diff));
  const diagnostics = { threshold, peakDiff: peak, meanDiff, coverage: 0, regionFraction: 0, coherence: 0, fill: 0 };

  // Nothing changed at all between the two frames. The bar is deliberately
  // low: a dim projector against a lit wall can leave only twenty-odd levels,
  // and that is still perfectly usable. Anything above this is judged below,
  // where the shape of the change is known.
  if (peak < MIN_THRESHOLD) {
    return {
      diagnostics,
      error: 'The camera did not see the arena flash at all. The two frames are identical. '
           + 'Check that the arena window is on the projector and that the camera above is the one looking at the wall.',
    };
  }

  const mask = new Uint8Array(total);
  let count = 0;
  for (let i = 0; i < total; i++) {
    if (diff[i] >= threshold) { mask[i] = 1; count++; }
  }
  diagnostics.coverage = count / total;

  const region = largestRegion(mask, width, height);
  diagnostics.regionFraction = region ? region.length / total : 0;

  // How much of the change is one connected area. This is what separates a
  // real projection from sensor noise: a projector lights one big rectangle,
  // while noise scatters isolated pixels across the whole frame. Both can
  // produce the same total coverage, so coverage alone cannot tell them apart
  // and cannot give the operator the right advice.
  diagnostics.coherence = count ? (region ? region.length / count : 0) : 0;

  if (!region || diagnostics.regionFraction < minCoverage) {
    if (diagnostics.coherence < 0.35) {
      return {
        diagnostics,
        error: 'The camera did not see the arena flash. What changed between the two frames is scattered noise, not a screen. '
             + 'Check that the camera is pointed at the projected image, that the arena window is really on the projector '
             + 'and not the laptop screen, and that the camera picked above is the one looking at the wall.',
      };
    }
    return {
      diagnostics,
      error: `The projection is only ${(diagnostics.regionFraction * 100).toFixed(1)}% of the camera view, which is too small to calibrate against. `
           + 'Move the camera closer to the screen, or zoom out the projector so its image is bigger in frame.',
    };
  }

  const corners = extremeCorners(region, width);
  if (corners.some((c) => !c)) return { diagnostics, error: 'Could not locate four corners.' };

  const ordered = orderCorners(corners);
  if (!ordered) return { diagnostics, error: 'Could not order the corners.' };

  const area = quadArea(ordered);
  diagnostics.fill = area > 0 ? region.length / area : 0;

  // How close the region is to being the quadrilateral fitted to it.
  //
  // The four extreme points of a convex region lie inside it, so the fitted
  // quad never has more area than the region and this ratio is at least 1 for
  // anything convex. A true projected rectangle puts the extremes exactly on
  // its corners, giving almost exactly 1. A rounded blob gives much more: a
  // circle scores about 1.57, because the quad is a square inscribed in it.
  // Below 1 means the region has holes or concavities the quad spans.
  //
  // So the test is two-sided. An earlier version only had the lower bound,
  // which accepted any blob that happened to be connected.
  if (area <= 0 || diagnostics.fill < 0.78 || diagnostics.fill > 1.28) {
    const shape = diagnostics.fill > 1.28
      ? 'rounded rather than rectangular'
      : 'ragged rather than rectangular';
    return {
      diagnostics,
      corners: ordered,
      error: `The area that lit up is ${shape}, so it is not the projected image. `
           + 'Look for a mirror, a window or a glossy surface bouncing the projector back at the camera, '
           + 'check that nothing is blocking part of the screen, or set the corners by hand.',
    };
  }

  return { corners: ordered, diagnostics, mask };
}

// Convenience wrapper for a single black/white pair.
export function findProjectedQuad(litRgba, darkRgba, width, height, opts = {}) {
  const diff = peakDifference(litRgba, darkRgba, width, height);
  const res = quadFromDifference(diff, width, height, opts);
  return { ...res, diff };
}
