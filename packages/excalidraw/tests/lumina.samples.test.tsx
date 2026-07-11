import { readFileSync } from "node:fs";
import path from "node:path";

import { arrayToMap } from "@excalidraw/common";

import type { NonDeletedExcalidrawElement } from "@excalidraw/element/types";

import { restoreElements } from "../data/restore";
import {
  buildLuminaGameState,
  getLuminaDarkRoomRenderModel,
  getLuminaLaserTrace,
  getLuminaShadowRenderModel,
} from "../renderer/lumina/game";

const sampleDirectory = process.env.LUMINA_SAMPLE_DIR;
const describeSamples = sampleDirectory ? describe : describe.skip;

const loadSample = (name: string) => {
  const raw = JSON.parse(
    readFileSync(path.join(sampleDirectory!, name), "utf8"),
  );
  return restoreElements(raw.elements, null).filter(
    (element) => !element.isDeleted,
  ) as NonDeletedExcalidrawElement[];
};

describeSamples("Lumina documentation samples", () => {
  it("laser-mirror-lab reaches its required target through two mirrors", () => {
    const elements = loadSample("laser-mirror-lab.excalidraw");
    const state = buildLuminaGameState(elements, arrayToMap(elements), {
      luminaEnabled: true,
      luminaAmbient: 0.42,
      luminaCaustics: true,
      luminaGameMode: { style: "laser", phase: "play" },
    })!;
    const trace = getLuminaLaserTrace(state);
    expect(state.targets.filter((target) => target.required)).toHaveLength(1);
    expect(trace.hitTargetIds).toContain("laser-target");
    expect(Math.max(...trace.bouncesUsed)).toBeGreaterThanOrEqual(2);
  });

  it("shadow-word-reveal restores one required target with finite masks", () => {
    const elements = loadSample("shadow-word-reveal.excalidraw");
    const state = buildLuminaGameState(elements, arrayToMap(elements), {
      luminaEnabled: true,
      luminaAmbient: 0.5,
      luminaCaustics: true,
      luminaGameMode: { style: "shadow-reveal", phase: "play" },
    })!;
    const model = getLuminaShadowRenderModel(state);
    expect(model.requiredShadowTargetIds).toEqual(["shadow-target"]);
    expect(model.targets).toHaveLength(1);
    expect(Number.isFinite(model.targets[0].score)).toBe(true);
    expect(model.targets[0].actual.cells.length).toBeGreaterThan(0);
  });

  it("dark-room-treasure restores two required and one optional treasure", () => {
    const elements = loadSample("dark-room-treasure.excalidraw");
    const state = buildLuminaGameState(elements, arrayToMap(elements), {
      luminaEnabled: true,
      luminaAmbient: 0.16,
      luminaCaustics: true,
      luminaGameMode: { style: "dark-room", phase: "play" },
    })!;
    const model = getLuminaDarkRoomRenderModel(state);
    expect(model.treasures).toHaveLength(3);
    expect(model.requiredTreasureIds).toEqual([
      "dark-treasure-a",
      "dark-treasure-b",
    ]);
    expect(
      model.treasures.find((item) => item.id === "dark-treasure-optional")
        ?.required,
    ).toBe(false);
  });
});
