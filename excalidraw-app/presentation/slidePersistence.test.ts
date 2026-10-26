import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";

import { createSingleFilePayload } from "../single-file/payload";
import { byId, seeded, withId } from "../data/vault/v2/testUtils";

import { getSlideData } from "./slideData";
import { getSlides } from "./slides";
import { makeFrame } from "./testUtils";

// ADR 0036 §1: slide data lives in frame customData, so every existing
// persistence path carries it without changes. These guard that assumption.
const slide = { order: "a0", notes: "备注 · notes", hidden: true };
const frame = () =>
  withId(
    {
      ...makeFrame({ id: "frame-1", name: "Intro", slide }),
      customData: { slide, other: "kept" },
    },
    "frame-1",
    "a0",
  );

describe("slide data persistence", () => {
  it("survives restore and the .excalidraw JSON round trip", () => {
    const json = serializeAsJSON([frame()], {}, {}, "local");
    const [restored] = restoreElements(JSON.parse(json).elements, null);
    expect(restored.customData).toEqual({ slide, other: "kept" });
    expect(getSlideData(restored)).toEqual(slide);
    expect(getSlides([restored])[0].frame.name).toBe("Intro");
  });

  it("is part of the single-file payload", () => {
    const payload = createSingleFilePayload({
      elements: [frame()],
      appState: {},
      files: {},
      name: "deck",
      generatorVersion: "test",
    });
    const [restored] = restoreElements(
      JSON.parse(JSON.stringify(payload)).scene.elements,
      null,
    );
    expect(getSlideData(restored)).toEqual(slide);
  });

  it("converges through the Vault v2 scene document", () => {
    const { materializer } = seeded("actor-a", [frame()]);
    const element = byId(materializer.materialize().elements, "frame-1")!;
    expect(element.customData).toEqual({ slide, other: "kept" });
    expect(element.name).toBe("Intro");
  });
});
