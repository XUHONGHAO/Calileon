import { __testing as compositeTesting } from "./composite";

import type { LuminaScene } from "./scene";
import type { LuminaGameState, LuminaShadowTarget } from "./game";

export interface ShadowBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface ShadowMask {
  bounds: ShadowBounds;
  sampleSize: number;
  cells: boolean[];
}

export interface ShadowPuzzleEvaluation {
  matchedShadowTargetIds: string[];
  shadowTargetScores: Record<string, number>;
  requiredShadowTargetIds: string[];
  solved: boolean;
}

export interface ShadowRevealTargetRenderModel {
  id: string;
  bounds: ShadowBounds;
  actual: ShadowMask;
  expected: ShadowMask;
  score: number;
  threshold: number;
  matched: boolean;
  required: boolean;
  puzzleId?: string;
  label?: string;
}

export interface ShadowRevealRenderModel extends ShadowPuzzleEvaluation {
  targets: ShadowRevealTargetRenderModel[];
}

const DEFAULT_SAMPLE_SIZE = 24;
const MEDIUM_SAMPLE_SIZE = 16;
const PRESSURE_SAMPLE_SIZE = 12;

export const resolveShadowSampleSize = (
  state: LuminaGameState,
  requestedSampleSize?: number,
): number => {
  if (requestedSampleSize != null) {
    return Math.max(8, Math.min(32, Math.floor(requestedSampleSize)));
  }
  const edgeCount = state.scene.occluders.reduce(
    (total, occluder) => total + occluder.edges.length,
    0,
  );
  const complexity = edgeCount * Math.max(1, state.shadowTargets.length);
  return complexity >= 256
    ? PRESSURE_SAMPLE_SIZE
    : complexity >= 128
    ? MEDIUM_SAMPLE_SIZE
    : DEFAULT_SAMPLE_SIZE;
};

const pointOnSegment = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean => {
  const cross = (px - ax) * (by - ay) - (py - ay) * (bx - ax);
  if (Math.abs(cross) > 1e-6) {
    return false;
  }
  const dot = (px - ax) * (px - bx) + (py - ay) * (py - by);
  return dot <= 1e-6;
};

const pointInPolygon = (
  point: readonly [number, number],
  polygon: readonly (readonly [number, number])[],
): boolean => {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (pointOnSegment(px, py, xi, yi, xj, yj)) {
      return true;
    }
    const yiAbovePoint = yi > py;
    const yjAbovePoint = yj > py;
    const intersects =
      yiAbovePoint !== yjAbovePoint &&
      px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-12) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
};

const boundsPolygon = (bounds: ShadowBounds): Array<[number, number]> => [
  [bounds.minX, bounds.minY],
  [bounds.maxX, bounds.minY],
  [bounds.maxX, bounds.maxY],
  [bounds.minX, bounds.maxY],
];

const maskFromPolygons = (
  polygons: readonly (readonly (readonly [number, number])[])[],
  bounds: ShadowBounds,
  sampleSize = DEFAULT_SAMPLE_SIZE,
): ShadowMask => {
  const n = Math.max(1, Math.floor(sampleSize));
  const width = bounds.maxX - bounds.minX || 1;
  const height = bounds.maxY - bounds.minY || 1;
  const cells: boolean[] = [];

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = bounds.minX + ((x + 0.5) / n) * width;
      const py = bounds.minY + ((y + 0.5) / n) * height;
      cells.push(polygons.some((polygon) => pointInPolygon([px, py], polygon)));
    }
  }

  return { bounds, sampleSize: n, cells };
};

const collectShadowPolygons = (
  scene: LuminaScene,
  bounds: ShadowBounds,
  ignoredOccluderIds: ReadonlySet<string>,
): Array<Array<[number, number]>> => {
  const projectionLength = Math.max(
    1000,
    Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) * 8,
  );
  const polygons: Array<Array<[number, number]>> = [];

  for (const light of scene.lights) {
    if (!light.castShadows) {
      continue;
    }
    for (const occluder of scene.occluders) {
      if (ignoredOccluderIds.has(occluder.id)) {
        continue;
      }
      for (const edge of occluder.edges) {
        const quad =
          light.type === "sun"
            ? compositeTesting.computeSunShadowQuad(
                light.direction ?? 0,
                edge,
                projectionLength,
              )
            : compositeTesting.computeEdgeShadowQuad(
                light,
                edge,
                projectionLength,
              );
        polygons.push(quad);
      }
    }
  }

  return polygons;
};

const expectedPolygonsForTarget = (
  target: LuminaShadowTarget,
): Array<Array<[number, number]>> => {
  const points = target.edges.flatMap((edge) => [edge[0], edge[1]]);
  if (points.length < 3) {
    return [boundsPolygon(target.bounds)];
  }
  const hull = compositeTesting.convexHull(
    points.map((point) => [point[0], point[1]]),
  );
  return hull.length >= 3 ? [hull] : [boundsPolygon(target.bounds)];
};

export const buildShadowMask = (
  scene: LuminaScene,
  targetBounds: ShadowBounds,
  sampleSize = DEFAULT_SAMPLE_SIZE,
  options: { ignoredOccluderIds?: ReadonlySet<string> } = {},
): ShadowMask => {
  return maskFromPolygons(
    collectShadowPolygons(
      scene,
      targetBounds,
      options.ignoredOccluderIds ?? new Set(),
    ),
    targetBounds,
    sampleSize,
  );
};

export const buildExpectedShadowMask = (
  target: LuminaShadowTarget,
  sampleSize = DEFAULT_SAMPLE_SIZE,
): ShadowMask => {
  return maskFromPolygons(
    expectedPolygonsForTarget(target),
    target.bounds,
    sampleSize,
  );
};

export const compareShadowMask = (
  actual: ShadowMask,
  expected: ShadowMask,
): number => {
  const length = Math.min(actual.cells.length, expected.cells.length);
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < length; i++) {
    const a = actual.cells[i];
    const e = expected.cells[i];
    if (a && e) {
      intersection++;
    }
    if (a || e) {
      union++;
    }
  }
  return union === 0 ? 1 : intersection / union;
};

export const buildShadowRevealRenderModel = (
  state: LuminaGameState,
  requestedSampleSize?: number,
): ShadowRevealRenderModel => {
  const sampleSize = resolveShadowSampleSize(state, requestedSampleSize);
  const matchedShadowTargetIds: string[] = [];
  const shadowTargetScores: Record<string, number> = {};
  const requiredShadowTargetIds = state.shadowTargets
    .filter((target) => target.required)
    .map((target) => target.id);
  const ignoredOccluderIds = new Set(
    state.shadowTargets
      .filter((target) => target.ignoreAsOccluder)
      .map((target) => target.id),
  );
  const targets: ShadowRevealTargetRenderModel[] = [];

  for (const target of state.shadowTargets) {
    const actual = buildShadowMask(state.scene, target.bounds, sampleSize, {
      ignoredOccluderIds,
    });
    const expected = buildExpectedShadowMask(target, sampleSize);
    const score = compareShadowMask(actual, expected);
    const threshold = 1 - target.tolerance;
    const matched = score >= threshold;
    shadowTargetScores[target.id] = score;
    if (matched) {
      matchedShadowTargetIds.push(target.id);
    }
    targets.push({
      id: target.id,
      bounds: target.bounds,
      actual,
      expected,
      score,
      threshold,
      matched,
      required: target.required,
      puzzleId: target.puzzleId,
      label: target.label,
    });
  }

  const matched = new Set(matchedShadowTargetIds);
  return {
    matchedShadowTargetIds,
    shadowTargetScores,
    requiredShadowTargetIds,
    solved:
      requiredShadowTargetIds.length > 0 &&
      requiredShadowTargetIds.every((id) => matched.has(id)),
    targets,
  };
};

export const evaluateShadowPuzzle = (
  state: LuminaGameState,
  sampleSize = DEFAULT_SAMPLE_SIZE,
): ShadowPuzzleEvaluation => {
  const model = buildShadowRevealRenderModel(state, sampleSize);
  return {
    matchedShadowTargetIds: model.matchedShadowTargetIds,
    shadowTargetScores: model.shadowTargetScores,
    requiredShadowTargetIds: model.requiredShadowTargetIds,
    solved: model.solved,
  };
};
