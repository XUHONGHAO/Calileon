import type { LuminaMaterial } from "@excalidraw/element/lumina";

import { intersectRaySegment, reflectRay } from "./rays";

import type { LuminaEdge, LuminaScene } from "./scene";

export interface LaserSeed {
  origin: [number, number];
  dir: [number, number];
}

export interface LaserSegment {
  from: [number, number];
  to: [number, number];
}

export interface LaserTarget {
  id: string;
  edges: LuminaEdge[];
  center: [number, number];
  radius: number;
}

export interface LaserTraceResult {
  paths: LaserSegment[][];
  hitTargetIds: string[];
  bouncesUsed: number[];
}

export interface LaserBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface BuildLaserSeedsOptions {
  bounds?: LaserBounds;
  sunRayCount?: number;
  pointDirections?: Readonly<Record<string, number>>;
}

const DEFAULT_MAX_BOUNCES = 8;
const DEFAULT_MAX_DISTANCE = 10000;
const DEFAULT_EPSILON = 1e-6;
const DEFAULT_SUN_RAY_COUNT = 5;

const normalize = (
  point: readonly [number, number],
): [number, number] | null => {
  const len = Math.hypot(point[0], point[1]);
  if (len <= 1e-12) {
    return null;
  }
  return [point[0] / len, point[1] / len];
};

const clonePoint = (point: readonly [number, number]): [number, number] => [
  point[0],
  point[1],
];

const pointAt = (
  origin: readonly [number, number],
  dir: readonly [number, number],
  distance: number,
): [number, number] => [
  origin[0] + dir[0] * distance,
  origin[1] + dir[1] * distance,
];

const intersectRayCircle = (
  origin: readonly [number, number],
  dir: readonly [number, number],
  center: readonly [number, number],
  radius: number,
): { t: number; point: [number, number] } | null => {
  if (radius <= 0) {
    return null;
  }

  const ox = origin[0] - center[0];
  const oy = origin[1] - center[1];
  const b = 2 * (ox * dir[0] + oy * dir[1]);
  const c = ox * ox + oy * oy - radius * radius;
  const disc = b * b - 4 * c;
  if (disc < 0) {
    return null;
  }

  const sqrtDisc = Math.sqrt(disc);
  const t1 = (-b - sqrtDisc) / 2;
  const t2 = (-b + sqrtDisc) / 2;
  const t = t1 >= 0 ? t1 : t2 >= 0 ? t2 : null;
  if (t === null) {
    return null;
  }
  return { t, point: pointAt(origin, dir, t) };
};

type NearestHit =
  | {
      kind: "target";
      id: string;
      t: number;
      point: [number, number];
    }
  | {
      kind: "occluder";
      id: string;
      material: LuminaMaterial;
      t: number;
      point: [number, number];
      normal: [number, number];
    };

const shouldReplaceHit = (
  candidate: NearestHit,
  current: NearestHit | null,
  epsilon: number,
): boolean => {
  if (!current) {
    return true;
  }
  if (candidate.t < current.t - epsilon) {
    return true;
  }
  return (
    candidate.kind === "target" &&
    current.kind !== "target" &&
    candidate.t <= current.t + epsilon
  );
};

const findNearestHit = (
  scene: LuminaScene,
  targets: readonly LaserTarget[],
  origin: readonly [number, number],
  dir: readonly [number, number],
  epsilon: number,
): NearestHit | null => {
  let nearest: NearestHit | null = null;

  for (const target of targets) {
    const circleHit = intersectRayCircle(
      origin,
      dir,
      target.center,
      target.radius,
    );
    if (circleHit && circleHit.t > epsilon) {
      const hit: NearestHit = {
        kind: "target",
        id: target.id,
        t: circleHit.t,
        point: circleHit.point,
      };
      if (shouldReplaceHit(hit, nearest, epsilon)) {
        nearest = hit;
      }
    }

    for (const edge of target.edges) {
      const edgeHit = intersectRaySegment(origin, dir, edge[0], edge[1]);
      if (!edgeHit || edgeHit.t <= epsilon) {
        continue;
      }
      const hit: NearestHit = {
        kind: "target",
        id: target.id,
        t: edgeHit.t,
        point: edgeHit.point,
      };
      if (shouldReplaceHit(hit, nearest, epsilon)) {
        nearest = hit;
      }
    }
  }

  for (const occluder of scene.occluders) {
    for (const edge of occluder.edges) {
      const edgeHit = intersectRaySegment(origin, dir, edge[0], edge[1]);
      if (!edgeHit || edgeHit.t <= epsilon) {
        continue;
      }
      const hit: NearestHit = {
        kind: "occluder",
        id: occluder.id,
        material: occluder.material,
        t: edgeHit.t,
        point: edgeHit.point,
        normal: edgeHit.normal,
      };
      if (shouldReplaceHit(hit, nearest, epsilon)) {
        nearest = hit;
      }
    }
  }

  return nearest;
};

export const traceLaser = (
  scene: LuminaScene,
  seeds: readonly LaserSeed[],
  targets: readonly LaserTarget[],
  options: {
    maxBounces?: number;
    maxDistance?: number;
    epsilon?: number;
  } = {},
): LaserTraceResult => {
  const maxBounces = Math.max(
    0,
    Math.floor(options.maxBounces ?? DEFAULT_MAX_BOUNCES),
  );
  const maxDistance = Math.max(0, options.maxDistance ?? DEFAULT_MAX_DISTANCE);
  const epsilon = Math.max(1e-12, options.epsilon ?? DEFAULT_EPSILON);

  const paths: LaserSegment[][] = [];
  const hitTargetIds = new Set<string>();
  const bouncesUsed: number[] = [];

  for (const seed of seeds) {
    const initialDir = normalize(seed.dir);
    const path: LaserSegment[] = [];
    let bounces = 0;

    if (!initialDir || maxDistance <= 0) {
      paths.push(path);
      bouncesUsed.push(bounces);
      continue;
    }

    let origin = clonePoint(seed.origin);
    let dir = initialDir;
    let traveled = 0;

    while (traveled < maxDistance) {
      const remaining = maxDistance - traveled;
      const hit = findNearestHit(scene, targets, origin, dir, epsilon);

      if (!hit || hit.t > remaining) {
        path.push({
          from: clonePoint(origin),
          to: pointAt(origin, dir, remaining),
        });
        break;
      }

      path.push({ from: clonePoint(origin), to: clonePoint(hit.point) });
      traveled += hit.t;

      if (hit.kind === "target") {
        hitTargetIds.add(hit.id);
        break;
      }

      if (hit.material !== "mirror" || bounces >= maxBounces) {
        break;
      }

      const reflected = reflectRay(dir, hit.normal);
      const normalizedReflected = normalize(reflected);
      if (!normalizedReflected) {
        break;
      }

      dir = normalizedReflected;
      origin = pointAt(hit.point, dir, epsilon);
      traveled += epsilon;
      bounces++;
    }

    paths.push(path);
    bouncesUsed.push(bounces);
  }

  return {
    paths,
    hitTargetIds: Array.from(hitTargetIds),
    bouncesUsed,
  };
};

export const createSunLaserSeeds = (
  bounds: LaserBounds,
  direction: number,
  count = DEFAULT_SUN_RAY_COUNT,
): LaserSeed[] => {
  const rayCount = Math.max(1, Math.floor(count));
  const dir: [number, number] = [Math.cos(direction), Math.sin(direction)];
  const perp: [number, number] = [-dir[1], dir[0]];
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const diagonal = Math.max(1, Math.hypot(width, height));
  const backCenter: [number, number] = [
    cx - dir[0] * diagonal,
    cy - dir[1] * diagonal,
  ];

  return Array.from({ length: rayCount }, (_, index) => {
    const ratio = rayCount === 1 ? 0.5 : index / (rayCount - 1);
    const offset = (ratio - 0.5) * diagonal;
    return {
      origin: [
        backCenter[0] + perp[0] * offset,
        backCenter[1] + perp[1] * offset,
      ],
      dir,
    };
  });
};

export const createLightLaserSeeds = (
  scene: LuminaScene,
  options: BuildLaserSeedsOptions = {},
): LaserSeed[] => {
  const seeds: LaserSeed[] = [];

  for (const light of scene.lights) {
    if (light.type === "sun") {
      if (!options.bounds || light.direction == null) {
        continue;
      }
      seeds.push(
        ...createSunLaserSeeds(
          options.bounds,
          light.direction,
          options.sunRayCount,
        ),
      );
      continue;
    }

    const direction =
      light.type === "spot"
        ? light.direction
        : options.pointDirections?.[light.id];
    if (direction == null) {
      continue;
    }

    seeds.push({
      origin: [light.x, light.y],
      dir: [Math.cos(direction), Math.sin(direction)],
    });
  }

  return seeds;
};
