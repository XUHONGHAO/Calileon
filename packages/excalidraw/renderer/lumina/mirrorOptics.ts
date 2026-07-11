import { DEFAULT_LUMINA_SPOT_ANGLE } from "@excalidraw/element/lumina";

import type { LuminaLightType } from "@excalidraw/element/lumina";

import { normalizeOpticsVector, opticsEdgeNormal } from "./optics";
import { intersectRaySegment, reflectRay } from "./rays";

import type {
  LuminaEdge,
  LuminaLight,
  LuminaOccluder,
  LuminaScene,
} from "./scene";

export interface MirrorEdge {
  a: readonly [number, number];
  b: readonly [number, number];
  opacity: number;
  mirrorId?: string;
  sourceEdge?: LuminaEdge;
}

export interface ReflectedLightContribution {
  mirrorId: string;
  lightId: string;
  lightType: LuminaLightType;
  mirrorSegment: LuminaEdge;
  polygon: readonly [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ];
  reflectedDirection: [number, number];
  virtualSource?: [number, number];
  color: string;
  intensity: number;
  radius: number;
}

export interface MirrorOpticsOptions {
  maxMirrorEdges?: number;
  maxContributions?: number;
  maxDistance?: number;
  samplesPerEdge?: number;
  epsilon?: number;
}

const DEFAULT_MAX_MIRROR_EDGES = 64;
const DEFAULT_MAX_CONTRIBUTIONS = 192;
const DEFAULT_MAX_DISTANCE = 1800;
const DEFAULT_SAMPLES_PER_EDGE = 8;
const DEFAULT_EPSILON = 1e-4;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const materialTransmission = (occluder: LuminaOccluder): number => {
  const opacity = clamp01(occluder.opacity / 100);
  switch (occluder.material) {
    case "solid":
    case "mirror":
      return 1 - opacity;
    case "translucent":
      return 1 - opacity * 0.45;
    case "glass":
      return 1 - opacity * 0.15;
    case "emissive":
      return 1;
    default:
      return 1 - opacity;
  }
};

export const reflectAcrossLine = (
  point: readonly [number, number],
  edge: MirrorEdge,
): [number, number] => {
  const dx = edge.b[0] - edge.a[0];
  const dy = edge.b[1] - edge.a[1];
  const lengthSquared = dx * dx + dy * dy || 1;
  const projection =
    ((point[0] - edge.a[0]) * dx + (point[1] - edge.a[1]) * dy) / lengthSquared;
  const footX = edge.a[0] + dx * projection;
  const footY = edge.a[1] + dy * projection;
  return [2 * footX - point[0], 2 * footY - point[1]];
};

export const clipSegmentToCone = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
  apexX: number,
  apexY: number,
  axis: number,
  half: number,
): [number, number, number, number] | null => {
  const safeHalf = Math.max(0.001, Math.min(Math.PI - 0.001, half));
  const leftX = Math.cos(axis - safeHalf);
  const leftY = Math.sin(axis - safeHalf);
  const rightX = Math.cos(axis + safeHalf);
  const rightY = Math.sin(axis + safeHalf);
  const constraints: Array<[number, number]> = [
    [-leftY, leftX],
    [rightY, -rightX],
  ];
  const dx = bx - ax;
  const dy = by - ay;
  let start = 0;
  let end = 1;

  for (const [normalX, normalY] of constraints) {
    const atStart = normalX * (ax - apexX) + normalY * (ay - apexY);
    const delta = normalX * dx + normalY * dy;
    if (Math.abs(delta) < 1e-9) {
      if (atStart < 0) {
        return null;
      }
      continue;
    }
    const crossing = -atStart / delta;
    if (delta > 0) {
      start = Math.max(start, crossing);
    } else {
      end = Math.min(end, crossing);
    }
    if (start > end) {
      return null;
    }
  }

  return [ax + dx * start, ay + dy * start, ax + dx * end, ay + dy * end];
};

export const selectMirrorEdges = (
  edges: readonly MirrorEdge[],
  maxEdges = DEFAULT_MAX_MIRROR_EDGES,
): MirrorEdge[] => {
  if (edges.length <= maxEdges) {
    return edges as MirrorEdge[];
  }
  const lengthSquared = (edge: MirrorEdge) => {
    const dx = edge.b[0] - edge.a[0];
    const dy = edge.b[1] - edge.a[1];
    return dx * dx + dy * dy;
  };
  return [...edges]
    .sort((left, right) => lengthSquared(right) - lengthSquared(left))
    .slice(0, maxEdges);
};

const nearestHitForOccluder = (
  origin: readonly [number, number],
  direction: readonly [number, number],
  occluder: LuminaOccluder,
  epsilon: number,
  ignoredEdge?: LuminaEdge,
): number | null => {
  let nearest = Number.POSITIVE_INFINITY;
  for (const edge of occluder.edges) {
    if (edge === ignoredEdge) {
      continue;
    }
    const hit = intersectRaySegment(origin, direction, edge[0], edge[1]);
    if (hit && hit.t > epsilon && hit.t < nearest) {
      nearest = hit.t;
    }
  }
  return Number.isFinite(nearest) ? nearest : null;
};

const transmissionAlongRay = (
  origin: readonly [number, number],
  direction: readonly [number, number],
  maxDistance: number,
  occluders: readonly LuminaOccluder[],
  mirrorId: string | undefined,
  ignoredEdge: LuminaEdge | undefined,
  epsilon: number,
): number => {
  let transmission = 1;
  for (const occluder of occluders) {
    const hit = nearestHitForOccluder(
      origin,
      direction,
      occluder,
      epsilon,
      ignoredEdge,
    );
    if (hit == null || hit >= maxDistance - epsilon) {
      continue;
    }
    if (occluder.id === mirrorId) {
      return 0;
    }
    transmission *= materialTransmission(occluder);
    if (transmission <= 0.001) {
      return 0;
    }
  }
  return transmission;
};

const traceReflectedRay = (
  origin: readonly [number, number],
  direction: readonly [number, number],
  maxDistance: number,
  occluders: readonly LuminaOccluder[],
  mirrorId: string | undefined,
  ignoredEdge: LuminaEdge | undefined,
  epsilon: number,
): { endpoint: [number, number]; transmission: number } => {
  const hits: Array<{ distance: number; transmission: number }> = [];
  for (const occluder of occluders) {
    const hit = nearestHitForOccluder(
      origin,
      direction,
      occluder,
      epsilon,
      ignoredEdge,
    );
    if (hit != null && hit < maxDistance) {
      hits.push({
        distance: hit,
        transmission:
          occluder.id === mirrorId ? 0 : materialTransmission(occluder),
      });
    }
  }
  hits.sort((left, right) => left.distance - right.distance);

  let distance = maxDistance;
  let transmission = 1;
  for (const hit of hits) {
    if (hit.transmission <= 0.001) {
      distance = hit.distance;
      break;
    }
    transmission *= hit.transmission;
  }

  return {
    endpoint: [
      origin[0] + direction[0] * distance,
      origin[1] + direction[1] * distance,
    ],
    transmission,
  };
};

const interpolate = (edge: MirrorEdge, fraction: number): [number, number] => [
  edge.a[0] + (edge.b[0] - edge.a[0]) * fraction,
  edge.a[1] + (edge.b[1] - edge.a[1]) * fraction,
];

interface MirrorSample {
  point: [number, number];
  incidentDirection: [number, number];
  incomingTransmission: number;
  reflectedDirection: [number, number];
  endpoint: [number, number];
  outgoingTransmission: number;
}

const buildSample = (
  light: LuminaLight,
  edge: MirrorEdge,
  point: [number, number],
  normal: [number, number],
  occluders: readonly LuminaOccluder[],
  maxDistance: number,
  epsilon: number,
): MirrorSample | null => {
  let incidentOrigin: [number, number];
  let incidentDirection: [number, number];
  let incidentDistance: number;

  if (light.type === "sun") {
    incidentDirection = [
      Math.cos(light.direction ?? 0),
      Math.sin(light.direction ?? 0),
    ];
    incidentOrigin = [
      point[0] - incidentDirection[0] * maxDistance,
      point[1] - incidentDirection[1] * maxDistance,
    ];
    incidentDistance = maxDistance;
  } else {
    const direction = normalizeOpticsVector([
      point[0] - light.x,
      point[1] - light.y,
    ]);
    if (!direction) {
      return null;
    }
    incidentOrigin = [light.x, light.y];
    incidentDirection = direction;
    incidentDistance = Math.hypot(point[0] - light.x, point[1] - light.y);
    if (incidentDistance > light.radius) {
      return null;
    }
  }

  const incomingTransmission = transmissionAlongRay(
    incidentOrigin,
    incidentDirection,
    incidentDistance,
    occluders,
    edge.mirrorId,
    edge.sourceEdge,
    epsilon,
  );
  if (incomingTransmission <= 0.001) {
    return null;
  }

  const reflectedDirection = reflectRay(incidentDirection, normal);
  const reflectedOrigin: [number, number] = [
    point[0] + reflectedDirection[0] * epsilon * 4,
    point[1] + reflectedDirection[1] * epsilon * 4,
  ];
  const outgoing = traceReflectedRay(
    reflectedOrigin,
    reflectedDirection,
    maxDistance,
    occluders,
    edge.mirrorId,
    edge.sourceEdge,
    epsilon,
  );

  return {
    point,
    incidentDirection,
    incomingTransmission,
    reflectedDirection,
    endpoint: outgoing.endpoint,
    outgoingTransmission: outgoing.transmission,
  };
};

const illuminatedEdgeForLight = (
  light: LuminaLight,
  edge: MirrorEdge,
): MirrorEdge | null => {
  if (light.intensity <= 0) {
    return null;
  }
  if (light.type !== "spot") {
    return edge;
  }
  const clipped = clipSegmentToCone(
    edge.a[0],
    edge.a[1],
    edge.b[0],
    edge.b[1],
    light.x,
    light.y,
    light.direction ?? 0,
    light.angle ?? DEFAULT_LUMINA_SPOT_ANGLE,
  );
  return clipped
    ? { ...edge, a: [clipped[0], clipped[1]], b: [clipped[2], clipped[3]] }
    : null;
};

export const buildReflectedLightContributions = (
  scene: LuminaScene,
  options: MirrorOpticsOptions = {},
): ReflectedLightContribution[] => {
  const maxMirrorEdges = options.maxMirrorEdges ?? DEFAULT_MAX_MIRROR_EDGES;
  const maxContributions =
    options.maxContributions ?? DEFAULT_MAX_CONTRIBUTIONS;
  const maxDistance = options.maxDistance ?? DEFAULT_MAX_DISTANCE;
  const samplesPerEdge = Math.max(
    1,
    Math.floor(options.samplesPerEdge ?? DEFAULT_SAMPLES_PER_EDGE),
  );
  const epsilon = options.epsilon ?? DEFAULT_EPSILON;
  const rawEdges: MirrorEdge[] = [];

  for (const occluder of scene.occluders) {
    if (occluder.material !== "mirror") {
      continue;
    }
    for (const edge of occluder.edges) {
      rawEdges.push({
        a: edge[0],
        b: edge[1],
        opacity: clamp01(occluder.opacity / 100),
        mirrorId: occluder.id,
        sourceEdge: edge,
      });
    }
  }

  const mirrorEdges = selectMirrorEdges(rawEdges, maxMirrorEdges);
  const contributions: ReflectedLightContribution[] = [];

  for (const light of scene.lights) {
    for (const rawEdge of mirrorEdges) {
      const edge = illuminatedEdgeForLight(light, rawEdge);
      if (!edge) {
        continue;
      }
      const normal = opticsEdgeNormal(edge.a, edge.b);
      if (!normal) {
        continue;
      }
      const samples = Array.from({ length: samplesPerEdge + 1 }, (_, index) =>
        buildSample(
          light,
          edge,
          interpolate(edge, index / samplesPerEdge),
          normal,
          scene.occluders,
          maxDistance,
          epsilon,
        ),
      );
      const virtualSource =
        light.type === "sun"
          ? undefined
          : reflectAcrossLine([light.x, light.y], edge);

      for (let index = 0; index < samplesPerEdge; index++) {
        const start = samples[index];
        const end = samples[index + 1];
        if (!start || !end) {
          continue;
        }
        const direction = normalizeOpticsVector([
          start.reflectedDirection[0] + end.reflectedDirection[0],
          start.reflectedDirection[1] + end.reflectedDirection[1],
        ]);
        if (!direction) {
          continue;
        }
        const transmission =
          ((start.incomingTransmission * start.outgoingTransmission +
            end.incomingTransmission * end.outgoingTransmission) /
            2) *
          edge.opacity;
        const intensity = Math.max(0, light.intensity) * 0.9 * transmission;
        if (!Number.isFinite(intensity) || intensity <= 0.001) {
          continue;
        }
        contributions.push({
          mirrorId: edge.mirrorId ?? "",
          lightId: light.id,
          lightType: light.type,
          mirrorSegment: [start.point, end.point],
          polygon: [start.point, end.point, end.endpoint, start.endpoint],
          reflectedDirection: direction,
          virtualSource,
          color: light.color,
          intensity,
          radius: Math.max(1, light.radius),
        });
        if (contributions.length >= maxContributions) {
          return contributions;
        }
      }
    }
  }

  return contributions;
};
