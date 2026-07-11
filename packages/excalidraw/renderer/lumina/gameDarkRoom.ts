import { normalizeLuminaDarkRoomThreshold } from "@excalidraw/element/lumina";

import { buildReflectedLightContributions } from "./mirrorOptics";
import { opticsAngleDelta, normalizeOpticsVector } from "./optics";
import { intersectRaySegment } from "./rays";

import type { ReflectedLightContribution } from "./mirrorOptics";
import type { LuminaLight, LuminaOccluder, LuminaScene } from "./scene";

export interface DarkRoomBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface DarkRoomTreasure {
  id: string;
  bounds: DarkRoomBounds;
  samplePoints: Array<[number, number]>;
  required: boolean;
  threshold: number;
  stickyReveal: boolean;
  puzzleId?: string;
  label?: string;
}

export interface DarkRoomTreasureRenderModel extends DarkRoomTreasure {
  score: number;
  revealed: boolean;
}

export interface DarkRoomShadowPolygon {
  points: readonly [
    [number, number],
    [number, number],
    [number, number],
    [number, number],
  ];
  strength: number;
}

export interface DarkRoomRenderModel {
  treasures: DarkRoomTreasureRenderModel[];
  requiredTreasureIds: string[];
  revealedTreasureIds: string[];
  stickyRevealedTreasureIds: string[];
  lights: LuminaLight[];
  reflections: ReflectedLightContribution[];
  shadowPolygons: DarkRoomShadowPolygon[];
}

const MAX_LIGHT_DISTANCE = 10000;

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

const shadowStrength = (occluder: LuminaOccluder): number =>
  1 - materialTransmission(occluder);

export const buildDarkRoomSamplePoints = (
  bounds: DarkRoomBounds,
  density = 3,
): Array<[number, number]> => {
  const safeDensity = Math.max(2, Math.min(7, Math.floor(density)));
  const points: Array<[number, number]> = [];
  for (let row = 0; row < safeDensity; row++) {
    for (let column = 0; column < safeDensity; column++) {
      const xRatio = safeDensity === 1 ? 0.5 : column / (safeDensity - 1);
      const yRatio = safeDensity === 1 ? 0.5 : row / (safeDensity - 1);
      points.push([
        bounds.minX + (bounds.maxX - bounds.minX) * xRatio,
        bounds.minY + (bounds.maxY - bounds.minY) * yRatio,
      ]);
    }
  }
  return points;
};

const nearestOccluderHit = (
  origin: readonly [number, number],
  direction: readonly [number, number],
  occluder: LuminaOccluder,
): number | null => {
  let nearest = Number.POSITIVE_INFINITY;
  for (const edge of occluder.edges) {
    const hit = intersectRaySegment(origin, direction, edge[0], edge[1]);
    if (hit && hit.t > 1e-4 && hit.t < nearest) {
      nearest = hit.t;
    }
  }
  return Number.isFinite(nearest) ? nearest : null;
};

const transmissionToPoint = (
  light: LuminaLight,
  point: readonly [number, number],
  occluders: readonly LuminaOccluder[],
  ignoredId: string,
): number => {
  let origin: [number, number];
  let direction: [number, number];
  let distance: number;

  if (light.type === "sun") {
    direction = [
      Math.cos(light.direction ?? 0),
      Math.sin(light.direction ?? 0),
    ];
    distance = MAX_LIGHT_DISTANCE;
    origin = [
      point[0] - direction[0] * distance,
      point[1] - direction[1] * distance,
    ];
  } else {
    const normalized = normalizeOpticsVector([
      point[0] - light.x,
      point[1] - light.y,
    ]);
    if (!normalized) {
      return 1;
    }
    direction = normalized;
    distance = Math.hypot(point[0] - light.x, point[1] - light.y);
    origin = [light.x, light.y];
  }

  let transmission = 1;
  for (const occluder of occluders) {
    if (occluder.id === ignoredId) {
      continue;
    }
    const hit = nearestOccluderHit(origin, direction, occluder);
    if (hit == null || hit >= distance - 1e-4) {
      continue;
    }
    transmission *= materialTransmission(occluder);
    if (transmission <= 0.001) {
      return 0;
    }
  }
  return transmission;
};

const directLightAtPoint = (
  light: LuminaLight,
  point: readonly [number, number],
  occluders: readonly LuminaOccluder[],
  treasureId: string,
): number => {
  let falloff = 1;
  if (light.type !== "sun") {
    const dx = point[0] - light.x;
    const dy = point[1] - light.y;
    const distance = Math.hypot(dx, dy);
    if (distance > light.radius) {
      return 0;
    }
    if (
      light.type === "spot" &&
      opticsAngleDelta(Math.atan2(dy, dx), light.direction ?? 0) >
        (light.angle ?? Math.PI / 4)
    ) {
      return 0;
    }
    falloff = 1 - distance / Math.max(1, light.radius);
  }

  const transmission = light.castShadows
    ? transmissionToPoint(light, point, occluders, treasureId)
    : 1;
  return clamp01(Math.max(0, light.intensity) * falloff * transmission);
};

export const pointInDarkRoomPolygon = (
  point: readonly [number, number],
  polygon: readonly (readonly [number, number])[],
): boolean => {
  let inside = false;
  for (
    let index = 0, previous = polygon.length - 1;
    index < polygon.length;
    previous = index++
  ) {
    const currentPoint = polygon[index];
    const previousPoint = polygon[previous];
    const currentAbove = currentPoint[1] > point[1];
    const previousAbove = previousPoint[1] > point[1];
    const intersects =
      currentAbove !== previousAbove &&
      point[0] <
        ((previousPoint[0] - currentPoint[0]) * (point[1] - currentPoint[1])) /
          (previousPoint[1] - currentPoint[1] || 1e-9) +
          currentPoint[0];
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
};

const reflectedLightAtPoint = (
  contribution: ReflectedLightContribution,
  point: readonly [number, number],
): number => {
  if (!pointInDarkRoomPolygon(point, contribution.polygon)) {
    return 0;
  }
  if (contribution.lightType === "sun" || !contribution.virtualSource) {
    return clamp01(contribution.intensity);
  }
  const distance = Math.hypot(
    point[0] - contribution.virtualSource[0],
    point[1] - contribution.virtualSource[1],
  );
  return clamp01(
    contribution.intensity *
      Math.max(0, 1 - distance / Math.max(1, contribution.radius)),
  );
};

export const evaluateDarkRoomTreasure = (
  treasure: DarkRoomTreasure,
  scene: LuminaScene,
  reflections: readonly ReflectedLightContribution[],
): DarkRoomTreasureRenderModel => {
  const sampleScores = treasure.samplePoints.map((point) => {
    const direct = scene.lights.reduce(
      (score, light) =>
        score + directLightAtPoint(light, point, scene.occluders, treasure.id),
      0,
    );
    const reflected = reflections.reduce(
      (score, contribution) =>
        score + reflectedLightAtPoint(contribution, point),
      0,
    );
    return clamp01(direct + reflected);
  });
  const score =
    sampleScores.reduce((sum, value) => sum + value, 0) /
    Math.max(1, sampleScores.length);
  const threshold = normalizeLuminaDarkRoomThreshold(treasure.threshold);
  return {
    ...treasure,
    threshold,
    score,
    revealed: score >= threshold,
  };
};

const edgeShadowPolygon = (
  light: LuminaLight,
  edge: LuminaOccluder["edges"][number],
): DarkRoomShadowPolygon["points"] => {
  const project = (point: readonly [number, number]): [number, number] => {
    if (light.type === "sun") {
      return [
        point[0] + Math.cos(light.direction ?? 0) * MAX_LIGHT_DISTANCE,
        point[1] + Math.sin(light.direction ?? 0) * MAX_LIGHT_DISTANCE,
      ];
    }
    const direction = normalizeOpticsVector([
      point[0] - light.x,
      point[1] - light.y,
    ]) ?? [1, 0];
    return [
      point[0] + direction[0] * MAX_LIGHT_DISTANCE,
      point[1] + direction[1] * MAX_LIGHT_DISTANCE,
    ];
  };
  return [edge[0], edge[1], project(edge[1]), project(edge[0])];
};

export const buildDarkRoomRenderModel = (state: {
  scene: LuminaScene;
  treasures: readonly DarkRoomTreasure[];
}): DarkRoomRenderModel => {
  const treasureIds = new Set(state.treasures.map((treasure) => treasure.id));
  const evaluationScene: LuminaScene = {
    ...state.scene,
    occluders: state.scene.occluders.filter(
      (occluder) => !treasureIds.has(occluder.id),
    ),
  };
  const reflections = buildReflectedLightContributions(evaluationScene);
  const treasures = state.treasures.map((treasure) =>
    evaluateDarkRoomTreasure(treasure, evaluationScene, reflections),
  );
  const shadowPolygons: DarkRoomShadowPolygon[] = [];
  for (const light of evaluationScene.lights) {
    if (!light.castShadows) {
      continue;
    }
    for (const occluder of evaluationScene.occluders) {
      const strength = shadowStrength(occluder);
      if (strength <= 0) {
        continue;
      }
      for (const edge of occluder.edges) {
        shadowPolygons.push({
          points: edgeShadowPolygon(light, edge),
          strength,
        });
      }
    }
  }

  return {
    treasures,
    requiredTreasureIds: treasures
      .filter((treasure) => treasure.required)
      .map((treasure) => treasure.id),
    revealedTreasureIds: treasures
      .filter((treasure) => treasure.revealed)
      .map((treasure) => treasure.id),
    stickyRevealedTreasureIds: treasures
      .filter((treasure) => treasure.revealed && treasure.stickyReveal)
      .map((treasure) => treasure.id),
    lights: evaluationScene.lights,
    reflections,
    shadowPolygons,
  };
};
