import { API } from "@excalidraw/excalidraw/tests/helpers/api";

import { duplicateElements } from "../src/duplicate";
import {
  clearLineToneData,
  getLineTone,
  getLineToneData,
  isLineToneSupportedElement,
  normalizeLineToneData,
  setLineTone,
  updateLineToneCustomData,
} from "../src/lineTone";

describe("line tone data model", () => {
  it("normalizes the frozen version 1 tones", () => {
    for (const tone of [
      "certain",
      "possible",
      "blocked",
      "questioned",
    ] as const) {
      expect(normalizeLineToneData({ version: 1, tone })).toEqual({
        version: 1,
        tone,
      });
    }
  });

  it.each([
    undefined,
    null,
    "certain",
    { version: 2, tone: "certain" },
    { version: 1, tone: "unknown" },
    { version: 1 },
  ])("rejects invalid or unknown data: %j", (value) => {
    expect(normalizeLineToneData(value)).toBeNull();
  });

  it("supports lines, arrows, and elbow arrows only", () => {
    expect(
      isLineToneSupportedElement(API.createElement({ type: "line" })),
    ).toBe(true);
    expect(
      isLineToneSupportedElement(API.createElement({ type: "arrow" })),
    ).toBe(true);
    expect(
      isLineToneSupportedElement(
        API.createElement({ type: "arrow", elbowed: true }),
      ),
    ).toBe(true);
    expect(
      isLineToneSupportedElement(API.createElement({ type: "freedraw" })),
    ).toBe(false);
    expect(
      isLineToneSupportedElement(API.createElement({ type: "rectangle" })),
    ).toBe(false);
  });

  it("reads valid tone only from supported elements", () => {
    const line = API.createElement({
      type: "line",
      customData: { lineTone: { version: 1, tone: "possible" } },
    });
    const rectangle = API.createElement({
      type: "rectangle",
      customData: { lineTone: { version: 1, tone: "blocked" } },
    });

    expect(getLineTone(line)).toBe("possible");
    expect(getLineToneData(line)).toEqual({ version: 1, tone: "possible" });
    expect(getLineTone(rectangle)).toBeNull();
  });

  it("sets and clears tone without mutating style or other custom data", () => {
    const line = API.createElement({
      type: "line",
      strokeColor: "#e03131",
      strokeWidth: 4,
      strokeStyle: "dotted",
      opacity: 70,
      customData: { luminaMaterial: { material: "glass" } },
    });
    const toned = setLineTone(line, "questioned");

    expect(toned).not.toBe(line);
    expect(getLineTone(toned)).toBe("questioned");
    expect(toned.customData?.luminaMaterial).toEqual({ material: "glass" });
    expect(toned.strokeColor).toBe(line.strokeColor);
    expect(toned.strokeWidth).toBe(line.strokeWidth);
    expect(toned.strokeStyle).toBe(line.strokeStyle);
    expect(toned.opacity).toBe(line.opacity);
    expect(line.customData?.lineTone).toBeUndefined();

    const cleared = clearLineToneData(toned);
    expect(getLineTone(cleared)).toBeNull();
    expect(cleared.customData).toEqual({
      luminaMaterial: { material: "glass" },
    });
  });

  it("returns undefined when clearing the final custom data key", () => {
    expect(
      updateLineToneCustomData(
        { lineTone: { version: 1, tone: "certain" } },
        null,
      ),
    ).toBeUndefined();
  });

  it("defensively treats an invalid runtime tone as ordinary", () => {
    expect(
      updateLineToneCustomData(
        { lineTone: { version: 1, tone: "certain" } },
        "unknown" as any,
      ),
    ).toBeUndefined();
  });

  it("does not attach tone to unsupported elements", () => {
    const rectangle = API.createElement({ type: "rectangle" });
    expect(setLineTone(rectangle, "certain")).toBe(rectangle);
  });

  it("preserves tone and other custom data when duplicating elements", () => {
    const arrow = API.createElement({
      type: "arrow",
      customData: {
        lineTone: { version: 1, tone: "certain" },
        preserved: { source: "test" },
      },
    });

    const { duplicatedElements } = duplicateElements({
      type: "everything",
      elements: [arrow],
    });

    expect(duplicatedElements[0].id).not.toBe(arrow.id);
    expect(getLineTone(duplicatedElements[0])).toBe("certain");
    expect(duplicatedElements[0].customData).toEqual(arrow.customData);
    expect(duplicatedElements[0].customData).not.toBe(arrow.customData);
  });
});
