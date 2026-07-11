import {
  getElementAbsoluteCoords,
  getElementLineSegments,
  newElementWith,
} from "@excalidraw/element";
import {
  getLuminaGameData,
  getLuminaLightData,
  hasLuminaMaterial,
  isLuminaLightSource,
  normalizeLuminaDarkRoomThreshold,
} from "@excalidraw/element/lumina";

import type {
  LuminaGameData,
  LuminaGameMode,
} from "@excalidraw/element/lumina";

import type {
  ElementsMap,
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import type { Radians } from "@excalidraw/math";

import { buildLuminaScene } from "./scene";
import { createSunLaserSeeds, traceLaser } from "./gameLaser";
import { buildShadowRevealRenderModel } from "./gameShadow";
import {
  buildDarkRoomRenderModel,
  buildDarkRoomSamplePoints,
} from "./gameDarkRoom";
import { getLuminaGameSessionSnapshot } from "./gameSession";
import { getLuminaElementsSignature } from "./signature";

import type { LuminaScene, LuminaEdge } from "./scene";
import type { DarkRoomTreasure } from "./gameDarkRoom";
import type {
  LaserBounds,
  LaserSeed,
  LaserTarget,
  LaserTraceResult,
} from "./gameLaser";

export interface LuminaGameRuntimeState {
  luminaEnabled: boolean;
  luminaAmbient: number;
  luminaCaustics: boolean;
  luminaGameMode: LuminaGameMode | null;
}

export const shouldShowLuminaGameEditorControls = (
  runtime: Pick<LuminaGameRuntimeState, "luminaEnabled" | "luminaGameMode">,
): boolean => {
  return runtime.luminaEnabled && runtime.luminaGameMode?.phase === "edit";
};

export const shouldShowLuminaAuthorControls = (
  runtime: Pick<LuminaGameRuntimeState, "luminaEnabled" | "luminaGameMode">,
): boolean => runtime.luminaEnabled && runtime.luminaGameMode?.phase !== "play";

export interface LuminaLaserTarget extends LaserTarget {
  required: boolean;
  puzzleId?: string;
  label?: string;
}

export interface LuminaShadowTarget {
  id: string;
  edges: LuminaEdge[];
  bounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
  required: boolean;
  tolerance: number;
  puzzleId?: string;
  label?: string;
  ignoreAsOccluder: boolean;
}

export interface LuminaGameState {
  mode: LuminaGameMode;
  scene: LuminaScene;
  seeds: LaserSeed[];
  targets: LuminaLaserTarget[];
  shadowTargets: LuminaShadowTarget[];
  treasures: DarkRoomTreasure[];
  maxBounces: number;
  maxDistance: number;
}

export interface LuminaGameEvaluation {
  active: boolean;
  style: LuminaGameMode["style"] | null;
  phase: LuminaGameMode["phase"] | null;
  solved: boolean;
  hitTargetIds: string[];
  requiredTargetIds: string[];
  matchedShadowTargetIds: string[];
  requiredShadowTargetIds: string[];
  shadowTargetScores: Record<string, number>;
  revealedTreasureIds: string[];
  discoveredTreasureIds: string[];
  requiredTreasureIds: string[];
  treasureScores: Record<string, number>;
  trace: LaserTraceResult | null;
}

export interface LuminaGameResetGeometry {
  x: number;
  y: number;
  angle: Radians;
}

export type LuminaGameResetSnapshot = Record<
  ExcalidrawElement["id"],
  LuminaGameResetGeometry
>;

const DEFAULT_TARGET_RADIUS = 24;
const DEFAULT_MAX_BOUNCES = 8;
const DEFAULT_MAX_DISTANCE = 10000;
const DEFAULT_SUN_RAY_COUNT = 5;

const inactiveEvaluation = (
  mode: LuminaGameMode | null,
): LuminaGameEvaluation => ({
  active: false,
  style: mode?.style ?? null,
  phase: mode?.phase ?? null,
  solved: false,
  hitTargetIds: [],
  requiredTargetIds: [],
  matchedShadowTargetIds: [],
  requiredShadowTargetIds: [],
  shadowTargetScores: {},
  revealedTreasureIds: [],
  discoveredTreasureIds: [],
  requiredTreasureIds: [],
  treasureScores: {},
  trace: null,
});

const finitePositive = (value: unknown): number | null => {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
};

const finiteNonNegative = (value: unknown): number | null => {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
};

const getElementBounds = (
  element: NonDeletedExcalidrawElement,
  elementsMap: ElementsMap,
) => {
  const [x1, y1, x2, y2, cx, cy] = getElementAbsoluteCoords(
    element,
    elementsMap,
  );
  return {
    minX: Math.min(x1, x2),
    minY: Math.min(y1, y2),
    maxX: Math.max(x1, x2),
    maxY: Math.max(y1, y2),
    center: [cx, cy] as [number, number],
  };
};

const getSceneBounds = (
  elements: readonly NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
): LaserBounds => {
  if (elements.length === 0) {
    return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const element of elements) {
    const bounds = getElementBounds(element, elementsMap);
    minX = Math.min(minX, bounds.minX);
    minY = Math.min(minY, bounds.minY);
    maxX = Math.max(maxX, bounds.maxX);
    maxY = Math.max(maxY, bounds.maxY);
  }

  const padding = Math.max(100, Math.hypot(maxX - minX, maxY - minY) * 0.1);
  return {
    minX: minX - padding,
    minY: minY - padding,
    maxX: maxX + padding,
    maxY: maxY + padding,
  };
};

const getTargetRadius = (
  element: NonDeletedExcalidrawElement,
  elementsMap: ElementsMap,
  gameData: LuminaGameData,
): number => {
  const explicit = finiteNonNegative(gameData.tolerance);
  if (explicit != null) {
    return explicit;
  }
  const bounds = getElementBounds(element, elementsMap);
  const diagonal = Math.hypot(
    bounds.maxX - bounds.minX,
    bounds.maxY - bounds.minY,
  );
  return Math.max(DEFAULT_TARGET_RADIUS, diagonal / 4);
};

const buildTarget = (
  element: NonDeletedExcalidrawElement,
  elementsMap: ElementsMap,
  gameData: LuminaGameData,
): LuminaLaserTarget => {
  const bounds = getElementBounds(element, elementsMap);
  const edges = getElementLineSegments(element, elementsMap).map(
    (seg) =>
      [
        [seg[0][0], seg[0][1]],
        [seg[1][0], seg[1][1]],
      ] as LuminaEdge,
  );

  return {
    id: element.id,
    edges,
    center: bounds.center,
    radius: getTargetRadius(element, elementsMap, gameData),
    required: gameData.required !== false,
    puzzleId: gameData.puzzleId,
    label: gameData.label,
  };
};

const buildShadowTarget = (
  element: NonDeletedExcalidrawElement,
  elementsMap: ElementsMap,
  gameData: LuminaGameData,
): LuminaShadowTarget => {
  const bounds = getElementBounds(element, elementsMap);
  const edges = getElementLineSegments(element, elementsMap).map(
    (seg) =>
      [
        [seg[0][0], seg[0][1]],
        [seg[1][0], seg[1][1]],
      ] as LuminaEdge,
  );
  const rawTolerance = finiteNonNegative(gameData.tolerance);
  return {
    id: element.id,
    edges,
    bounds: {
      minX: bounds.minX,
      minY: bounds.minY,
      maxX: bounds.maxX,
      maxY: bounds.maxY,
    },
    required: gameData.required !== false,
    tolerance:
      rawTolerance == null ? 0.15 : Math.max(0, Math.min(1, rawTolerance)),
    puzzleId: gameData.puzzleId,
    label: gameData.label,
    ignoreAsOccluder: !hasLuminaMaterial(element),
  };
};

const buildTreasure = (
  element: NonDeletedExcalidrawElement,
  elementsMap: ElementsMap,
  gameData: LuminaGameData,
): DarkRoomTreasure => {
  const bounds = getElementBounds(element, elementsMap);
  const rawDensity = gameData.meta?.sampleDensity;
  const sampleDensity =
    typeof rawDensity === "number" && Number.isFinite(rawDensity)
      ? Math.max(2, Math.min(7, Math.floor(rawDensity)))
      : 3;
  return {
    id: element.id,
    bounds: {
      minX: bounds.minX,
      minY: bounds.minY,
      maxX: bounds.maxX,
      maxY: bounds.maxY,
    },
    samplePoints: buildDarkRoomSamplePoints(bounds, sampleDensity),
    required: gameData.required !== false,
    threshold: normalizeLuminaDarkRoomThreshold(gameData.tolerance),
    stickyReveal: gameData.meta?.stickyReveal !== false,
    puzzleId: gameData.puzzleId,
    label: gameData.label,
  };
};

const getEmitterElements = (
  elements: readonly NonDeletedExcalidrawElement[],
): NonDeletedExcalidrawElement[] => {
  const explicitEmitters = elements.filter(
    (element) =>
      getLuminaGameData(element)?.role === "emitter" &&
      isLuminaLightSource(element),
  );
  return explicitEmitters.length > 0
    ? explicitEmitters
    : elements.filter((element) => isLuminaLightSource(element));
};

const getEmitterMaxBounces = (
  emitters: readonly NonDeletedExcalidrawElement[],
): number => {
  for (const emitter of emitters) {
    const maxBounces = finitePositive(
      getLuminaGameData(emitter)?.meta?.maxBounces,
    );
    if (maxBounces != null) {
      return Math.max(1, Math.min(32, Math.floor(maxBounces)));
    }
  }
  return DEFAULT_MAX_BOUNCES;
};

const buildLaserSeedsFromElements = (
  emitters: readonly NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
  sceneBounds: LaserBounds,
): LaserSeed[] => {
  const seeds: LaserSeed[] = [];

  for (const emitter of emitters) {
    const lightData = getLuminaLightData(emitter);
    if (!lightData) {
      continue;
    }
    const direction = emitter.angle + Math.PI / 2;
    if (lightData.light === "sun") {
      seeds.push(
        ...createSunLaserSeeds(sceneBounds, direction, DEFAULT_SUN_RAY_COUNT),
      );
      continue;
    }

    const [, , , , cx, cy] = getElementAbsoluteCoords(emitter, elementsMap);
    seeds.push({
      origin: [cx, cy],
      dir: [Math.cos(direction), Math.sin(direction)],
    });
  }

  return seeds;
};

interface LuminaGameStateCacheEntry {
  signature: string;
  state: LuminaGameState;
}

let gameStateCache = new WeakMap<LuminaGameMode, LuminaGameStateCacheEntry>();
let laserTraceCache = new WeakMap<LuminaGameState, LaserTraceResult>();
let shadowRenderModelCache = new WeakMap<
  LuminaGameState,
  ReturnType<typeof buildShadowRevealRenderModel>
>();
let darkRoomRenderModelCache = new WeakMap<
  LuminaGameState,
  ReturnType<typeof buildDarkRoomRenderModel>
>();
let gameStateCacheHits = 0;
let gameStateCacheMisses = 0;

export const getLuminaGameStateCacheStats = () => ({
  hits: gameStateCacheHits,
  misses: gameStateCacheMisses,
});

export const clearLuminaGameStateCache = () => {
  gameStateCache = new WeakMap();
  laserTraceCache = new WeakMap();
  shadowRenderModelCache = new WeakMap();
  darkRoomRenderModelCache = new WeakMap();
  gameStateCacheHits = 0;
  gameStateCacheMisses = 0;
};

export const getLuminaLaserTrace = (
  state: LuminaGameState,
): LaserTraceResult => {
  const cached = laserTraceCache.get(state);
  if (cached) {
    return cached;
  }
  const trace = traceLaser(state.scene, state.seeds, state.targets, {
    maxBounces: state.maxBounces,
    maxDistance: state.maxDistance,
  });
  laserTraceCache.set(state, trace);
  return trace;
};

export const getLuminaShadowRenderModel = (state: LuminaGameState) => {
  const cached = shadowRenderModelCache.get(state);
  if (cached) {
    return cached;
  }
  const model = buildShadowRevealRenderModel(state);
  shadowRenderModelCache.set(state, model);
  return model;
};

export const getLuminaDarkRoomRenderModel = (state: LuminaGameState) => {
  const cached = darkRoomRenderModelCache.get(state);
  if (cached) {
    return cached;
  }
  const model = buildDarkRoomRenderModel(state);
  darkRoomRenderModelCache.set(state, model);
  return model;
};

export const buildLuminaGameState = (
  elements: readonly NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
  runtime: LuminaGameRuntimeState,
): LuminaGameState | null => {
  const mode = runtime.luminaGameMode;
  if (!runtime.luminaEnabled || !mode) {
    return null;
  }

  const signature = `${runtime.luminaAmbient}\u001f${
    runtime.luminaCaustics ? 1 : 0
  }\u001f${getLuminaElementsSignature(elements)}`;
  const cached = gameStateCache.get(mode);
  if (cached?.signature === signature) {
    gameStateCacheHits += 1;
    return cached.state;
  }

  const scene = buildLuminaScene(elements, elementsMap, {
    ambient: runtime.luminaAmbient,
    caustics: runtime.luminaCaustics,
  });
  const targets: LuminaLaserTarget[] = [];
  const shadowTargets: LuminaShadowTarget[] = [];
  const treasures: DarkRoomTreasure[] = [];
  for (const element of elements) {
    const gameData = getLuminaGameData(element);
    if (gameData?.role === "target") {
      targets.push(buildTarget(element, elementsMap, gameData));
    } else if (gameData?.role === "shadowTarget") {
      shadowTargets.push(buildShadowTarget(element, elementsMap, gameData));
    } else if (gameData?.role === "treasure") {
      treasures.push(buildTreasure(element, elementsMap, gameData));
    }
  }

  const emitters = getEmitterElements(elements);
  const sceneBounds = getSceneBounds(elements, elementsMap);

  const state: LuminaGameState = {
    mode,
    scene,
    targets,
    shadowTargets,
    treasures,
    seeds: buildLaserSeedsFromElements(emitters, elementsMap, sceneBounds),
    maxBounces: getEmitterMaxBounces(emitters),
    maxDistance: DEFAULT_MAX_DISTANCE,
  };
  gameStateCacheMisses += 1;
  gameStateCache.set(mode, { signature, state });
  return state;
};

export const evaluateLuminaGame = (
  elements: readonly NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
  runtime: LuminaGameRuntimeState,
): LuminaGameEvaluation => {
  const mode = runtime.luminaGameMode;
  const state = buildLuminaGameState(elements, elementsMap, runtime);
  if (!state) {
    return inactiveEvaluation(mode);
  }

  if (state.mode.style === "shadow-reveal") {
    const shadow = getLuminaShadowRenderModel(state);
    return {
      active: true,
      style: state.mode.style,
      phase: state.mode.phase,
      solved: shadow.solved,
      hitTargetIds: [],
      requiredTargetIds: [],
      matchedShadowTargetIds: shadow.matchedShadowTargetIds,
      requiredShadowTargetIds: shadow.requiredShadowTargetIds,
      shadowTargetScores: shadow.shadowTargetScores,
      revealedTreasureIds: [],
      discoveredTreasureIds: [],
      requiredTreasureIds: [],
      treasureScores: {},
      trace: null,
    };
  }

  if (state.mode.style === "dark-room") {
    const model = getLuminaDarkRoomRenderModel(state);
    const session = getLuminaGameSessionSnapshot(state.mode);
    const discoveredIds = new Set([
      ...session.discoveredIds,
      ...model.revealedTreasureIds,
    ]);
    const solved =
      model.requiredTreasureIds.length > 0 &&
      model.requiredTreasureIds.every((id) => discoveredIds.has(id));
    return {
      active: true,
      style: state.mode.style,
      phase: state.mode.phase,
      solved,
      hitTargetIds: [],
      requiredTargetIds: [],
      matchedShadowTargetIds: [],
      requiredShadowTargetIds: [],
      shadowTargetScores: {},
      revealedTreasureIds: model.revealedTreasureIds,
      discoveredTreasureIds: Array.from(discoveredIds),
      requiredTreasureIds: model.requiredTreasureIds,
      treasureScores: Object.fromEntries(
        model.treasures.map((treasure) => [treasure.id, treasure.score]),
      ),
      trace: null,
    };
  }

  if (state.mode.style !== "laser") {
    return {
      active: true,
      style: state.mode.style,
      phase: state.mode.phase,
      solved: false,
      hitTargetIds: [],
      requiredTargetIds: [],
      matchedShadowTargetIds: [],
      requiredShadowTargetIds: [],
      shadowTargetScores: {},
      revealedTreasureIds: [],
      discoveredTreasureIds: [],
      requiredTreasureIds: [],
      treasureScores: {},
      trace: null,
    };
  }

  const trace = getLuminaLaserTrace(state);
  const hitTargetIds = new Set(trace.hitTargetIds);
  const requiredTargetIds = state.targets
    .filter((target) => target.required)
    .map((target) => target.id);
  const solved =
    requiredTargetIds.length > 0 &&
    requiredTargetIds.every((id) => hitTargetIds.has(id));

  return {
    active: true,
    style: state.mode.style,
    phase: state.mode.phase,
    solved,
    hitTargetIds: Array.from(hitTargetIds),
    requiredTargetIds,
    matchedShadowTargetIds: [],
    requiredShadowTargetIds: [],
    shadowTargetScores: {},
    revealedTreasureIds: [],
    discoveredTreasureIds: [],
    requiredTreasureIds: [],
    treasureScores: {},
    trace,
  };
};

export const isLuminaGameParticipant = (
  element: ExcalidrawElement,
): boolean => {
  return (
    !element.isDeleted &&
    (getLuminaGameData(element) !== null ||
      isLuminaLightSource(element) ||
      hasLuminaMaterial(element))
  );
};

export const captureLuminaGameResetSnapshot = (
  elements: readonly ExcalidrawElement[],
): LuminaGameResetSnapshot => {
  const snapshot: LuminaGameResetSnapshot = {};
  for (const element of elements) {
    if (isLuminaGameParticipant(element)) {
      snapshot[element.id] = {
        x: element.x,
        y: element.y,
        angle: element.angle,
      };
    }
  }
  return snapshot;
};

export const applyLuminaGameResetSnapshot = (
  elements: readonly ExcalidrawElement[],
  snapshot: LuminaGameResetSnapshot,
): ExcalidrawElement[] => {
  return elements.map((element) => {
    const geometry = snapshot[element.id];
    if (!geometry || element.isDeleted) {
      return element;
    }
    if (
      element.x === geometry.x &&
      element.y === geometry.y &&
      element.angle === geometry.angle
    ) {
      return element;
    }
    return newElementWith(element, {
      x: geometry.x,
      y: geometry.y,
      angle: geometry.angle,
    });
  });
};
