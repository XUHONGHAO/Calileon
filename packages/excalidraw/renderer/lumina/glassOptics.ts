import { intersectRaySegment } from "./rays";
import {
  opticsAngleDelta,
  opticsEdgeNormal,
  normalizeOpticsVector,
  refractRay,
} from "./optics";

import type {
  LuminaEdge,
  LuminaLight,
  LuminaOccluder,
  LuminaScene,
} from "./scene";

export interface GlassRayTrace {
  entry: [number, number];
  exit: [number, number];
  outgoingDirection: [number, number];
  endpoint: [number, number];
  totalInternalReflection: boolean;
}

export interface GlassCausticContribution extends GlassRayTrace {
  glassId: string;
  lightId: string;
  color: string;
  intensity: number;
}

export interface GlassCausticOptions {
  maxGlass?: number;
  maxRaysPerGlass?: number;
  maxContributions?: number;
  maxDistance?: number;
  epsilon?: number;
}

const DEFAULT_MAX_GLASS = 8;
const DEFAULT_MAX_RAYS_PER_GLASS = 12;
const DEFAULT_MAX_CONTRIBUTIONS = 96;
const DEFAULT_MAX_DISTANCE = 1600;
const DEFAULT_EPSILON = 1e-4;

const pointDistance = (
  a: readonly [number, number],
  b: readonly [number, number],
) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export const isClosedGlassEdgeLoop = (
  edges: readonly LuminaEdge[],
  epsilon = 1e-3,
): boolean => {
  if (edges.length < 3) {
    return false;
  }
  return edges.every((edge, edgeIndex) =>
    edge.every((endpoint) =>
      edges.some(
        (candidate, candidateIndex) =>
          candidateIndex !== edgeIndex &&
          (pointDistance(endpoint, candidate[0]) <= epsilon ||
            pointDistance(endpoint, candidate[1]) <= epsilon),
      ),
    ),
  );
};

const nearestIntersection = (
  origin: readonly [number, number],
  direction: readonly [number, number],
  edges: readonly LuminaEdge[],
  epsilon: number,
) => {
  let nearest:
    | {
        edge: LuminaEdge;
        point: [number, number];
        normal: [number, number];
        t: number;
      }
    | undefined;

  for (const edge of edges) {
    const hit = intersectRaySegment(origin, direction, edge[0], edge[1]);
    const normal = opticsEdgeNormal(edge[0], edge[1]);
    if (!hit || !normal || hit.t <= epsilon) {
      continue;
    }
    if (!nearest || hit.t < nearest.t) {
      nearest = { edge, point: hit.point, normal, t: hit.t };
    }
  }
  return nearest ?? null;
};

const traceToBlocker = (
  origin: readonly [number, number],
  direction: readonly [number, number],
  occluders: readonly LuminaOccluder[],
  ignoredId: string,
  maxDistance: number,
  epsilon: number,
): [number, number] => {
  let distance = maxDistance;
  for (const occluder of occluders) {
    if (occluder.id === ignoredId) {
      continue;
    }
    const hit = nearestIntersection(origin, direction, occluder.edges, epsilon);
    if (hit && hit.t < distance) {
      distance = hit.t;
    }
  }
  return [
    origin[0] + direction[0] * distance,
    origin[1] + direction[1] * distance,
  ];
};

export const traceRayThroughGlass = (
  glass: LuminaOccluder,
  origin: readonly [number, number],
  incidentDirection: readonly [number, number],
  sceneOccluders: readonly LuminaOccluder[],
  options: Pick<GlassCausticOptions, "maxDistance" | "epsilon"> = {},
): GlassRayTrace | null => {
  if (glass.material !== "glass" || !isClosedGlassEdgeLoop(glass.edges)) {
    return null;
  }
  const direction = normalizeOpticsVector(incidentDirection);
  if (!direction) {
    return null;
  }
  const epsilon = options.epsilon ?? DEFAULT_EPSILON;
  const maxDistance = options.maxDistance ?? DEFAULT_MAX_DISTANCE;
  const entry = nearestIntersection(origin, direction, glass.edges, epsilon);
  if (!entry) {
    return null;
  }

  const insideDirection = refractRay(direction, entry.normal, 1, glass.ior);
  if (!insideDirection) {
    return {
      entry: entry.point,
      exit: entry.point,
      outgoingDirection: direction,
      endpoint: entry.point,
      totalInternalReflection: true,
    };
  }

  const insideOrigin: [number, number] = [
    entry.point[0] + insideDirection[0] * epsilon * 4,
    entry.point[1] + insideDirection[1] * epsilon * 4,
  ];
  const exit = nearestIntersection(
    insideOrigin,
    insideDirection,
    glass.edges,
    epsilon,
  );
  if (!exit) {
    return null;
  }

  const outgoingDirection = refractRay(
    insideDirection,
    exit.normal,
    glass.ior,
    1,
  );
  if (!outgoingDirection) {
    return {
      entry: entry.point,
      exit: exit.point,
      outgoingDirection: insideDirection,
      endpoint: exit.point,
      totalInternalReflection: true,
    };
  }

  const outgoingOrigin: [number, number] = [
    exit.point[0] + outgoingDirection[0] * epsilon * 4,
    exit.point[1] + outgoingDirection[1] * epsilon * 4,
  ];
  return {
    entry: entry.point,
    exit: exit.point,
    outgoingDirection,
    endpoint: traceToBlocker(
      outgoingOrigin,
      outgoingDirection,
      sceneOccluders,
      glass.id,
      maxDistance,
      epsilon,
    ),
    totalInternalReflection: false,
  };
};

const sampleGlassAimPoints = (
  glass: LuminaOccluder,
  maxRays: number,
): Array<[number, number]> => {
  const points: Array<[number, number]> = [];
  const fractions = [0.2, 0.5, 0.8];
  for (const edge of glass.edges) {
    for (const fraction of fractions) {
      points.push([
        edge[0][0] + (edge[1][0] - edge[0][0]) * fraction,
        edge[0][1] + (edge[1][1] - edge[0][1]) * fraction,
      ]);
      if (points.length >= maxRays) {
        return points;
      }
    }
  }
  return points;
};

const rayForLight = (
  light: LuminaLight,
  aim: readonly [number, number],
  maxDistance: number,
): { origin: [number, number]; direction: [number, number] } | null => {
  if (light.type === "sun") {
    const direction: [number, number] = [
      Math.cos(light.direction ?? 0),
      Math.sin(light.direction ?? 0),
    ];
    return {
      origin: [
        aim[0] - direction[0] * maxDistance,
        aim[1] - direction[1] * maxDistance,
      ],
      direction,
    };
  }

  const direction = normalizeOpticsVector([aim[0] - light.x, aim[1] - light.y]);
  if (!direction) {
    return null;
  }
  if (
    light.type === "spot" &&
    opticsAngleDelta(
      Math.atan2(direction[1], direction[0]),
      light.direction ?? 0,
    ) > (light.angle ?? Math.PI / 4)
  ) {
    return null;
  }
  return { origin: [light.x, light.y], direction };
};

export const buildGlassCausticContributions = (
  scene: LuminaScene,
  options: GlassCausticOptions = {},
): GlassCausticContribution[] => {
  if (!scene.caustics) {
    return [];
  }
  const maxGlass = options.maxGlass ?? DEFAULT_MAX_GLASS;
  const maxRaysPerGlass = options.maxRaysPerGlass ?? DEFAULT_MAX_RAYS_PER_GLASS;
  const maxContributions =
    options.maxContributions ?? DEFAULT_MAX_CONTRIBUTIONS;
  const maxDistance = options.maxDistance ?? DEFAULT_MAX_DISTANCE;
  const epsilon = options.epsilon ?? DEFAULT_EPSILON;
  const glassOccluders = scene.occluders
    .filter(
      (occluder) =>
        occluder.material === "glass" && isClosedGlassEdgeLoop(occluder.edges),
    )
    .slice(0, maxGlass);
  const contributions: GlassCausticContribution[] = [];

  for (const glass of glassOccluders) {
    const aims = sampleGlassAimPoints(glass, maxRaysPerGlass);
    for (const light of scene.lights) {
      for (const aim of aims) {
        const ray = rayForLight(light, aim, maxDistance);
        if (!ray) {
          continue;
        }
        const trace = traceRayThroughGlass(
          glass,
          ray.origin,
          ray.direction,
          scene.occluders,
          { maxDistance, epsilon },
        );
        if (!trace || trace.totalInternalReflection) {
          continue;
        }
        contributions.push({
          ...trace,
          glassId: glass.id,
          lightId: light.id,
          color: light.color,
          intensity:
            Math.max(0, light.intensity) *
            Math.max(0, Math.min(1, glass.opacity / 100)) *
            0.22,
        });
        if (contributions.length >= maxContributions) {
          return contributions;
        }
      }
    }
  }
  return contributions;
};
