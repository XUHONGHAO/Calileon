const EPSILON = 1e-9;

export type LuminaPoint = readonly [number, number];

const cross = (ax: number, ay: number, bx: number, by: number): number =>
  ax * by - ay * bx;

const normalize = (v: LuminaPoint): [number, number] | null => {
  const len = Math.hypot(v[0], v[1]);
  if (len <= EPSILON) {
    return null;
  }
  return [v[0] / len, v[1] / len];
};

/**
 * Intersects a ray and a finite segment.
 *
 * `t` is measured in scene units from `origin` because `dir` is normalized before
 * solving. Parallel lines, zero-length segments, and hits behind the ray return
 * null. Endpoint touches count as hits.
 */
export const intersectRaySegment = (
  origin: LuminaPoint,
  dir: LuminaPoint,
  a: LuminaPoint,
  b: LuminaPoint,
): { t: number; point: [number, number]; normal: [number, number] } | null => {
  const d = normalize(dir);
  if (!d) {
    return null;
  }

  const sx = b[0] - a[0];
  const sy = b[1] - a[1];
  const segLen = Math.hypot(sx, sy);
  if (segLen <= EPSILON) {
    return null;
  }

  const denom = cross(d[0], d[1], sx, sy);
  if (Math.abs(denom) <= EPSILON) {
    return null;
  }

  const qpx = a[0] - origin[0];
  const qpy = a[1] - origin[1];
  const t = cross(qpx, qpy, sx, sy) / denom;
  const u = cross(qpx, qpy, d[0], d[1]) / denom;

  if (t < -EPSILON || u < -EPSILON || u > 1 + EPSILON) {
    return null;
  }

  const clampedT = Math.max(0, t);
  return {
    t: clampedT,
    point: [origin[0] + d[0] * clampedT, origin[1] + d[1] * clampedT],
    normal: [-sy / segLen, sx / segLen],
  };
};

/**
 * Reflects a ray direction around a line normal: r = d - 2(d.n)n.
 */
export const reflectRay = (
  dir: LuminaPoint,
  normal: LuminaPoint,
): [number, number] => {
  const d = normalize(dir);
  if (!d) {
    return [0, 0];
  }
  const n = normalize(normal);
  if (!n) {
    return d;
  }
  const dot = d[0] * n[0] + d[1] * n[1];
  const reflected: [number, number] = [
    d[0] - 2 * dot * n[0],
    d[1] - 2 * dot * n[1],
  ];
  return normalize(reflected) ?? reflected;
};
