export type OpticsVector = readonly [number, number];

const EPSILON = 1e-9;

export const normalizeOpticsVector = (
  vector: OpticsVector,
): [number, number] | null => {
  const length = Math.hypot(vector[0], vector[1]);
  if (!Number.isFinite(length) || length <= EPSILON) {
    return null;
  }
  return [vector[0] / length, vector[1] / length];
};

export const opticsDot = (a: OpticsVector, b: OpticsVector): number =>
  a[0] * b[0] + a[1] * b[1];

export const opticsEdgeNormal = (
  a: OpticsVector,
  b: OpticsVector,
): [number, number] | null => {
  return normalizeOpticsVector([-(b[1] - a[1]), b[0] - a[0]]);
};

/**
 * Snell refraction for normalized 2D vectors. The supplied normal may point to
 * either side; it is flipped to oppose the incident direction.
 *
 * Returns null for total internal reflection or invalid input.
 */
export const refractRay = (
  incident: OpticsVector,
  surfaceNormal: OpticsVector,
  n1: number,
  n2: number,
): [number, number] | null => {
  const direction = normalizeOpticsVector(incident);
  const normalizedNormal = normalizeOpticsVector(surfaceNormal);
  if (
    !direction ||
    !normalizedNormal ||
    !Number.isFinite(n1) ||
    !Number.isFinite(n2) ||
    n1 <= 0 ||
    n2 <= 0
  ) {
    return null;
  }

  let normal = normalizedNormal;
  if (opticsDot(direction, normal) > 0) {
    normal = [-normal[0], -normal[1]];
  }

  const cosIncident = -opticsDot(direction, normal);
  const eta = n1 / n2;
  const discriminant =
    1 - eta * eta * Math.max(0, 1 - cosIncident * cosIncident);
  if (discriminant < 0) {
    return null;
  }

  return normalizeOpticsVector([
    eta * direction[0] +
      (eta * cosIncident - Math.sqrt(discriminant)) * normal[0],
    eta * direction[1] +
      (eta * cosIncident - Math.sqrt(discriminant)) * normal[1],
  ]);
};

export const opticsAngleDelta = (a: number, b: number): number => {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
};
