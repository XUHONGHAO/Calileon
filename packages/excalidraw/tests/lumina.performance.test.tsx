import { arrayToMap } from "@excalidraw/common";

import { pointFrom } from "@excalidraw/math";

import type { NonDeletedExcalidrawElement } from "@excalidraw/element/types";
import type { Radians } from "@excalidraw/math";

import { clearLuminaLayerPool } from "../renderer/lumina/composite";
import {
  buildLuminaGameState,
  clearLuminaGameStateCache,
  getLuminaDarkRoomRenderModel,
  getLuminaLaserTrace,
  getLuminaShadowRenderModel,
} from "../renderer/lumina/game";
import { renderLuminaGameEffects } from "../renderer/lumina/gameRender";
import { EMPTY_LUMINA_GAME_SESSION } from "../renderer/lumina/gameSession";
import { renderLuminaScene } from "../renderer/lumina/render";
import { clearLuminaSceneCache } from "../renderer/lumina/scene";

import { API } from "./helpers/api";

const runPerformanceMatrix = process.env.LUMINA_PERF === "1";
const describePerformance = runPerformanceMatrix ? describe : describe.skip;

const viewport = {
  scrollX: 0,
  scrollY: 0,
  zoom: 1,
  width: 1280,
  height: 720,
  scale: 1,
};

const createContext = () => {
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  return canvas.getContext("2d")!;
};

const rectangleGrid = (count: number, columns: number) =>
  Array.from({ length: count }, (_, index) =>
    API.createElement({
      type: "rectangle",
      x: 20 + (index % columns) * 80,
      y: 20 + Math.floor(index / columns) * 60,
      width: 50,
      height: 35,
    }),
  ) as NonDeletedExcalidrawElement[];

const light = (
  id: string,
  x: number,
  y: number,
  type: "point" | "spot" | "sun" = "point",
) =>
  API.createElement({
    id,
    type: "ellipse",
    x,
    y,
    width: 36,
    height: 36,
    customData: {
      luminaLight: {
        light: type,
        color: "#b9f3ff",
        intensity: 0.85,
        radius: type === "sun" ? 1400 : 700,
        angle: type === "spot" ? Math.PI / 4 : undefined,
        castShadows: true,
      },
    },
  }) as NonDeletedExcalidrawElement;

const material = (
  id: string,
  x: number,
  y: number,
  value: "mirror" | "glass" | "solid" = "solid",
) =>
  API.createElement({
    id,
    type: value === "mirror" ? "line" : "rectangle",
    x,
    y,
    width: 80,
    height: value === "mirror" ? 0 : 60,
    points:
      value === "mirror" ? [pointFrom(0, 0), pointFrom(80, 0)] : undefined,
    customData: {
      luminaMaterial: {
        material: value,
        ior: value === "glass" ? 1.5 : undefined,
      },
    },
  }) as NonDeletedExcalidrawElement;

const rotateFirstLight = (
  elements: readonly NonDeletedExcalidrawElement[],
  iteration: number,
) => {
  const lightIndex = elements.findIndex(
    (element) => element.customData?.luminaLight,
  );
  if (lightIndex < 0) {
    return elements;
  }
  const next = [...elements];
  next[lightIndex] = {
    ...next[lightIndex],
    angle: (iteration * 0.013) as Radians,
  };
  return next;
};

const summarize = (samples: readonly number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (ratio: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
  return {
    median: at(0.5),
    p95: at(0.95),
    max: sorted.at(-1) ?? 0,
  };
};

const measure = (run: (iteration: number) => void) => {
  for (let iteration = 0; iteration < 5; iteration++) {
    run(iteration);
  }
  const samples: number[] = [];
  for (let iteration = 0; iteration < 120; iteration++) {
    const startedAt = performance.now();
    run(iteration + 5);
    samples.push(performance.now() - startedAt);
  }
  return summarize(samples);
};

describePerformance("Lumina manual performance matrix", () => {
  it("prints deterministic P1-P6 CPU compute+draw timings", () => {
    clearLuminaSceneCache();
    clearLuminaGameStateCache();
    clearLuminaLayerPool();
    const ctx = createContext();
    const results: Record<string, ReturnType<typeof summarize>> = {};

    const p1 = [
      ...rectangleGrid(100, 10),
      light("p1-0", 40, 650),
      light("p1-1", 360, 650, "spot"),
      light("p1-2", 720, 650),
      light("p1-3", 1040, 650, "sun"),
    ];
    results.P1 = measure((iteration) => {
      const elements = rotateFirstLight(p1, iteration);
      renderLuminaScene(ctx, elements, arrayToMap(elements), viewport, {
        ambient: 0.35,
        caustics: false,
      });
    });

    const p2Emitter = {
      ...light("p2-emitter", 30, 320, "spot"),
      customData: {
        ...light("p2-template", 0, 0, "spot").customData,
        luminaGame: { role: "emitter" as const, meta: { maxBounces: 8 } },
      },
    };
    const p2 = [
      p2Emitter,
      ...Array.from({ length: 10 }, (_, index) => ({
        ...material(
          `p2-mirror-${index}`,
          180 + (index % 5) * 190,
          120 + Math.floor(index / 5) * 400,
          "mirror",
        ),
        angle: (index % 2 ? -Math.PI / 4 : Math.PI / 4) as Radians,
      })),
      API.createElement({
        type: "ellipse",
        x: 1100,
        y: 320,
        customData: {
          luminaGame: { role: "target", required: true, tolerance: 24 },
        },
      }) as NonDeletedExcalidrawElement,
    ];
    const laserMode = { style: "laser", phase: "play" } as const;
    results.P2 = measure((iteration) => {
      const elements = rotateFirstLight(p2, iteration);
      const state = buildLuminaGameState(elements, arrayToMap(elements), {
        luminaEnabled: true,
        luminaAmbient: 0.35,
        luminaCaustics: false,
        luminaGameMode: laserMode,
      })!;
      renderLuminaGameEffects(
        ctx,
        {
          style: "laser",
          targets: state.targets,
          trace: getLuminaLaserTrace(state),
        },
        viewport,
      );
    });

    const p3 = [
      ...Array.from({ length: 6 }, (_, index) =>
        material(
          `p3-glass-${index}`,
          180 + (index % 3) * 300,
          160 + Math.floor(index / 3) * 320,
          "glass",
        ),
      ),
      light("p3-light-0", 30, 240),
      light("p3-light-1", 1080, 420, "spot"),
    ];
    results.P3 = measure((iteration) => {
      const elements = rotateFirstLight(p3, iteration);
      renderLuminaScene(ctx, elements, arrayToMap(elements), viewport, {
        ambient: 0.35,
        caustics: true,
      });
    });

    const p4 = [
      ...rectangleGrid(25, 5),
      ...Array.from({ length: 4 }, (_, index) =>
        API.createElement({
          type: "rectangle",
          x: 160 + index * 260,
          y: 620,
          width: 100,
          height: 70,
          customData: {
            luminaGame: {
              role: "shadowTarget",
              required: true,
              tolerance: 0.18,
            },
          },
        }),
      ),
      light("p4-light", 620, 10),
    ] as NonDeletedExcalidrawElement[];
    const shadowMode = { style: "shadow-reveal", phase: "play" } as const;
    results.P4 = measure((iteration) => {
      const elements = rotateFirstLight(p4, iteration);
      const state = buildLuminaGameState(elements, arrayToMap(elements), {
        luminaEnabled: true,
        luminaAmbient: 0.35,
        luminaCaustics: false,
        luminaGameMode: shadowMode,
      })!;
      renderLuminaGameEffects(
        ctx,
        {
          style: "shadow-reveal",
          phase: "play",
          model: getLuminaShadowRenderModel(state),
        },
        viewport,
      );
    });

    const p5 = [
      ...Array.from({ length: 8 }, (_, index) =>
        API.createElement({
          type: "rectangle",
          x: 100 + (index % 4) * 280,
          y: 160 + Math.floor(index / 4) * 360,
          width: 80,
          height: 70,
          customData: {
            luminaGame: {
              role: "treasure",
              required: index < 6,
              tolerance: 0.35,
              meta: { sampleDensity: 5, stickyReveal: true },
            },
          },
        }),
      ),
      light("p5-light-0", 20, 40),
      light("p5-light-1", 600, 30, "spot"),
      light("p5-light-2", 1180, 40, "sun"),
      ...Array.from({ length: 12 }, (_, index) =>
        material(
          `p5-block-${index}`,
          70 + (index % 6) * 190,
          340 + Math.floor(index / 6) * 150,
        ),
      ),
    ] as NonDeletedExcalidrawElement[];
    const darkMode = { style: "dark-room", phase: "play" } as const;
    results.P5 = measure((iteration) => {
      const elements = rotateFirstLight(p5, iteration);
      const state = buildLuminaGameState(elements, arrayToMap(elements), {
        luminaEnabled: true,
        luminaAmbient: 0.35,
        luminaCaustics: false,
        luminaGameMode: darkMode,
      })!;
      renderLuminaGameEffects(
        ctx,
        {
          style: "dark-room",
          phase: "play",
          model: getLuminaDarkRoomRenderModel(state),
          session: EMPTY_LUMINA_GAME_SESSION,
        },
        viewport,
      );
    });

    const p6 = [
      ...Array.from({ length: 20 }, (_, index) =>
        material(
          `p6-mirror-${index}`,
          40 + (index % 5) * 230,
          60 + Math.floor(index / 5) * 150,
          "mirror",
        ),
      ),
      ...Array.from({ length: 10 }, (_, index) =>
        material(
          `p6-glass-${index}`,
          100 + (index % 5) * 230,
          610 + Math.floor(index / 5) * 100,
          "glass",
        ),
      ),
      light("p6-light-0", 10, 10),
      light("p6-light-1", 1180, 10, "spot"),
      light("p6-light-2", 10, 660, "sun"),
      light("p6-light-3", 1180, 660),
    ];
    results.P6 = measure((iteration) => {
      const elements = rotateFirstLight(p6, iteration);
      renderLuminaScene(ctx, elements, arrayToMap(elements), viewport, {
        ambient: 0.35,
        caustics: true,
      });
    });

    for (const summary of Object.values(results)) {
      expect(summary.p95).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(summary.max)).toBe(true);
    }
    // Explicit manual benchmark command only; skipped in normal test runs.
    // eslint-disable-next-line no-console
    console.info(`__LUMINA_PERF__${JSON.stringify(results)}`);
  }, 30_000);
});
