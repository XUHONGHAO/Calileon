import { arrayToMap } from "@excalidraw/common";

import { pointFrom } from "@excalidraw/math";

import { validateFractionalIndices } from "@excalidraw/element";

import { getLuminaGameData } from "@excalidraw/element/lumina";

import type { NonDeletedExcalidrawElement } from "@excalidraw/element/types";

import type { LocalPoint, Radians } from "@excalidraw/math";

import {
  buildLuminaScene,
  clearLuminaSceneCache,
  getLuminaSceneCacheStats,
} from "../renderer/lumina/scene";
import {
  __testing,
  clearLuminaLayerPool,
  compositeLighting,
  getLuminaLayerPoolSize,
} from "../renderer/lumina/composite";
import {
  createLightLaserSeeds,
  traceLaser,
} from "../renderer/lumina/gameLaser";
import {
  applyLuminaGameResetSnapshot,
  buildLuminaGameState,
  captureLuminaGameResetSnapshot,
  clearLuminaGameStateCache,
  evaluateLuminaGame,
  getLuminaDarkRoomRenderModel,
  getLuminaGameStateCacheStats,
  getLuminaLaserTrace,
  getLuminaShadowRenderModel,
  shouldShowLuminaAuthorControls,
  shouldShowLuminaGameEditorControls,
} from "../renderer/lumina/game";
import {
  __gameRenderTesting,
  renderLuminaDarkRoomOverlay,
  renderLuminaLaserOverlay,
  renderLuminaShadowOverlay,
} from "../renderer/lumina/gameRender";
import {
  buildShadowRevealRenderModel,
  resolveShadowSampleSize,
} from "../renderer/lumina/gameShadow";
import {
  buildDarkRoomRenderModel,
  buildDarkRoomSamplePoints,
  evaluateDarkRoomTreasure,
} from "../renderer/lumina/gameDarkRoom";
import {
  clearLuminaGameSession,
  getLuminaGameSessionSnapshot,
  updateDarkRoomSession,
} from "../renderer/lumina/gameSession";
import {
  buildGlassCausticContributions,
  isClosedGlassEdgeLoop,
  traceRayThroughGlass,
} from "../renderer/lumina/glassOptics";
import { buildReflectedLightContributions } from "../renderer/lumina/mirrorOptics";
import { refractRay } from "../renderer/lumina/optics";
import {
  getLuminaPerformanceSnapshot,
  recordLuminaPerformanceSample,
  resetLuminaPerformanceSamples,
} from "../renderer/lumina/performance";
import { createLuminaRafScheduler } from "../renderer/lumina/raf";
import { intersectRaySegment, reflectRay } from "../renderer/lumina/rays";
import {
  actionAddLightSource,
  actionAddSun,
  actionChangeLuminaGameConstraint,
  actionChangeLuminaGameRole,
  actionToggleLuminaCaustics,
} from "../actions/actionLumina";
import {
  LUMINA_MATERIAL_CODE,
  packOccluders,
} from "../renderer/lumina/gl/packOccluders";

import { restoreElements } from "../data/restore";

import { getDefaultAppState } from "../appState";
import { languages } from "../i18n";
import enLocale from "../locales/en.json";
import zhCNLocale from "../locales/zh-CN.json";
import zhTWLocale from "../locales/zh-TW.json";

import { API } from "./helpers/api";

import type {
  LuminaEdge,
  LuminaOccluder,
  LuminaScene,
} from "../renderer/lumina/scene";
import type { LaserTarget } from "../renderer/lumina/gameLaser";

import type { AppState } from "../types";

const {
  clipSegmentToCone,
  computeEdgeShadowQuad,
  computeSunShadowQuad,
  convexHull,
  intersectRects,
  parseColor,
  selectDirectShadowEdges,
  selectMirrorEdges,
  shadowStrengthFor,
} = __testing;

const laserEdge = (
  ax: number,
  ay: number,
  bx: number,
  by: number,
): LuminaEdge =>
  [
    [ax, ay],
    [bx, by],
  ] as LuminaEdge;

const laserOccluder = (
  id: string,
  material: LuminaOccluder["material"],
  edges: LuminaEdge[],
): LuminaOccluder => ({
  id,
  edges,
  material,
  opacity: 100,
  ior: 1.5,
});

const laserScene = (
  occluders: LuminaOccluder[] = [],
  lights: LuminaScene["lights"] = [],
): LuminaScene => ({
  occluders,
  lights,
  ambient: 1,
  caustics: false,
});

const laserTarget = (
  id: string,
  center: [number, number],
  radius: number,
  edges: LuminaEdge[] = [],
): LaserTarget => ({
  id,
  center,
  radius,
  edges,
});

const luminaRuntime = (mode: AppState["luminaGameMode"], enabled = true) => ({
  luminaEnabled: enabled,
  luminaAmbient: 0.35,
  luminaCaustics: false,
  luminaGameMode: mode,
});

const createPointEmitter = (
  id: string,
  center: [number, number],
  direction: number,
) =>
  API.createElement({
    type: "ellipse",
    id,
    x: center[0] - 24,
    y: center[1] - 24,
    width: 48,
    height: 48,
    angle: (direction - Math.PI / 2) as Radians,
    customData: {
      luminaLight: {
        light: "point",
        color: "#fff",
        intensity: 1,
        castShadows: true,
      },
    },
  });

const createMirrorLine = (
  id: string,
  origin: [number, number],
  end: [number, number],
) =>
  API.createElement({
    type: "line",
    id,
    x: origin[0],
    y: origin[1],
    width: end[0] - origin[0],
    height: end[1] - origin[1],
    points: [
      pointFrom<LocalPoint>(0, 0),
      pointFrom<LocalPoint>(end[0] - origin[0], end[1] - origin[1]),
    ],
    customData: { luminaMaterial: { material: "mirror" } },
  });

const createTargetElement = (
  id: string,
  center: [number, number],
  tolerance = 4,
  required = true,
) =>
  API.createElement({
    type: "rectangle",
    id,
    x: center[0] - 2,
    y: center[1] - 2,
    width: 4,
    height: 4,
    customData: {
      luminaGame: {
        role: "target",
        tolerance,
        required,
      },
    },
  });

const createTreasureElement = (
  id: string,
  center: [number, number],
  required = true,
  threshold = 0.25,
) =>
  API.createElement({
    type: "diamond",
    id,
    x: center[0] - 10,
    y: center[1] - 10,
    width: 20,
    height: 20,
    customData: {
      luminaGame: {
        role: "treasure",
        tolerance: threshold,
        required,
        label: id,
      },
    },
  });

const createSunEmitter = (id: string, direction: number) =>
  API.createElement({
    type: "ellipse",
    id,
    x: -80,
    y: -80,
    width: 48,
    height: 48,
    angle: (direction - Math.PI / 2) as Radians,
    customData: {
      luminaLight: {
        light: "sun",
        color: "#fff",
        intensity: 1,
        castShadows: true,
      },
    },
  });

const createSolidLine = (
  id: string,
  origin: [number, number],
  end: [number, number],
) =>
  API.createElement({
    type: "line",
    id,
    x: origin[0],
    y: origin[1],
    width: end[0] - origin[0],
    height: end[1] - origin[1],
    points: [
      pointFrom<LocalPoint>(0, 0),
      pointFrom<LocalPoint>(end[0] - origin[0], end[1] - origin[1]),
    ],
    customData: { luminaMaterial: { material: "solid" } },
  });

const createShadowTargetElement = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  tolerance = 0.15,
  required = true,
) =>
  API.createElement({
    type: "rectangle",
    id,
    x,
    y,
    width,
    height,
    customData: {
      luminaGame: {
        role: "shadowTarget",
        tolerance,
        required,
      },
    },
  });

const appStateWithSelection = (
  id: string,
  mode: AppState["luminaGameMode"] = { style: "laser", phase: "edit" },
): AppState =>
  ({
    ...getDefaultAppState(),
    width: 100,
    height: 100,
    offsetTop: 0,
    offsetLeft: 0,
    selectedElementIds: { [id]: true },
    luminaEnabled: true,
    luminaGameMode: mode,
  } as AppState);

describe("Lumina rendering", () => {
  describe("localization", () => {
    const flattenKeys = (value: unknown, prefix = ""): string[] => {
      if (!value || typeof value !== "object") {
        return prefix ? [prefix] : [];
      }
      return Object.entries(value).flatMap(([key, child]) =>
        flattenKeys(child, prefix ? `${prefix}.${key}` : key),
      );
    };

    it("ships complete Lumina copy in all supported product languages", () => {
      const expectedKeys = flattenKeys(enLocale.labels.lumina).sort();

      expect(flattenKeys(zhCNLocale.labels.lumina).sort()).toEqual(
        expectedKeys,
      );
      expect(flattenKeys(zhTWLocale.labels.lumina).sort()).toEqual(
        expectedKeys,
      );
      expect(languages.some(({ code }) => code === "zh-TW")).toBe(true);
    });
  });

  describe("F2 glass optics", () => {
    const glassEdges: LuminaEdge[] = [
      [
        [0, 0],
        [100, 0],
      ],
      [
        [100, 0],
        [100, 100],
      ],
      [
        [100, 100],
        [0, 100],
      ],
      [
        [0, 100],
        [0, 0],
      ],
    ];
    const glass: LuminaOccluder = {
      id: "glass",
      edges: glassEdges,
      material: "glass",
      opacity: 100,
      ior: 1.5,
    };

    it("refracts toward the normal and reports total internal reflection", () => {
      const straight = refractRay([0, 1], [0, -1], 1, 1.5);
      expect(straight?.[0]).toBeCloseTo(0);
      expect(straight?.[1]).toBeCloseTo(1);

      const bent = refractRay([Math.SQRT1_2, Math.SQRT1_2], [0, -1], 1, 1.5);
      expect(bent).not.toBeNull();
      expect(Math.abs(bent![0])).toBeLessThan(Math.SQRT1_2);
      expect(bent![1]).toBeGreaterThan(Math.SQRT1_2);

      expect(refractRay([Math.sqrt(3) / 2, -0.5], [0, 1], 1.5, 1)).toBeNull();
    });

    it("traces a finite entry, exit, and outgoing segment through closed glass", () => {
      expect(isClosedGlassEdgeLoop(glassEdges)).toBe(true);
      expect(isClosedGlassEdgeLoop(glassEdges.slice(0, 2))).toBe(false);

      const trace = traceRayThroughGlass(glass, [-100, 50], [1, 0], [glass], {
        maxDistance: 200,
      });
      expect(trace).not.toBeNull();
      expect(trace?.entry).toEqual([0, 50]);
      expect(trace?.exit[0]).toBeCloseTo(100);
      expect(trace?.exit[1]).toBeCloseTo(50);
      expect(trace?.outgoingDirection[0]).toBeCloseTo(1);
      expect(trace?.outgoingDirection[1]).toBeCloseTo(0);
      expect(trace?.endpoint.every(Number.isFinite)).toBe(true);
      expect(trace?.totalInternalReflection).toBe(false);
    });

    it("only builds bounded caustic contributions when enabled", () => {
      const light = {
        id: "point",
        type: "point" as const,
        x: -100,
        y: 50,
        color: "#80eaff",
        intensity: 1,
        radius: 600,
        castShadows: true,
      };
      const baseScene: LuminaScene = {
        occluders: [glass],
        lights: [light],
        ambient: 0.35,
        caustics: false,
      };
      expect(buildGlassCausticContributions(baseScene)).toEqual([]);

      const contributions = buildGlassCausticContributions(
        { ...baseScene, caustics: true },
        { maxRaysPerGlass: 6, maxContributions: 4, maxDistance: 300 },
      );
      expect(contributions.length).toBeGreaterThan(0);
      expect(contributions.length).toBeLessThanOrEqual(4);
      expect(
        contributions.every(
          (item) =>
            item.endpoint.every(Number.isFinite) &&
            item.outgoingDirection.every(Number.isFinite),
        ),
      ).toBe(true);
    });

    it("builds caustics from real Excalidraw rectangle geometry", () => {
      const lightElement = API.createElement({
        type: "ellipse",
        id: "real-light",
        x: 0,
        y: 30,
        width: 40,
        height: 40,
        customData: {
          luminaLight: {
            light: "point",
            color: "#80eaff",
            intensity: 0.7,
            radius: 500,
            castShadows: true,
          },
        },
      });
      const glassElement = API.createElement({
        type: "rectangle",
        id: "real-glass",
        x: 160,
        y: 0,
        width: 100,
        height: 100,
        customData: {
          luminaMaterial: { material: "glass", ior: 1.5 },
        },
      });
      const elements = [
        lightElement,
        glassElement,
      ] as NonDeletedExcalidrawElement[];
      const scene = buildLuminaScene(elements, arrayToMap(elements), {
        ambient: 0.35,
        caustics: true,
      });
      expect(isClosedGlassEdgeLoop(scene.occluders[0].edges)).toBe(true);
      expect(buildGlassCausticContributions(scene).length).toBeGreaterThan(0);
    });
  });

  describe("F3 environment mirror optics", () => {
    const mirror = (edge: LuminaEdge, id = "mirror"): LuminaOccluder => ({
      id,
      edges: [edge],
      material: "mirror",
      opacity: 100,
      ior: 1.5,
    });
    const solid = (edge: LuminaEdge, id = "solid"): LuminaOccluder => ({
      id,
      edges: [edge],
      material: "solid",
      opacity: 100,
      ior: 1.5,
    });
    const sceneFor = (
      light: LuminaScene["lights"][number],
      occluders: LuminaOccluder[],
    ): LuminaScene => ({
      lights: [light],
      occluders,
      ambient: 0.35,
      caustics: false,
    });

    it("builds finite point-light strips from a directly lit mirror", () => {
      const scene = sceneFor(
        {
          id: "point",
          type: "point",
          x: 0,
          y: 0,
          color: "#80eaff",
          intensity: 1,
          radius: 500,
          castShadows: true,
        },
        [mirror(laserEdge(100, -20, 100, 20))],
      );
      const contributions = buildReflectedLightContributions(scene, {
        samplesPerEdge: 4,
        maxDistance: 300,
      });

      expect(contributions).toHaveLength(4);
      expect(contributions[0].virtualSource?.[0]).toBeCloseTo(200);
      expect(contributions[0].reflectedDirection[0]).toBeLessThan(-0.95);
      expect(
        contributions.every((contribution) =>
          contribution.polygon.flat().every(Number.isFinite),
        ),
      ).toBe(true);
    });

    it("removes point reflection when an opaque blocker shades the mirror", () => {
      const scene = sceneFor(
        {
          id: "point",
          type: "point",
          x: 0,
          y: 0,
          color: "#80eaff",
          intensity: 1,
          radius: 500,
          castShadows: true,
        },
        [
          mirror(laserEdge(100, -20, 100, 20)),
          solid(laserEdge(50, -50, 50, 50)),
        ],
      );

      expect(buildReflectedLightContributions(scene)).toEqual([]);
    });

    it("clips spot reflection to the illuminated cone subsegment", () => {
      const halfAngle = Math.PI / 8;
      const scene = sceneFor(
        {
          id: "spot",
          type: "spot",
          x: 0,
          y: 0,
          color: "#80eaff",
          intensity: 1,
          radius: 500,
          castShadows: true,
          direction: 0,
          angle: halfAngle,
        },
        [mirror(laserEdge(100, -100, 100, 100))],
      );
      const contributions = buildReflectedLightContributions(scene, {
        samplesPerEdge: 4,
      });
      const limit = Math.tan(halfAngle) * 100;

      expect(contributions).toHaveLength(4);
      expect(
        contributions.every((contribution) =>
          contribution.mirrorSegment.every(
            (point) => Math.abs(point[1]) <= limit + 0.001,
          ),
        ),
      ).toBe(true);
    });

    it("does not reflect from a spot mirror behind the cone", () => {
      const scene = sceneFor(
        {
          id: "spot",
          type: "spot",
          x: 0,
          y: 0,
          color: "#80eaff",
          intensity: 1,
          radius: 500,
          castShadows: true,
          direction: 0,
          angle: Math.PI / 6,
        },
        [mirror(laserEdge(-100, -30, -100, 30))],
      );

      expect(buildReflectedLightContributions(scene)).toEqual([]);
    });

    it("keeps sun reflection parallel and truncates it at a solid blocker", () => {
      const scene = sceneFor(
        {
          id: "sun",
          type: "sun",
          x: 0,
          y: 0,
          color: "#fff2b0",
          intensity: 0.8,
          radius: 500,
          castShadows: true,
          direction: 0,
        },
        [
          mirror(laserEdge(100, -20, 140, 20)),
          solid(laserEdge(70, 60, 170, 60)),
        ],
      );
      const contributions = buildReflectedLightContributions(scene, {
        samplesPerEdge: 4,
        maxDistance: 500,
      });

      expect(contributions).toHaveLength(4);
      expect(
        contributions.every(
          (contribution) =>
            Math.abs(contribution.reflectedDirection[0]) < 0.001 &&
            contribution.reflectedDirection[1] > 0.999,
        ),
      ).toBe(true);
      expect(
        Math.max(
          ...contributions.flatMap((contribution) => [
            contribution.polygon[2][1],
            contribution.polygon[3][1],
          ]),
        ),
      ).toBeLessThanOrEqual(60.001);
    });

    it("lets a closed mirror self-occlude its back and side edges", () => {
      const closedMirror: LuminaOccluder = {
        id: "closed-mirror",
        material: "mirror",
        opacity: 60,
        ior: 1.5,
        edges: [
          laserEdge(100, -20, 200, -20),
          laserEdge(200, -20, 200, 20),
          laserEdge(200, 20, 100, 20),
          laserEdge(100, 20, 100, -20),
        ],
      };
      const contributions = buildReflectedLightContributions(
        sceneFor(
          {
            id: "sun",
            type: "sun",
            x: 0,
            y: 0,
            color: "#fff2b0",
            intensity: 0.8,
            radius: 500,
            castShadows: true,
            direction: 0,
          },
          [closedMirror],
        ),
        { samplesPerEdge: 2 },
      );

      expect(contributions).toHaveLength(2);
      expect(
        contributions.every((contribution) =>
          contribution.mirrorSegment.every(
            (point) => Math.abs(point[0] - 100) < 0.001,
          ),
        ),
      ).toBe(true);
    });

    it("respects a stable contribution budget without invalid geometry", () => {
      const scene = sceneFor(
        {
          id: "sun",
          type: "sun",
          x: 0,
          y: 0,
          color: "#fff2b0",
          intensity: 1,
          radius: 500,
          castShadows: true,
          direction: 0,
        },
        Array.from({ length: 20 }, (_, index) =>
          mirror(
            laserEdge(100, index * 50, 100, index * 50 + 20),
            `mirror-${index}`,
          ),
        ),
      );
      const contributions = buildReflectedLightContributions(scene, {
        samplesPerEdge: 4,
        maxContributions: 7,
      });

      expect(contributions).toHaveLength(7);
      expect(
        contributions.every(
          (contribution) =>
            contribution.intensity >= 0 &&
            contribution.polygon.flat().every(Number.isFinite),
        ),
      ).toBe(true);
    });
  });

  describe("F4 dark-room treasure hunt", () => {
    const treasure = (overrides: Record<string, unknown> = {}) => ({
      id: "treasure",
      bounds: { minX: 90, minY: -10, maxX: 110, maxY: 10 },
      samplePoints: buildDarkRoomSamplePoints({
        minX: 90,
        minY: -10,
        maxX: 110,
        maxY: 10,
      }),
      required: true,
      threshold: 0.25,
      stickyReveal: true,
      ...overrides,
    });
    const lightScene = (
      light: LuminaScene["lights"][number],
      occluders: LuminaOccluder[] = [],
    ): LuminaScene => ({
      lights: [light],
      occluders,
      ambient: 0.05,
      caustics: false,
    });

    it("builds bounded center, boundary, and interior sample points", () => {
      const points = buildDarkRoomSamplePoints({
        minX: 10,
        minY: 20,
        maxX: 40,
        maxY: 50,
      });
      expect(points).toHaveLength(9);
      expect(points).toContainEqual([10, 20]);
      expect(points).toContainEqual([25, 35]);
      expect(points).toContainEqual([40, 50]);
    });

    it("scores point, spot, and sun illumination geometrically", () => {
      const point = evaluateDarkRoomTreasure(
        treasure(),
        lightScene({
          id: "point",
          type: "point",
          x: 0,
          y: 0,
          color: "#fff",
          intensity: 1,
          radius: 250,
          castShadows: true,
        }),
        [],
      );
      const spot = evaluateDarkRoomTreasure(
        treasure(),
        lightScene({
          id: "spot",
          type: "spot",
          x: 0,
          y: 0,
          color: "#fff",
          intensity: 1,
          radius: 250,
          castShadows: true,
          direction: 0,
          angle: Math.PI / 8,
        }),
        [],
      );
      const spotAway = evaluateDarkRoomTreasure(
        treasure(),
        lightScene({
          id: "spot-away",
          type: "spot",
          x: 0,
          y: 0,
          color: "#fff",
          intensity: 1,
          radius: 250,
          castShadows: true,
          direction: Math.PI,
          angle: Math.PI / 8,
        }),
        [],
      );
      const sun = evaluateDarkRoomTreasure(
        treasure(),
        lightScene({
          id: "sun",
          type: "sun",
          x: 0,
          y: 0,
          color: "#fff",
          intensity: 0.8,
          radius: 1,
          castShadows: true,
          direction: 0,
        }),
        [],
      );

      expect(point.revealed).toBe(true);
      expect(spot.revealed).toBe(true);
      expect(spotAway.score).toBe(0);
      expect(sun.score).toBeCloseTo(0.8);
    });

    it("blocks with solid and attenuates through glass/translucent", () => {
      const pointLight = {
        id: "point",
        type: "point" as const,
        x: 0,
        y: 0,
        color: "#fff",
        intensity: 1,
        radius: 200,
        castShadows: true,
      };
      const edge = laserEdge(50, -30, 50, 30);
      const base = {
        id: "blocker",
        edges: [edge],
        opacity: 100,
        ior: 1.5,
      };
      const solidResult = evaluateDarkRoomTreasure(
        treasure(),
        lightScene(pointLight, [{ ...base, material: "solid" }]),
        [],
      );
      const glassResult = evaluateDarkRoomTreasure(
        treasure(),
        lightScene(pointLight, [{ ...base, material: "glass" }]),
        [],
      );
      const translucentResult = evaluateDarkRoomTreasure(
        treasure(),
        lightScene(pointLight, [{ ...base, material: "translucent" }]),
        [],
      );

      expect(solidResult.score).toBe(0);
      expect(glassResult.score).toBeGreaterThan(translucentResult.score);
      expect(translucentResult.score).toBeGreaterThan(0);
    });

    it("keeps sticky discoveries and only requires required treasures", () => {
      const mode = { style: "dark-room", phase: "play" } as const;
      const first = updateDarkRoomSession(
        mode,
        ["required", "optional"],
        ["required"],
      );
      expect(first.solved).toBe(true);
      const second = updateDarkRoomSession(mode, [], ["required"]);
      expect(second.discoveredIds).toEqual(["optional", "required"]);
      expect(second.solved).toBe(true);
      clearLuminaGameSession(mode);
      expect(getLuminaGameSessionSnapshot(mode).discoveredIds).toEqual([]);
    });

    it("supports non-sticky reveal without persisting it", () => {
      const mode = { style: "dark-room", phase: "play" } as const;
      expect(
        updateDarkRoomSession(mode, ["flash"], [], []).discoveredIds,
      ).toEqual(["flash"]);
      expect(updateDarkRoomSession(mode, [], [], []).discoveredIds).toEqual([]);
      clearLuminaGameSession(mode);
    });

    it("builds revealed/required render-model ids from one evaluation", () => {
      const model = buildDarkRoomRenderModel({
        scene: lightScene({
          id: "sun",
          type: "sun",
          x: 0,
          y: 0,
          color: "#fff",
          intensity: 1,
          radius: 1,
          castShadows: true,
          direction: 0,
        }),
        treasures: [
          treasure({ id: "required" }),
          treasure({ id: "optional", required: false }),
        ],
      });
      expect(model.revealedTreasureIds).toEqual(["required", "optional"]);
      expect(model.requiredTreasureIds).toEqual(["required"]);
    });

    it("builds and evaluates required/optional treasure elements", () => {
      const mode = { style: "dark-room", phase: "play" } as const;
      const elements = [
        createPointEmitter("light", [0, 0], 0),
        createTreasureElement("required", [100, 0]),
        createTreasureElement("optional", [120, 0], false),
      ] as NonDeletedExcalidrawElement[];
      const state = buildLuminaGameState(elements, arrayToMap(elements), {
        luminaEnabled: true,
        luminaAmbient: 0.05,
        luminaCaustics: false,
        luminaGameMode: mode,
      });
      const evaluation = evaluateLuminaGame(elements, arrayToMap(elements), {
        luminaEnabled: true,
        luminaAmbient: 0.05,
        luminaCaustics: false,
        luminaGameMode: mode,
      });

      expect(state?.treasures).toHaveLength(2);
      expect(evaluation.requiredTreasureIds).toEqual(["required"]);
      expect(evaluation.revealedTreasureIds).toEqual(["required", "optional"]);
      expect(evaluation.solved).toBe(true);
      clearLuminaGameSession(mode);
    });

    it("draws veil before holes and hides undiscovered treasure outlines", () => {
      const operations: string[] = [];
      const strokeRects: unknown[] = [];
      let composite = "source-over";
      const context: Record<string, any> = {
        fillStyle: "",
        strokeStyle: "",
        lineWidth: 1,
        shadowColor: "",
        shadowBlur: 0,
        save: () => operations.push("save"),
        restore: () => operations.push("restore"),
        setTransform: () => undefined,
        clearRect: () => operations.push("clear"),
        fillRect: () => operations.push(`fillRect:${composite}`),
        beginPath: () => undefined,
        closePath: () => undefined,
        moveTo: () => undefined,
        lineTo: () => undefined,
        clip: () => undefined,
        fill: () => operations.push(`fill:${composite}`),
        stroke: () => undefined,
        strokeRect: (...args: unknown[]) => strokeRects.push(args),
        arc: () => undefined,
        setLineDash: () => undefined,
        createRadialGradient: () => ({ addColorStop: () => undefined }),
      };
      Object.defineProperty(context, "globalCompositeOperation", {
        get: () => composite,
        set: (value) => {
          composite = value;
          operations.push(`composite:${value}`);
        },
      });
      const model = {
        treasures: [
          {
            ...treasure(),
            score: 0,
            revealed: false,
          },
        ],
        requiredTreasureIds: ["treasure"],
        revealedTreasureIds: [],
        stickyRevealedTreasureIds: [],
        lights: [
          {
            id: "point",
            type: "point" as const,
            x: 0,
            y: 0,
            color: "#fff",
            intensity: 1,
            radius: 100,
            castShadows: true,
          },
        ],
        reflections: [],
        shadowPolygons: [],
      };
      const viewport = {
        scrollX: 0,
        scrollY: 0,
        zoom: 1,
        width: 200,
        height: 100,
        scale: 2,
      };
      const mode = { style: "dark-room", phase: "play" } as const;

      renderLuminaDarkRoomOverlay(
        context as CanvasRenderingContext2D,
        model,
        viewport,
        {
          phase: "play",
          session: getLuminaGameSessionSnapshot(mode),
        },
      );
      expect(operations.indexOf("fillRect:source-over")).toBeLessThan(
        operations.indexOf("composite:destination-out"),
      );
      expect(strokeRects).toHaveLength(0);

      const session = updateDarkRoomSession(mode, ["treasure"], ["treasure"]);
      renderLuminaDarkRoomOverlay(
        context as CanvasRenderingContext2D,
        model,
        viewport,
        { phase: "play", session },
      );
      expect(strokeRects.length).toBeGreaterThan(0);
      clearLuminaGameSession(mode);
    });
  });

  describe("M3a laser ray kernel", () => {
    describe("intersectRaySegment", () => {
      it("returns the hit point, distance, and left normal for a direct hit", () => {
        const hit = intersectRaySegment([0, 0], [1, 0], [10, -5], [10, 5]);
        expect(hit).not.toBeNull();
        expect(hit!.t).toBeCloseTo(10);
        expect(hit!.point[0]).toBeCloseTo(10);
        expect(hit!.point[1]).toBeCloseTo(0);
        expect(hit!.normal[0]).toBeCloseTo(-1);
        expect(hit!.normal[1]).toBeCloseTo(0);
      });

      it("returns null for misses, parallel segments, and hits behind the ray", () => {
        expect(
          intersectRaySegment([0, 0], [1, 0], [10, 5], [10, 10]),
        ).toBeNull();
        expect(intersectRaySegment([0, 0], [1, 0], [0, 1], [10, 1])).toBeNull();
        expect(
          intersectRaySegment([0, 0], [1, 0], [-10, -5], [-10, 5]),
        ).toBeNull();
      });

      it("counts endpoint grazing as a hit", () => {
        const hit = intersectRaySegment([0, 0], [1, 0], [10, 0], [10, 5]);
        expect(hit).not.toBeNull();
        expect(hit!.t).toBeCloseTo(10);
        expect(hit!.point).toEqual([10, 0]);
      });
    });

    describe("reflectRay", () => {
      it("reflects a perpendicular ray back along its incoming line", () => {
        const reflected = reflectRay([0, 1], [0, 1]);
        expect(reflected[0]).toBeCloseTo(0);
        expect(reflected[1]).toBeCloseTo(-1);
      });

      it("reflects across a 45 degree mirror", () => {
        const reflected = reflectRay([1, 0], [-Math.SQRT1_2, Math.SQRT1_2]);
        expect(reflected[0]).toBeCloseTo(0);
        expect(reflected[1]).toBeCloseTo(1);
      });
    });

    it("hits a target after one mirror bounce", () => {
      const scene = laserScene([
        laserOccluder("mirror", "mirror", [laserEdge(5, 5, 20, 20)]),
      ]);
      const result = traceLaser(
        scene,
        [{ origin: [0, 10], dir: [1, 0] }],
        [laserTarget("target", [10, 30], 2)],
        { maxBounces: 1, maxDistance: 100 },
      );

      expect(result.hitTargetIds).toEqual(["target"]);
      expect(result.bouncesUsed).toEqual([1]);
      expect(result.paths[0]).toHaveLength(2);
      expect(result.paths[0][0].to[0]).toBeCloseTo(10);
      expect(result.paths[0][0].to[1]).toBeCloseTo(10);
    });

    it("hits a target after two chained mirror bounces", () => {
      const scene = laserScene([
        laserOccluder("m1", "mirror", [laserEdge(5, 5, 20, 20)]),
        laserOccluder("m2", "mirror", [laserEdge(0, 20, 20, 40)]),
      ]);
      const result = traceLaser(
        scene,
        [{ origin: [0, 10], dir: [1, 0] }],
        [laserTarget("target", [40, 30], 2)],
        { maxBounces: 2, maxDistance: 100 },
      );

      expect(result.hitTargetIds).toEqual(["target"]);
      expect(result.bouncesUsed).toEqual([2]);
      expect(result.paths[0]).toHaveLength(3);
      expect(result.paths[0][1].to[0]).toBeCloseTo(10);
      expect(result.paths[0][1].to[1]).toBeCloseTo(30);
    });

    it("stops at maxBounces without looping between opposing mirrors forever", () => {
      const scene = laserScene([
        laserOccluder("right", "mirror", [laserEdge(10, -10, 10, 10)]),
        laserOccluder("left", "mirror", [laserEdge(0, -10, 0, 10)]),
      ]);
      const result = traceLaser(scene, [{ origin: [5, 0], dir: [1, 0] }], [], {
        maxBounces: 3,
        maxDistance: 100,
      });

      expect(result.bouncesUsed).toEqual([3]);
      expect(result.paths[0]).toHaveLength(4);
      expect(result.hitTargetIds).toEqual([]);
    });

    it("lets solid occluders block targets behind them", () => {
      const scene = laserScene([
        laserOccluder("wall", "solid", [laserEdge(10, -5, 10, 5)]),
      ]);
      const result = traceLaser(
        scene,
        [{ origin: [0, 0], dir: [1, 0] }],
        [laserTarget("target", [20, 0], 2)],
        { maxDistance: 100 },
      );

      expect(result.hitTargetIds).toEqual([]);
      expect(result.paths[0]).toHaveLength(1);
      expect(result.paths[0][0].to[0]).toBeCloseTo(10);
      expect(result.paths[0][0].to[1]).toBeCloseTo(0);
    });

    it("uses a spot seed only along the cone axis, so a mirror behind it is silent", () => {
      const scene = laserScene(
        [laserOccluder("behindMirror", "mirror", [laserEdge(-10, -5, -10, 5)])],
        [
          {
            id: "spot",
            type: "spot",
            x: 0,
            y: 0,
            color: "#fff",
            intensity: 1,
            radius: 100,
            castShadows: true,
            direction: 0,
            angle: Math.PI / 8,
          },
        ],
      );
      const seeds = createLightLaserSeeds(scene);
      const result = traceLaser(
        scene,
        seeds,
        [laserTarget("behindTarget", [-20, 0], 2)],
        { maxDistance: 50 },
      );

      expect(seeds).toHaveLength(1);
      expect(seeds[0].dir[0]).toBeCloseTo(1);
      expect(seeds[0].dir[1]).toBeCloseTo(0);
      expect(result.hitTargetIds).toEqual([]);
      expect(result.paths[0][0].to[0]).toBeCloseTo(50);
      expect(result.paths[0][0].to[1]).toBeCloseTo(0);
    });

    it("generates finite parallel sun seeds that can hit a target", () => {
      const scene = laserScene(
        [],
        [
          {
            id: "sun",
            type: "sun",
            x: 0,
            y: 0,
            color: "#fff",
            intensity: 1,
            radius: 0,
            castShadows: true,
            direction: 0,
          },
        ],
      );
      const seeds = createLightLaserSeeds(scene, {
        bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
        sunRayCount: 1,
      });
      const result = traceLaser(
        scene,
        seeds,
        [laserTarget("target", [50, 50], 5)],
        { maxDistance: 300 },
      );

      expect(seeds).toHaveLength(1);
      expect(seeds[0].origin[0]).toBeLessThan(0);
      expect(seeds[0].origin[1]).toBeCloseTo(50);
      expect(seeds[0].dir[0]).toBeCloseTo(1);
      expect(seeds[0].dir[1]).toBeCloseTo(0);
      expect(result.hitTargetIds).toEqual(["target"]);
    });
  });

  describe("M3 laser visualization", () => {
    it("keeps scene-to-device mapping stable at 25%, 100%, and 400% zoom", () => {
      const baseViewport = {
        scrollX: 8,
        scrollY: -4,
        width: 800,
        height: 600,
        scale: 2,
      };

      expect(
        __gameRenderTesting.toDevicePoint([12, 14], {
          ...baseViewport,
          zoom: 0.25,
        }),
      ).toEqual([10, 5]);
      expect(
        __gameRenderTesting.toDevicePoint([12, 14], {
          ...baseViewport,
          zoom: 1,
        }),
      ).toEqual([40, 20]);
      expect(
        __gameRenderTesting.toDevicePoint([12, 14], {
          ...baseViewport,
          zoom: 4,
        }),
      ).toEqual([160, 80]);
    });

    it("culls game draw primitives outside the expanded viewport", () => {
      const viewport = {
        scrollX: 0,
        scrollY: 0,
        zoom: 1,
        width: 200,
        height: 100,
        scale: 2,
      };
      const viewportBounds =
        __gameRenderTesting.getViewportSceneBounds(viewport);

      expect(viewportBounds).toEqual({
        minX: -64,
        minY: -64,
        maxX: 264,
        maxY: 164,
      });
      expect(
        __gameRenderTesting.laserPathIsVisible(
          [{ from: [0, 0], to: [100, 50] }],
          viewportBounds,
        ),
      ).toBe(true);
      expect(
        __gameRenderTesting.laserPathIsVisible(
          [{ from: [500, 500], to: [600, 600] }],
          viewportBounds,
        ),
      ).toBe(false);
      expect(
        __gameRenderTesting.boundsIntersect(viewportBounds, {
          minX: 280,
          minY: 0,
          maxX: 300,
          maxY: 20,
        }),
      ).toBe(false);
    });

    it("maps scene paths to device pixels and highlights a hit target", () => {
      const moveCalls: [number, number][] = [];
      const lineCalls: [number, number][] = [];
      const arcCalls: [number, number, number][] = [];
      const clearCalls: [number, number, number, number][] = [];
      const strokes: Array<{ style: string; width: number }> = [];
      const context: Record<string, any> = {
        strokeStyle: "",
        fillStyle: "",
        lineWidth: 1,
        shadowColor: "",
        shadowBlur: 0,
        globalCompositeOperation: "source-over",
        lineCap: "butt",
        lineJoin: "miter",
        save: vi.fn(),
        restore: vi.fn(),
        setTransform: vi.fn(),
        clearRect: (x: number, y: number, width: number, height: number) =>
          clearCalls.push([x, y, width, height]),
        beginPath: vi.fn(),
        moveTo: (x: number, y: number) => moveCalls.push([x, y]),
        lineTo: (x: number, y: number) => lineCalls.push([x, y]),
        arc: (x: number, y: number, radius: number) =>
          arcCalls.push([x, y, radius]),
        stroke: () =>
          strokes.push({
            style: context.strokeStyle,
            width: context.lineWidth,
          }),
        fill: vi.fn(),
        setLineDash: vi.fn(),
      };
      const viewport = {
        scrollX: 5,
        scrollY: -10,
        zoom: 2,
        width: 200,
        height: 100,
        scale: 2,
      };
      const target = {
        ...laserTarget("target", [30, 40], 6),
        required: true,
      };

      renderLuminaLaserOverlay(
        context as unknown as CanvasRenderingContext2D,
        [target],
        {
          paths: [[{ from: [10, 20], to: [24, 40] }]],
          hitTargetIds: ["target"],
          bouncesUsed: [0],
        },
        viewport,
      );

      expect(clearCalls).toEqual([[0, 0, 400, 200]]);
      expect(moveCalls[0]).toEqual([60, 40]);
      expect(lineCalls[0]).toEqual([116, 120]);
      expect(arcCalls[0]).toEqual([140, 120, 24]);
      expect(strokes.some((stroke) => stroke.width === 20)).toBe(true);
      expect(strokes.some((stroke) => stroke.style.includes("255, 249"))).toBe(
        true,
      );
      expect(__gameRenderTesting.pathHitsTarget(tracePath(), [target])).toBe(
        true,
      );
    });

    const tracePath = () => [
      { from: [10, 20] as [number, number], to: [24, 40] as [number, number] },
    ];
  });

  describe("M3 shadow reveal visualization", () => {
    it("reduces shadow sampling only for deterministic pressure thresholds", () => {
      const baseState = {
        scene: {
          ambient: 1,
          caustics: false,
          lights: [],
          occluders: [
            laserOccluder(
              "edges",
              "solid",
              Array.from({ length: 64 }, (_, index) =>
                laserEdge(index, 0, index + 1, 0),
              ),
            ),
          ],
        },
        shadowTargets: Array.from({ length: 4 }, (_, index) => ({
          id: `target-${index}`,
        })),
      } as unknown as Parameters<typeof resolveShadowSampleSize>[0];

      expect(resolveShadowSampleSize(baseState)).toBe(12);
      expect(resolveShadowSampleSize(baseState, 20)).toBe(20);
      expect(resolveShadowSampleSize(baseState, 100)).toBe(32);
    });

    it("draws edit guides, mismatch cells, matched checks, and pulse feedback", () => {
      const clearCalls: [number, number, number, number][] = [];
      const fillCalls: Array<{
        rect: [number, number, number, number];
        style: string;
      }> = [];
      const strokeRectCalls: Array<{
        rect: [number, number, number, number];
        style: string;
        dash: number[];
      }> = [];
      const lineCalls: [number, number][] = [];
      let currentDash: number[] = [];
      const context: Record<string, any> = {
        strokeStyle: "",
        fillStyle: "",
        lineWidth: 1,
        shadowColor: "",
        shadowBlur: 0,
        globalCompositeOperation: "source-over",
        lineCap: "butt",
        lineJoin: "miter",
        save: vi.fn(),
        restore: vi.fn(),
        setTransform: vi.fn(),
        clearRect: (x: number, y: number, width: number, height: number) =>
          clearCalls.push([x, y, width, height]),
        fillRect: (x: number, y: number, width: number, height: number) =>
          fillCalls.push({
            rect: [x, y, width, height],
            style: context.fillStyle,
          }),
        strokeRect: (x: number, y: number, width: number, height: number) =>
          strokeRectCalls.push({
            rect: [x, y, width, height],
            style: context.strokeStyle,
            dash: [...currentDash],
          }),
        beginPath: vi.fn(),
        closePath: vi.fn(),
        moveTo: vi.fn(),
        lineTo: (x: number, y: number) => lineCalls.push([x, y]),
        stroke: vi.fn(),
        fill: vi.fn(),
        setLineDash: (dash: number[]) => {
          currentDash = [...dash];
        },
      };
      const viewport = {
        scrollX: 5,
        scrollY: -10,
        zoom: 1,
        width: 200,
        height: 100,
        scale: 2,
      };
      const baseTarget = {
        id: "shadow",
        bounds: { minX: 10, minY: 20, maxX: 30, maxY: 40 },
        actual: {
          bounds: { minX: 10, minY: 20, maxX: 30, maxY: 40 },
          sampleSize: 2,
          cells: [true, false, false, false],
        },
        expected: {
          bounds: { minX: 10, minY: 20, maxX: 30, maxY: 40 },
          sampleSize: 2,
          cells: [true, true, false, false],
        },
        score: 0.5,
        threshold: 0.8,
        matched: false,
        required: true,
      };
      const model = {
        targets: [baseTarget],
        matchedShadowTargetIds: [],
        shadowTargetScores: { shadow: 0.5 },
        requiredShadowTargetIds: ["shadow"],
        solved: false,
      };

      renderLuminaShadowOverlay(
        context as unknown as CanvasRenderingContext2D,
        model,
        viewport,
        { phase: "edit" },
      );
      renderLuminaShadowOverlay(
        context as unknown as CanvasRenderingContext2D,
        model,
        viewport,
        { phase: "play" },
      );
      renderLuminaShadowOverlay(
        context as unknown as CanvasRenderingContext2D,
        {
          ...model,
          targets: [{ ...baseTarget, score: 1, matched: true }],
          matchedShadowTargetIds: ["shadow"],
          shadowTargetScores: { shadow: 1 },
          solved: true,
        },
        viewport,
        {
          phase: "play",
          pulseTargetIds: new Set(["shadow"]),
          pulseProgress: 0.5,
        },
      );

      expect(clearCalls).toEqual([
        [0, 0, 400, 200],
        [0, 0, 400, 200],
        [0, 0, 400, 200],
      ]);
      expect(strokeRectCalls[0]).toMatchObject({
        rect: [30, 20, 40, 40],
        dash: [16, 10],
      });
      expect(
        strokeRectCalls.some((call) => call.style.includes("154, 132, 255")),
      ).toBe(true);
      expect(
        strokeRectCalls.some((call) => call.style.includes("113, 255, 190")),
      ).toBe(true);
      expect(
        fillCalls.some((call) => call.style.includes("255, 191, 71")),
      ).toBe(true);
      expect(
        fillCalls.some((call) => call.style.includes("255, 158, 92")),
      ).toBe(true);
      expect(lineCalls.length).toBeGreaterThan(1);
      expect(
        __gameRenderTesting.getNewlyMatchedShadowTargetIds(new Set(), [
          "shadow",
        ]),
      ).toEqual(new Set(["shadow"]));
      expect(
        __gameRenderTesting.shouldAnimateShadowMatch("play", 1, true),
      ).toBe(false);
      expect(
        __gameRenderTesting.shouldAnimateShadowMatch("play", 1, false),
      ).toBe(true);
    });
  });

  describe("Lumina light placement", () => {
    it("toggles glass refraction and caustics without disabling Lumina", () => {
      const appState = {
        ...getDefaultAppState(),
        luminaEnabled: true,
        luminaCaustics: false,
      } as AppState;
      const result = actionToggleLuminaCaustics.perform([], appState) as any;
      expect(result.appState.luminaEnabled).toBe(true);
      expect(result.appState.luminaCaustics).toBe(true);
    });

    it.each([
      ["point light", actionAddLightSource, "point"],
      ["sun", actionAddSun, "sun"],
    ] as const)(
      "assigns a valid fractional index when adding a %s",
      (_name, action, expectedType) => {
        const existing = {
          ...API.createElement({ type: "rectangle", id: "existing" }),
          index: "a0",
        } as NonDeletedExcalidrawElement;
        const appState = {
          ...getDefaultAppState(),
          width: 800,
          height: 600,
          offsetLeft: 0,
          offsetTop: 0,
        } as AppState;

        const result = (action.perform as any)(
          [existing] as any,
          appState,
          null as any,
          null as any,
        ) as any;
        const added = result.elements[1] as NonDeletedExcalidrawElement;

        expect(added.index).not.toBeNull();
        expect(added.index! > existing.index!).toBe(true);
        expect(added.customData?.luminaLight?.light).toBe(expectedType);
        expect(result.appState.luminaEnabled).toBe(true);
        expect(result.appState.selectedElementIds).toEqual({
          [added.id]: true,
        });
        expect(() =>
          validateFractionalIndices(result.elements, {
            shouldThrow: true,
            includeBoundTextValidation: true,
            ignoreLogs: true,
          }),
        ).not.toThrow();
      },
    );
  });

  describe("M3b playable laser level", () => {
    it("preserves luminaGame customData through restore", () => {
      const target = createTargetElement("target", [20, 10], 6);
      const restored = restoreElements([target], null);
      expect(restored).toHaveLength(1);
      expect(restored[0].customData?.luminaGame).toEqual({
        role: "target",
        tolerance: 6,
        required: true,
      });
    });

    it("solves a single mirror laser level", () => {
      const elements = [
        createPointEmitter("emitter", [0, 10], 0),
        createMirrorLine("mirror", [5, 5], [20, 20]),
        createTargetElement("target", [10, 30], 4),
      ] as NonDeletedExcalidrawElement[];

      const evaluation = evaluateLuminaGame(
        elements,
        arrayToMap(elements),
        luminaRuntime({ style: "laser", phase: "play" }),
      );

      expect(evaluation.active).toBe(true);
      expect(evaluation.solved).toBe(true);
      expect(evaluation.hitTargetIds).toEqual(["target"]);
      expect(evaluation.trace?.bouncesUsed).toEqual([1]);
    });

    it("does not solve when a solid occluder blocks the target", () => {
      const wall = API.createElement({
        type: "line",
        id: "wall",
        x: 10,
        y: 0,
        width: 0,
        height: 20,
        points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(0, 20)],
        customData: { luminaMaterial: { material: "solid" } },
      });
      const elements = [
        createPointEmitter("emitter", [0, 10], 0),
        wall,
        createTargetElement("target", [20, 10], 4),
      ] as NonDeletedExcalidrawElement[];

      const evaluation = evaluateLuminaGame(
        elements,
        arrayToMap(elements),
        luminaRuntime({ style: "laser", phase: "play" }),
      );

      expect(evaluation.active).toBe(true);
      expect(evaluation.solved).toBe(false);
      expect(evaluation.hitTargetIds).toEqual([]);
    });

    it("requires all required targets to be hit", () => {
      const elements = [
        createPointEmitter("emitter-a", [0, 0], 0),
        createPointEmitter("emitter-b", [0, 20], 0),
        createTargetElement("target-a", [20, 0], 4),
        createTargetElement("target-b", [20, 20], 4),
      ] as NonDeletedExcalidrawElement[];

      const solved = evaluateLuminaGame(
        elements,
        arrayToMap(elements),
        luminaRuntime({ style: "laser", phase: "play" }),
      );
      expect(solved.solved).toBe(true);
      expect(new Set(solved.hitTargetIds)).toEqual(
        new Set(["target-a", "target-b"]),
      );

      const missingOne = [
        elements[0],
        elements[1],
        elements[2],
        createTargetElement("target-b", [20, 40], 4),
      ] as NonDeletedExcalidrawElement[];
      const unsolved = evaluateLuminaGame(
        missingOne,
        arrayToMap(missingOne),
        luminaRuntime({ style: "laser", phase: "play" }),
      );
      expect(unsolved.solved).toBe(false);
      expect(unsolved.requiredTargetIds).toHaveLength(2);
    });

    it("restores participating game geometry from the play snapshot", () => {
      const emitter = createPointEmitter("emitter", [0, 10], 0);
      const mirror = createMirrorLine("mirror", [5, 5], [20, 20]);
      const target = createTargetElement("target", [10, 30], 4);
      const blocker = createSolidLine("blocker", [30, 5], [30, 25]);
      const snapshot = captureLuminaGameResetSnapshot([
        emitter,
        mirror,
        target,
        blocker,
      ]);
      const moved = {
        ...mirror,
        x: mirror.x + 50,
        y: mirror.y + 10,
        angle: (mirror.angle + 0.5) as Radians,
      };
      const movedBlocker = {
        ...blocker,
        x: blocker.x + 25,
        y: blocker.y + 15,
      };

      const reset = applyLuminaGameResetSnapshot(
        [emitter, moved, target, movedBlocker],
        snapshot,
      );

      expect(reset[1].x).toBe(mirror.x);
      expect(reset[1].y).toBe(mirror.y);
      expect(reset[1].angle).toBe(mirror.angle);
      expect(reset[0]).toBe(emitter);
      expect(reset[2]).toBe(target);
      expect(reset[3].x).toBe(blocker.x);
      expect(reset[3].y).toBe(blocker.y);
    });

    it("stays inactive when luminaGameMode is null or Lumina is disabled", () => {
      const elements = [
        createPointEmitter("emitter", [0, 10], 0),
        createTargetElement("target", [20, 10], 4),
      ] as NonDeletedExcalidrawElement[];

      expect(
        evaluateLuminaGame(elements, arrayToMap(elements), luminaRuntime(null))
          .active,
      ).toBe(false);
      expect(
        evaluateLuminaGame(
          elements,
          arrayToMap(elements),
          luminaRuntime({ style: "laser", phase: "play" }, false),
        ).active,
      ).toBe(false);
    });
  });

  describe("M3c level editor controls", () => {
    it("sets and clears target/emitter/shadowTarget game roles via the role action", () => {
      const rect = API.createElement({ type: "rectangle", id: "rect" });
      const appState = appStateWithSelection(rect.id);

      const targetResult = actionChangeLuminaGameRole.perform(
        [rect] as any,
        appState,
        "target",
        null as any,
      ) as any;
      expect(getLuminaGameData(targetResult.elements[0])?.role).toBe("target");

      const emitterResult = actionChangeLuminaGameRole.perform(
        targetResult.elements,
        appState,
        "emitter",
        null as any,
      ) as any;
      expect(getLuminaGameData(emitterResult.elements[0])?.role).toBe(
        "emitter",
      );

      const shadowTargetResult = actionChangeLuminaGameRole.perform(
        emitterResult.elements,
        appState,
        "shadowTarget",
        null as any,
      ) as any;
      expect(getLuminaGameData(shadowTargetResult.elements[0])?.role).toBe(
        "shadowTarget",
      );

      const clearedResult = actionChangeLuminaGameRole.perform(
        shadowTargetResult.elements,
        appState,
        null,
        null as any,
      ) as any;
      expect(getLuminaGameData(clearedResult.elements[0])).toBeNull();
    });

    it("writes constraints into luminaGame and clamps maxBounces/tolerance", () => {
      const emitter = API.createElement({
        type: "ellipse",
        id: "emitter",
        customData: {
          luminaGame: { role: "emitter", tolerance: 12 },
          luminaLight: {
            light: "point",
            color: "#fff",
            intensity: 1,
            castShadows: true,
          },
        },
      });
      const appState = appStateWithSelection(emitter.id);

      const result = actionChangeLuminaGameConstraint.perform(
        [emitter] as any,
        appState,
        {
          required: false,
          tolerance: 999,
          puzzleId: "  p1  ",
          label: "  main  ",
          maxBounces: 999,
        },
        null as any,
      ) as any;
      const data = getLuminaGameData(result.elements[0]);
      expect(data?.required).toBe(false);
      expect(data?.tolerance).toBe(200);
      expect(data?.puzzleId).toBe("p1");
      expect(data?.label).toBe("main");
      expect(data?.meta?.maxBounces).toBe(32);

      const ignoredBadValues = actionChangeLuminaGameConstraint.perform(
        result.elements,
        appState,
        {
          tolerance: Number.NaN,
          maxBounces: -10,
        },
        null as any,
      ) as any;
      const afterBadValues = getLuminaGameData(ignoredBadValues.elements[0]);
      expect(afterBadValues?.tolerance).toBe(200);
      expect(afterBadValues?.meta?.maxBounces).toBe(1);
    });

    it("only shows game editor controls in Lumina edit mode", () => {
      expect(
        shouldShowLuminaGameEditorControls({
          luminaEnabled: true,
          luminaGameMode: { style: "laser", phase: "edit" },
        }),
      ).toBe(true);
      expect(
        shouldShowLuminaGameEditorControls({
          luminaEnabled: true,
          luminaGameMode: { style: "laser", phase: "play" },
        }),
      ).toBe(false);
      expect(
        shouldShowLuminaGameEditorControls({
          luminaEnabled: false,
          luminaGameMode: { style: "laser", phase: "edit" },
        }),
      ).toBe(false);
      expect(
        shouldShowLuminaAuthorControls({
          luminaEnabled: true,
          luminaGameMode: { style: "dark-room", phase: "play" },
        }),
      ).toBe(false);
      expect(
        shouldShowLuminaAuthorControls({
          luminaEnabled: true,
          luminaGameMode: { style: "shadow-reveal", phase: "edit" },
        }),
      ).toBe(true);
      expect(
        shouldShowLuminaAuthorControls({
          luminaEnabled: true,
          luminaGameMode: null,
        }),
      ).toBe(true);
    });
  });

  describe("M3d shadow reveal puzzle", () => {
    it("solves when the current shadow fully covers the target pattern", () => {
      const elements = [
        createSunEmitter("sun", 0),
        createSolidLine("occluder", [0, 0], [0, 100]),
        createShadowTargetElement("shadow-target", 50, 0, 50, 100, 0),
      ] as NonDeletedExcalidrawElement[];

      const evaluation = evaluateLuminaGame(
        elements,
        arrayToMap(elements),
        luminaRuntime({ style: "shadow-reveal", phase: "play" }),
      );

      expect(evaluation.active).toBe(true);
      expect(evaluation.style).toBe("shadow-reveal");
      expect(evaluation.solved).toBe(true);
      expect(evaluation.matchedShadowTargetIds).toEqual(["shadow-target"]);
      expect(evaluation.requiredShadowTargetIds).toEqual(["shadow-target"]);
      expect(evaluation.shadowTargetScores["shadow-target"]).toBeCloseTo(1);
      expect(evaluation.trace).toBeNull();

      const state = buildLuminaGameState(
        elements,
        arrayToMap(elements),
        luminaRuntime({ style: "shadow-reveal", phase: "play" }),
      );
      expect(state).not.toBeNull();
      const renderModel = buildShadowRevealRenderModel(state!);
      expect(renderModel.solved).toBe(true);
      expect(renderModel.targets).toHaveLength(1);
      expect(renderModel.targets[0]).toMatchObject({
        id: "shadow-target",
        score: 1,
        threshold: 1,
        matched: true,
        required: true,
      });
      expect(renderModel.targets[0].actual.cells).toHaveLength(24 * 24);
      expect(renderModel.targets[0].expected.cells).toHaveLength(24 * 24);
    });

    it("does not solve when the target pattern is clearly outside the shadow", () => {
      const elements = [
        createSunEmitter("sun", 0),
        createSolidLine("occluder", [0, 0], [0, 100]),
        createShadowTargetElement("shadow-target", 50, 160, 50, 100, 0.15),
      ] as NonDeletedExcalidrawElement[];

      const evaluation = evaluateLuminaGame(
        elements,
        arrayToMap(elements),
        luminaRuntime({ style: "shadow-reveal", phase: "play" }),
      );

      expect(evaluation.solved).toBe(false);
      expect(evaluation.matchedShadowTargetIds).toEqual([]);
      expect(evaluation.shadowTargetScores["shadow-target"]).toBe(0);
    });

    it("solves when a shifted pattern is still inside its tolerance", () => {
      const elements = [
        createSunEmitter("sun", 0),
        createSolidLine("occluder", [0, 0], [0, 100]),
        createShadowTargetElement("shadow-target", 50, 40, 50, 100, 0.45),
      ] as NonDeletedExcalidrawElement[];

      const evaluation = evaluateLuminaGame(
        elements,
        arrayToMap(elements),
        luminaRuntime({ style: "shadow-reveal", phase: "play" }),
      );

      expect(evaluation.solved).toBe(true);
      expect(evaluation.shadowTargetScores["shadow-target"]).toBeGreaterThan(
        0.55,
      );
      expect(evaluation.shadowTargetScores["shadow-target"]).toBeLessThan(1);
    });

    it("requires every required shadow target to match", () => {
      const base = [
        createSunEmitter("sun", 0),
        createSolidLine("occluder", [0, 0], [0, 100]),
        createShadowTargetElement("shadow-a", 50, 0, 50, 100, 0),
      ] as NonDeletedExcalidrawElement[];

      const missingOne = [
        ...base,
        createShadowTargetElement("shadow-b", 50, 160, 50, 100, 0),
      ] as NonDeletedExcalidrawElement[];
      expect(
        evaluateLuminaGame(
          missingOne,
          arrayToMap(missingOne),
          luminaRuntime({ style: "shadow-reveal", phase: "play" }),
        ).solved,
      ).toBe(false);

      const allMatched = [
        ...base,
        createShadowTargetElement("shadow-b", 120, 0, 50, 100, 0),
      ] as NonDeletedExcalidrawElement[];
      const evaluation = evaluateLuminaGame(
        allMatched,
        arrayToMap(allMatched),
        luminaRuntime({ style: "shadow-reveal", phase: "play" }),
      );

      expect(evaluation.solved).toBe(true);
      expect(new Set(evaluation.matchedShadowTargetIds)).toEqual(
        new Set(["shadow-a", "shadow-b"]),
      );
    });

    it("handles damaged shadowTarget metadata and clamps shadow tolerance edits", () => {
      const damagedTarget = API.createElement({
        type: "rectangle",
        id: "shadow-target",
        x: 50,
        y: 0,
        width: 50,
        height: 100,
        customData: {
          luminaGame: {
            role: "shadowTarget",
            tolerance: "bad",
            meta: "bad",
          },
        } as any,
      });
      const elements = [
        createSunEmitter("sun", 0),
        createSolidLine("occluder", [0, 0], [0, 100]),
        damagedTarget,
      ] as NonDeletedExcalidrawElement[];

      expect(() =>
        evaluateLuminaGame(
          elements,
          arrayToMap(elements),
          luminaRuntime({ style: "shadow-reveal", phase: "play" }),
        ),
      ).not.toThrow();

      const appState = appStateWithSelection(damagedTarget.id, {
        style: "shadow-reveal",
        phase: "edit",
      });
      const clampedHigh = actionChangeLuminaGameConstraint.perform(
        [damagedTarget] as any,
        appState,
        { tolerance: 999 },
        null as any,
      ) as any;
      expect(getLuminaGameData(clampedHigh.elements[0])?.tolerance).toBe(1);

      const clampedLow = actionChangeLuminaGameConstraint.perform(
        clampedHigh.elements,
        appState,
        { tolerance: -1 },
        null as any,
      ) as any;
      expect(getLuminaGameData(clampedLow.elements[0])?.tolerance).toBe(0);
    });
  });

  describe("parseColor", () => {
    it("parses #rrggbb", () => {
      expect(parseColor("#ff8000")).toEqual([255, 128, 0]);
    });

    it("parses #rgb shorthand", () => {
      expect(parseColor("#f80")).toEqual([255, 136, 0]);
    });

    it("falls back to white on garbage", () => {
      expect(parseColor("not-a-color")).toEqual([255, 255, 255]);
    });
  });

  describe("shadowStrengthFor", () => {
    it("solid casts full shadow at full opacity", () => {
      expect(
        shadowStrengthFor({
          id: "a",
          edges: [],
          material: "solid",
          opacity: 100,
          ior: 1.5,
        }),
      ).toBeCloseTo(1);
    });

    it("translucent casts a weaker shadow", () => {
      const s = shadowStrengthFor({
        id: "a",
        edges: [],
        material: "translucent",
        opacity: 100,
        ior: 1.5,
      });
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(1);
    });

    it("glass transmits most light (only a faint shadow)", () => {
      // M2 修订三：玻璃是透明的，不该像实心一样把光全挡住。它只投一层很淡的
      // 阴影（此前的 bug 是 glass fall-through 到 solid 的 return base，导致
      // 「玻璃对光的反应和实心一模一样」）。
      const s = shadowStrengthFor({
        id: "a",
        edges: [],
        material: "glass",
        opacity: 100,
        ior: 1.5,
      });
      expect(s).toBeGreaterThan(0); // 仍有一点点（折射/反射的粗略近似）
      expect(s).toBeLessThan(0.3); // 但远比实心淡
    });

    it("mirror stays opaque: full body shadow (reflection is added separately)", () => {
      // 镜面本体不透明（你看不透镜子），照样投完整硬阴影；额外的反射高光由
      // addMirrorReflections 用虚像法另加，不体现在 shadowStrengthFor。
      expect(
        shadowStrengthFor({
          id: "a",
          edges: [],
          material: "mirror",
          opacity: 100,
          ior: 1.5,
        }),
      ).toBeCloseTo(1);
    });

    it("emissive does not cast a shadow (it becomes a light upstream)", () => {
      expect(
        shadowStrengthFor({
          id: "a",
          edges: [],
          material: "emissive",
          opacity: 100,
          ior: 1.5,
        }),
      ).toBe(0);
    });
  });

  describe("convexHull", () => {
    it("returns hull of a square's corners", () => {
      const hull = convexHull([
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0.5, 0.5], // interior point should be dropped
      ]);
      expect(hull).toHaveLength(4);
      expect(hull).not.toContainEqual([0.5, 0.5]);
    });
  });

  describe("computeEdgeShadowQuad", () => {
    it("projects an edge's shadow away from the light", () => {
      const light = {
        id: "l",
        type: "point" as const,
        x: 0,
        y: 0,
        color: "#fff",
        intensity: 1,
        radius: 1000,
        castShadows: true,
      };
      // an edge from (10,10) to (20,10)
      const edge = [
        [10, 10],
        [20, 10],
      ] as const;
      const quad = computeEdgeShadowQuad(light, edge, 1000);
      // a quadrilateral: near A, near B, far B, far A
      expect(quad).toHaveLength(4);
      // near corners are the edge endpoints
      expect(quad[0]).toEqual([10, 10]);
      expect(quad[1]).toEqual([20, 10]);
      // far corners are projected further from the light than the edge
      const maxNear = Math.hypot(20, 10);
      expect(Math.hypot(quad[2][0], quad[2][1])).toBeGreaterThan(maxNear);
      expect(Math.hypot(quad[3][0], quad[3][1])).toBeGreaterThan(maxNear);
    });
  });

  describe("computeSunShadowQuad", () => {
    it("projects all corners along one parallel direction (not radially)", () => {
      // 光沿 +x 传播（direction=0）。两端点各自 +x 平移同一距离 → 平行带。
      const edge = [
        [10, 10],
        [10, 40],
      ] as const;
      const proj = 1000;
      const quad = computeSunShadowQuad(0, edge, proj);
      expect(quad).toHaveLength(4);
      // 近端两角 = 线段端点。
      expect(quad[0]).toEqual([10, 10]);
      expect(quad[1]).toEqual([10, 40]);
      // 远端两角 = 端点沿同一方向向量(+x)平移 proj。平移向量恒定 → 平行光。
      expect(quad[2][0]).toBeCloseTo(10 + proj);
      expect(quad[2][1]).toBeCloseTo(40);
      expect(quad[3][0]).toBeCloseTo(10 + proj);
      expect(quad[3][1]).toBeCloseTo(10);
      // 两条投影向量相等（平行）——这正是与点光源放射投影的区别。
      const v1 = [quad[3][0] - quad[0][0], quad[3][1] - quad[0][1]];
      const v2 = [quad[2][0] - quad[1][0], quad[2][1] - quad[1][1]];
      expect(v1[0]).toBeCloseTo(v2[0]);
      expect(v1[1]).toBeCloseTo(v2[1]);
    });
  });

  describe("clipSegmentToCone", () => {
    // 聚光锥：apex 在原点，轴向 +x（axis=0），半角 45°。
    const apexX = 0;
    const apexY = 0;
    const axis = 0;
    const half = Math.PI / 4;

    it("keeps a segment fully inside the cone unchanged", () => {
      // 线段整段在 +x 方向锥内（x=100，y 从 -50 到 50，都在 ±45° 内）。
      const clipped = clipSegmentToCone(
        100,
        -50,
        100,
        50,
        apexX,
        apexY,
        axis,
        half,
      );
      expect(clipped).not.toBeNull();
      expect(clipped![0]).toBeCloseTo(100);
      expect(clipped![1]).toBeCloseTo(-50);
      expect(clipped![2]).toBeCloseTo(100);
      expect(clipped![3]).toBeCloseTo(50);
    });

    it("returns null for a segment fully behind the light (outside the cone)", () => {
      // 灯背后（-x 方向）的镜面：整段在锥外 → null（不反光，本次修复的核心）。
      const clipped = clipSegmentToCone(
        -100,
        -50,
        -100,
        50,
        apexX,
        apexY,
        axis,
        half,
      );
      expect(clipped).toBeNull();
    });

    it("clips a segment that straddles the cone boundary", () => {
      // 线段 x=100，y 从 -300 到 300：中段在锥内(|y|<=100)，两端超出。
      // 裁剪后 |y| 应被夹到锥边界 ≈ ±100（x=100、半角45° → y=±x=±100）。
      const clipped = clipSegmentToCone(
        100,
        -300,
        100,
        300,
        apexX,
        apexY,
        axis,
        half,
      );
      expect(clipped).not.toBeNull();
      // 端点 x 不变。
      expect(clipped![0]).toBeCloseTo(100);
      expect(clipped![2]).toBeCloseTo(100);
      // y 被夹到 ±100（锥边界），不再是 ±300。
      expect(Math.abs(clipped![1])).toBeLessThanOrEqual(100.01);
      expect(Math.abs(clipped![3])).toBeLessThanOrEqual(100.01);
      expect(Math.abs(clipped![1])).toBeGreaterThan(50);
      expect(Math.abs(clipped![3])).toBeGreaterThan(50);
    });
  });

  describe("intersectRects", () => {
    it("returns the overlap of two intersecting rects", () => {
      const box = intersectRects(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 50, y: 50, width: 100, height: 100 },
      );
      expect(box).toEqual({ x: 50, y: 50, width: 50, height: 50 });
    });

    it("returns null when rects do not overlap", () => {
      expect(
        intersectRects(
          { x: 0, y: 0, width: 10, height: 10 },
          { x: 100, y: 100, width: 10, height: 10 },
        ),
      ).toBeNull();
    });

    it("returns null for edge-touching rects (zero-area overlap)", () => {
      // 仅边相接（右边缘 x=10 碰左边缘 x=10）→ 交集零宽 → null，避免画空框。
      expect(
        intersectRects(
          { x: 0, y: 0, width: 10, height: 10 },
          { x: 10, y: 0, width: 10, height: 10 },
        ),
      ).toBeNull();
    });

    it("returns the inner rect when one contains the other", () => {
      const box = intersectRects(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 20, y: 30, width: 10, height: 10 },
      );
      expect(box).toEqual({ x: 20, y: 30, width: 10, height: 10 });
    });
  });

  describe("selectMirrorEdges", () => {
    const mk = (ax: number, ay: number, bx: number, by: number) => ({
      a: [ax, ay] as const,
      b: [bx, by] as const,
      opacity: 1,
    });

    it("returns all edges unchanged when under the limit", () => {
      const edges = [mk(0, 0, 1, 1), mk(2, 2, 3, 3)];
      const out = selectMirrorEdges(edges, 64);
      expect(out).toBe(edges); // 未超限：原样返回同一引用，顺序不变。
    });

    it("keeps the longest edges when over the limit (viewport-independent)", () => {
      // 取舍标准是边长（场景固定量），与视口无关——拖动画布不会改变保留集合。
      const short = mk(0, 0, 1, 0); // 长度 1
      const long = mk(0, 0, 1000, 0); // 长度 1000
      const out = selectMirrorEdges([short, long], 1);
      expect(out).toHaveLength(1);
      expect(out[0]).toBe(long);
    });

    it("keeps the same subset regardless of coordinates (no viewport drift)", () => {
      // 同一组边平移到任意位置，被保留的子集（按边长）必须一致——这正是修掉
      // 「拖动画布反射忽隐忽现」的关键：取舍不依赖坐标绝对位置。
      const edges = [mk(0, 0, 1, 0), mk(0, 0, 5, 0), mk(0, 0, 3, 0)];
      const shifted = edges.map((e) =>
        mk(e.a[0] + 9999, e.a[1] + 9999, e.b[0] + 9999, e.b[1] + 9999),
      );
      const outLen = (arr: ReturnType<typeof mk>[]) =>
        arr.map((e) => Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]));
      expect(outLen(selectMirrorEdges(edges, 2))).toEqual(
        outLen(selectMirrorEdges(shifted, 2)),
      );
    });

    it("truncates to exactly maxEdges", () => {
      const edges = Array.from({ length: 200 }, (_, i) =>
        mk(i, i, i + 1, i + 1),
      );
      expect(selectMirrorEdges(edges, 64)).toHaveLength(64);
    });

    it("caps direct shadow edges deterministically and ignores distant point edges", () => {
      const nearEdges = Array.from(
        { length: 300 },
        (_, index) =>
          [
            [index % 10, Math.floor(index / 10)],
            [(index % 10) + 1, Math.floor(index / 10)],
          ] as LuminaEdge,
      );
      const farEdge = laserEdge(1000, 1000, 1010, 1000);
      const shadowScene: LuminaScene = {
        ambient: 1,
        caustics: false,
        lights: [],
        occluders: [laserOccluder("near", "solid", [...nearEdges, farEdge])],
      };
      const shadowLight = {
        id: "light",
        type: "point" as const,
        x: 0,
        y: 0,
        color: "#fff",
        intensity: 1,
        radius: 100,
        castShadows: true,
      };

      const first = selectDirectShadowEdges(shadowScene, shadowLight);
      const second = selectDirectShadowEdges(shadowScene, shadowLight);
      expect(first).toHaveLength(192);
      expect(second).toEqual(first);
      expect(first.some(({ edge }) => edge === farEdge)).toBe(false);
    });
  });

  describe("buildLuminaScene", () => {
    it("reuses a bounded temporary canvas pool and releases it on reset", () => {
      clearLuminaLayerPool();
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 200;
      const context = canvas.getContext("2d")!;
      const poolViewport = {
        scrollX: 0,
        scrollY: 0,
        zoom: 1,
        width: 320,
        height: 200,
        scale: 1,
      };
      const poolScene: LuminaScene = {
        ambient: 0.5,
        caustics: false,
        occluders: [],
        lights: [
          {
            id: "pool-light",
            type: "point",
            x: 100,
            y: 100,
            color: "#fff",
            intensity: 1,
            radius: 200,
            castShadows: true,
          },
        ],
      };

      compositeLighting(context, poolScene, poolViewport);
      compositeLighting(context, poolScene, poolViewport);
      expect(getLuminaLayerPoolSize(context)).toBe(2);
      clearLuminaLayerPool();
      expect(getLuminaLayerPoolSize(context)).toBe(0);
    });

    it("coalesces RAF work to the latest task and cancels on teardown", () => {
      const frames: FrameRequestCallback[] = [];
      const requestFrame = vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      });
      const cancelFrame = vi.fn();
      const first = vi.fn();
      const latest = vi.fn();
      const cancelled = vi.fn();
      const scheduler = createLuminaRafScheduler(requestFrame, cancelFrame);

      scheduler.schedule(first);
      scheduler.schedule(latest);
      expect(requestFrame).toHaveBeenCalledTimes(1);
      expect(scheduler.isPending()).toBe(true);
      frames[0](16);
      expect(first).not.toHaveBeenCalled();
      expect(latest).toHaveBeenCalledWith(16);
      expect(scheduler.isPending()).toBe(false);

      scheduler.schedule(cancelled);
      scheduler.cancel();
      expect(cancelFrame).toHaveBeenCalledWith(2);
      expect(scheduler.isPending()).toBe(false);
      frames[1](32);
      expect(cancelled).not.toHaveBeenCalled();
    });

    it("reports bounded Lumina frame statistics without console logging", () => {
      resetLuminaPerformanceSamples();
      [1, 2, 3, 4, 100].forEach((duration) =>
        recordLuminaPerformanceSample("lighting", duration),
      );
      recordLuminaPerformanceSample("game", 7);

      expect(getLuminaPerformanceSnapshot()).toEqual({
        lighting: { count: 5, median: 3, p95: 100, max: 100 },
        game: { count: 1, median: 7, p95: 7, max: 7 },
      });

      for (let duration = 0; duration < 605; duration++) {
        recordLuminaPerformanceSample("game", duration);
      }
      expect(getLuminaPerformanceSnapshot().game.count).toBe(600);
    });

    it("reuses a scene for an identical stable input signature", () => {
      clearLuminaSceneCache();
      const rect = API.createElement({
        type: "rectangle",
        customData: { luminaMaterial: { material: "glass", ior: 1.4 } },
      });
      const firstElements = [rect] as NonDeletedExcalidrawElement[];
      const clonedRect = {
        ...rect,
        customData: { ...rect.customData },
      } as NonDeletedExcalidrawElement;
      const secondElements = [clonedRect];

      const first = buildLuminaScene(firstElements, arrayToMap(firstElements), {
        ambient: 0.5,
        caustics: true,
      });
      const second = buildLuminaScene(
        secondElements,
        arrayToMap(secondElements),
        { ambient: 0.5, caustics: true },
      );

      expect(second).toBe(first);
      expect(getLuminaSceneCacheStats()).toEqual({
        entries: 1,
        hits: 1,
        misses: 1,
      });
    });

    it("invalidates the scene cache for geometry and Lumina customData", () => {
      clearLuminaSceneCache();
      const rect = API.createElement({
        type: "rectangle",
        x: 10,
        customData: { luminaMaterial: { material: "solid" } },
      });
      const firstElements = [rect] as NonDeletedExcalidrawElement[];
      const first = buildLuminaScene(firstElements, arrayToMap(firstElements), {
        ambient: 1,
        caustics: false,
      });
      const moved = { ...rect, x: rect.x + 1 } as NonDeletedExcalidrawElement;
      const movedElements = [moved];
      const second = buildLuminaScene(
        movedElements,
        arrayToMap(movedElements),
        { ambient: 1, caustics: false },
      );
      const changedMaterial = {
        ...moved,
        customData: { luminaMaterial: { material: "mirror" as const } },
      } as NonDeletedExcalidrawElement;
      const changedElements = [changedMaterial];
      const third = buildLuminaScene(
        changedElements,
        arrayToMap(changedElements),
        { ambient: 1, caustics: false },
      );

      expect(second).not.toBe(first);
      expect(third).not.toBe(second);
      expect(third.occluders[0].material).toBe("mirror");
      expect(getLuminaSceneCacheStats().misses).toBe(3);
    });

    it("reuses GameState inside one mode and invalidates on element changes", () => {
      clearLuminaGameStateCache();
      const mode = { style: "laser", phase: "play" } as const;
      const emitter = API.createElement({
        type: "ellipse",
        customData: {
          luminaLight: {
            light: "point",
            color: "#00ffff",
            intensity: 1,
            castShadows: true,
          },
          luminaGame: { role: "emitter" },
        },
      });
      const elements = [emitter] as NonDeletedExcalidrawElement[];
      const runtime = {
        luminaEnabled: true,
        luminaAmbient: 0.5,
        luminaCaustics: false,
        luminaGameMode: mode,
      };

      const first = buildLuminaGameState(
        elements,
        arrayToMap(elements),
        runtime,
      );
      const second = buildLuminaGameState(
        [...elements],
        arrayToMap(elements),
        runtime,
      );
      const rotated = {
        ...emitter,
        angle: (emitter.angle + 0.1) as Radians,
      } as NonDeletedExcalidrawElement;
      const third = buildLuminaGameState(
        [rotated],
        arrayToMap([rotated]),
        runtime,
      );

      expect(second).toBe(first);
      expect(third).not.toBe(second);
      expect(getLuminaGameStateCacheStats()).toEqual({ hits: 1, misses: 2 });
      expect(getLuminaLaserTrace(first!)).toBe(getLuminaLaserTrace(first!));
      expect(getLuminaShadowRenderModel(first!)).toBe(
        getLuminaShadowRenderModel(first!),
      );
      expect(getLuminaDarkRoomRenderModel(first!)).toBe(
        getLuminaDarkRoomRenderModel(first!),
      );
    });

    it("separates light sources from occluders", () => {
      const rect = API.createElement({
        type: "rectangle",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      });
      const lightHost = API.createElement({
        type: "ellipse",
        x: 200,
        y: 200,
        width: 40,
        height: 40,
        customData: {
          luminaLight: {
            light: "point",
            color: "#ffeeaa",
            intensity: 1,
            castShadows: true,
          },
        },
      });
      const elements = [rect, lightHost] as NonDeletedExcalidrawElement[];
      const scene = buildLuminaScene(elements, arrayToMap(elements), {
        ambient: 0.5,
        caustics: false,
      });

      expect(scene.lights).toHaveLength(1);
      expect(scene.occluders).toHaveLength(1);
      expect(scene.lights[0].id).toBe(lightHost.id);
      expect(scene.occluders[0].id).toBe(rect.id);
      // occluder carries real geometry edges (a rectangle has >= 4 sides)
      expect(scene.occluders[0].edges.length).toBeGreaterThanOrEqual(4);
      // light host centre
      expect(scene.lights[0].x).toBeCloseTo(220);
      expect(scene.lights[0].y).toBeCloseTo(220);
      expect(scene.ambient).toBe(0.5);
    });

    it("reads material off occluders", () => {
      const rect = API.createElement({
        type: "rectangle",
        customData: { luminaMaterial: { material: "translucent" } },
      });
      const elements = [rect] as NonDeletedExcalidrawElement[];
      const scene = buildLuminaScene(elements, arrayToMap(elements), {
        ambient: 1,
        caustics: false,
      });
      expect(scene.occluders[0].material).toBe("translucent");
    });

    // ── M2 additions ──────────────────────────────────────────────

    it("carries default ior on non-glass occluders", () => {
      const rect = API.createElement({ type: "rectangle" });
      const elements = [rect] as NonDeletedExcalidrawElement[];
      const scene = buildLuminaScene(elements, arrayToMap(elements), {
        ambient: 1,
        caustics: false,
      });
      expect(scene.occluders[0].ior).toBeCloseTo(1.5);
    });

    it("carries explicit ior on glass occluders", () => {
      const rect = API.createElement({
        type: "rectangle",
        customData: { luminaMaterial: { material: "glass", ior: 2.2 } },
      });
      const elements = [rect] as NonDeletedExcalidrawElement[];
      const scene = buildLuminaScene(elements, arrayToMap(elements), {
        ambient: 1,
        caustics: false,
      });
      expect(scene.occluders[0].material).toBe("glass");
      expect(scene.occluders[0].ior).toBeCloseTo(2.2);
    });

    it("injects emissive material as a light, not an occluder (M2)", () => {
      const glow = API.createElement({
        type: "rectangle",
        x: 0,
        y: 0,
        width: 50,
        height: 50,
        strokeColor: "#00ff00",
        customData: {
          luminaMaterial: {
            material: "emissive",
            emissiveIntensity: 2,
          },
        },
      });
      const elements = [glow] as NonDeletedExcalidrawElement[];
      const scene = buildLuminaScene(elements, arrayToMap(elements), {
        ambient: 1,
        caustics: false,
      });
      // emissive becomes a light source, contributes no occluder
      expect(scene.occluders).toHaveLength(0);
      expect(scene.lights).toHaveLength(1);
      expect(scene.lights[0].intensity).toBe(2);
      // does not cast shadows (it emits, does not block)
      expect(scene.lights[0].castShadows).toBe(false);
    });

    it("emissive light defaults its color to the element strokeColor", () => {
      const glow = API.createElement({
        type: "rectangle",
        strokeColor: "#123456",
        customData: { luminaMaterial: { material: "emissive" } },
      });
      const elements = [glow] as NonDeletedExcalidrawElement[];
      const scene = buildLuminaScene(elements, arrayToMap(elements), {
        ambient: 1,
        caustics: false,
      });
      expect(scene.lights[0].color).toBe("#123456");
    });

    it("derives sun direction from host rotation; leaves point lights without one", () => {
      // 方向的唯一真相源是宿主元素的旋转角：direction = element.angle + π/2。
      // customData 里即便残留 direction 也被忽略（此处故意塞一个错值验证被无视）。
      const sun = API.createElement({
        type: "ellipse",
        angle: 0.5,
        customData: {
          luminaLight: {
            light: "sun",
            color: "#fff",
            intensity: 1,
            direction: 999,
            castShadows: true,
          },
        },
      });
      const point = API.createElement({
        type: "ellipse",
        customData: {
          luminaLight: {
            light: "point",
            color: "#fff",
            intensity: 1,
            castShadows: true,
          },
        },
      });
      const elements = [sun, point] as NonDeletedExcalidrawElement[];
      const scene = buildLuminaScene(elements, arrayToMap(elements), {
        ambient: 1,
        caustics: false,
      });
      const sunLight = scene.lights.find((l) => l.type === "sun")!;
      const pointLight = scene.lights.find((l) => l.type === "point")!;
      expect(sunLight.direction).toBeCloseTo(0.5 + Math.PI / 2);
      expect(pointLight.direction).toBeUndefined();
    });

    it("carries spot cone angle + host-rotation direction; point light has neither", () => {
      // 方向唯一真源是宿主元素旋转角：direction = element.angle + π/2。
      const spot = API.createElement({
        type: "ellipse",
        angle: 0.3 as NonDeletedExcalidrawElement["angle"],
        customData: {
          luminaLight: {
            light: "spot",
            color: "#fff",
            intensity: 1,
            angle: 0.5,
            castShadows: true,
          },
        },
      });
      const point = API.createElement({
        type: "ellipse",
        customData: {
          luminaLight: {
            light: "point",
            color: "#fff",
            intensity: 1,
            castShadows: true,
          },
        },
      });
      const elements = [spot, point] as NonDeletedExcalidrawElement[];
      const scene = buildLuminaScene(elements, arrayToMap(elements), {
        ambient: 1,
        caustics: false,
      });
      const spotLight = scene.lights.find((l) => l.type === "spot")!;
      const pointLight = scene.lights.find((l) => l.type === "point")!;
      // 锥轴方向 = 宿主旋转角 + π/2。
      expect(spotLight.direction).toBeCloseTo(0.3 + Math.PI / 2);
      // 锥半角仍从 customData 读。
      expect(spotLight.angle).toBeCloseTo(0.5);
      expect(pointLight.direction).toBeUndefined();
      expect(pointLight.angle).toBeUndefined();
    });

    it("derives spot cone angle from host size + direction when omitted", () => {
      const spot = API.createElement({
        type: "ellipse",
        width: 100,
        height: 100,
        customData: {
          luminaLight: {
            light: "spot",
            color: "#fff",
            intensity: 1,
            castShadows: true,
          },
        },
      });
      const elements = [spot] as NonDeletedExcalidrawElement[];
      const scene = buildLuminaScene(elements, arrayToMap(elements), {
        ambient: 1,
        caustics: false,
      });
      const spotLight = scene.lights.find((l) => l.type === "spot")!;
      // 缺省锥半角从宿主尺寸推导：atan2(width/2, height) = atan2(50,100)。
      expect(spotLight.angle).toBeCloseTo(Math.atan2(50, 100));
      // 方向 = 宿主旋转角(缺省 0) + π/2。
      expect(spotLight.direction).toBeCloseTo(Math.PI / 2);
    });

    it("widens/narrows the derived spot cone as the host is stretched", () => {
      const mk = (width: number, height: number) => {
        const spot = API.createElement({
          type: "ellipse",
          width,
          height,
          customData: {
            luminaLight: {
              light: "spot",
              color: "#fff",
              intensity: 1,
              castShadows: true,
            },
          },
        });
        const elements = [spot] as NonDeletedExcalidrawElement[];
        const scene = buildLuminaScene(elements, arrayToMap(elements), {
          ambient: 1,
          caustics: false,
        });
        return scene.lights.find((l) => l.type === "spot")!.angle!;
      };
      // 拉宽 → 开角变大；拉高 → 开角变小。
      const wide = mk(300, 100);
      const square = mk(100, 100);
      const tall = mk(100, 300);
      expect(wide).toBeGreaterThan(square);
      expect(square).toBeGreaterThan(tall);
      expect(wide).toBeCloseTo(Math.atan2(150, 100));
      expect(tall).toBeCloseTo(Math.atan2(50, 300));
    });

    it("keeps an explicit spot angle regardless of host size", () => {
      const spot = API.createElement({
        type: "ellipse",
        width: 300,
        height: 100,
        customData: {
          luminaLight: {
            light: "spot",
            color: "#fff",
            intensity: 1,
            angle: 0.5,
            castShadows: true,
          },
        },
      });
      const elements = [spot] as NonDeletedExcalidrawElement[];
      const scene = buildLuminaScene(elements, arrayToMap(elements), {
        ambient: 1,
        caustics: false,
      });
      const spotLight = scene.lights.find((l) => l.type === "spot")!;
      // 显式 angle 优先，忽略尺寸推导。
      expect(spotLight.angle).toBeCloseTo(0.5);
    });
  });

  describe("packOccluders", () => {
    it("returns an empty 1x1 texture for no occluders", () => {
      const packed = packOccluders([]);
      expect(packed.edgeCount).toBe(0);
      expect(packed.width).toBe(1);
      expect(packed.height).toBe(1);
      expect(packed.data).toHaveLength(4);
    });

    it("packs each edge into 2 texels with coords then material meta", () => {
      const packed = packOccluders([
        {
          id: "o1",
          edges: [
            [
              [10, 20],
              [30, 40],
            ],
          ],
          material: "glass",
          opacity: 80,
          ior: 1.7,
        },
      ]);
      expect(packed.edgeCount).toBe(1);
      // texel 0: endpoints
      expect(packed.data[0]).toBeCloseTo(10);
      expect(packed.data[1]).toBeCloseTo(20);
      expect(packed.data[2]).toBeCloseTo(30);
      expect(packed.data[3]).toBeCloseTo(40);
      // texel 1: materialCode (glass=2), opacity normalized 0..1, ior
      expect(packed.data[4]).toBe(LUMINA_MATERIAL_CODE.glass);
      expect(packed.data[5]).toBeCloseTo(0.8);
      expect(packed.data[6]).toBeCloseTo(1.7);
    });

    it("flattens edges across occluders and respects maxEdges", () => {
      const many: LuminaOccluder = {
        id: "o",
        edges: Array.from(
          { length: 10 },
          (_, i) =>
            [
              [i, i],
              [i + 1, i + 1],
            ] as LuminaEdge,
        ),
        material: "solid",
        opacity: 100,
        ior: 1.5,
      };
      const packed = packOccluders([many], 4);
      expect(packed.edgeCount).toBe(4);
    });

    it("keeps the signature stable when geometry/material is unchanged", () => {
      const occ: LuminaOccluder = {
        id: "o",
        edges: [
          [
            [0, 0],
            [10, 10],
          ],
        ],
        material: "solid",
        opacity: 100,
        ior: 1.5,
      };
      // 同样输入 → 同样签名（renderer 据此跳过纹理重传）。
      expect(packOccluders([occ]).signature).toBe(
        packOccluders([occ]).signature,
      );
    });

    it("changes the signature when occluder geometry changes", () => {
      const base: LuminaOccluder = {
        id: "o",
        edges: [
          [
            [0, 0],
            [10, 10],
          ],
        ],
        material: "solid",
        opacity: 100,
        ior: 1.5,
      };
      const moved: LuminaOccluder = {
        ...base,
        edges: [
          [
            [0, 0],
            [20, 10],
          ],
        ],
      };
      expect(packOccluders([base]).signature).not.toBe(
        packOccluders([moved]).signature,
      );
    });

    it("flags hasMirror only when a mirror occluder is present", () => {
      const solid: LuminaOccluder = {
        id: "s",
        edges: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
        material: "solid",
        opacity: 100,
        ior: 1.5,
      };
      const mirror: LuminaOccluder = { ...solid, id: "m", material: "mirror" };
      expect(packOccluders([solid]).hasMirror).toBe(false);
      expect(packOccluders([solid, mirror]).hasMirror).toBe(true);
    });
  });
});
