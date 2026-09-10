// Perspective mapping between camera pixels and arena coordinates.
//
// The camera sees the projected arena as an arbitrary quadrilateral: it is
// off to one side, tilted, and usually not square to the screen. A homography
// is the 3x3 transform that undoes all of that at once, so a laser dot found
// at some camera pixel can be expressed as a point on the arena.

// Solve A x = b by Gaussian elimination with partial pivoting.
// A is n x n (array of rows), b is length n. Returns null if singular.
export function solveLinear(A, b) {
  const n = b.length;
  // Work on copies so callers keep their inputs.
  const m = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    }
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];

    const p = m[col][col];
    for (let c = col; c <= n; c++) m[col][c] /= p;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row) => row[n]);
}

// Build the homography taking each src point to the matching dst point.
// Both arrays hold exactly four {x, y} in corresponding order.
// Returns a length-9 array in row-major order, or null if the points are
// degenerate (three collinear, duplicated corners, a collapsed quad).
export function homographyFromQuads(src, dst) {
  if (src.length !== 4 || dst.length !== 4) return null;

  // Each correspondence contributes two rows to an 8x8 system; h22 is fixed
  // at 1 since the homography is only defined up to scale.
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }

  const h = solveLinear(A, b);
  if (!h || h.some((v) => !Number.isFinite(v))) return null;
  return [...h, 1];
}

// Map one point through a homography. Returns null behind the camera plane,
// where the projective denominator collapses and the result is meaningless.
export function applyHomography(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  if (Math.abs(w) < 1e-12) return null;
  return {
    x: (h[0] * x + h[1] * y + h[2]) / w,
    y: (h[3] * x + h[4] * y + h[5]) / w,
  };
}

// Invert a 3x3 so a mapping can be run in the opposite direction.
export function invertHomography(h) {
  const [a, b, c, d, e, f, g, i, j] = h;
  const det = a * (e * j - f * i) - b * (d * j - f * g) + c * (d * i - e * g);
  if (Math.abs(det) < 1e-12) return null;
  return [
    (e * j - f * i) / det, (c * i - b * j) / det, (b * f - c * e) / det,
    (f * g - d * j) / det, (a * j - c * g) / det, (c * d - a * f) / det,
    (d * i - e * g) / det, (b * g - a * i) / det, (a * e - b * d) / det,
  ];
}

// Sort four unordered corners into top-left, top-right, bottom-right,
// bottom-left. Sorting by angle around the centroid keeps the quad convex,
// then the corner nearest the origin is rotated into first place.
export function orderCorners(points) {
  if (points.length !== 4) return null;
  const cx = points.reduce((s, p) => s + p.x, 0) / 4;
  const cy = points.reduce((s, p) => s + p.y, 0) / 4;

  const byAngle = [...points].sort(
    (p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx),
  );

  let start = 0;
  let best = Infinity;
  for (let i = 0; i < 4; i++) {
    const d = byAngle[i].x + byAngle[i].y;
    if (d < best) { best = d; start = i; }
  }
  return [0, 1, 2, 3].map((i) => byAngle[(start + i) % 4]);
}
