import { newElement, newFrameElement } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import {
  SLIDE_NOTES_MAX_LENGTH,
  getSlideData,
  isSameSlideData,
  normalizeSlideData,
  updateSlideCustomData,
} from "./slideData";

const frame = (customData?: ExcalidrawElement["customData"]) => ({
  ...newFrameElement({ x: 0, y: 0, width: 160, height: 90 }),
  customData,
});

describe("slide data (ADR 0036 §1)", () => {
  it("reads slide data only from frames", () => {
    const rectangle = {
      ...newElement({ type: "rectangle", x: 0, y: 0, width: 1, height: 1 }),
      customData: { slide: { notes: "not a slide" } },
    };
    expect(getSlideData(rectangle)).toEqual({});
    expect(getSlideData(frame())).toEqual({});
    expect(getSlideData(frame({ slide: "nope" }))).toEqual({});
  });

  it("drops malformed fields and caps notes", () => {
    expect(
      getSlideData(
        frame({
          slide: { order: "not a key", notes: 42, hidden: "yes" },
        }),
      ),
    ).toEqual({});
    const long = "x".repeat(SLIDE_NOTES_MAX_LENGTH + 10);
    expect(
      getSlideData(
        frame({ slide: { order: "a0", notes: long, hidden: true } }),
      ),
    ).toEqual({
      order: "a0",
      notes: "x".repeat(SLIDE_NOTES_MAX_LENGTH),
      hidden: true,
    });
  });

  it("normalizes to null when nothing is left", () => {
    expect(normalizeSlideData({ notes: "", hidden: false })).toBeNull();
    expect(normalizeSlideData({ order: "a1", notes: "hi" })).toEqual({
      order: "a1",
      notes: "hi",
    });
  });

  it("keeps unrelated customData and removes an empty slide key", () => {
    expect(updateSlideCustomData({ other: 1 }, { notes: "hello" })).toEqual({
      other: 1,
      slide: { notes: "hello" },
    });
    expect(
      updateSlideCustomData({ other: 1, slide: { notes: "x" } }, {}),
    ).toEqual({ other: 1 });
    expect(updateSlideCustomData({ slide: { hidden: true } }, {})).toBe(
      undefined,
    );
    const untouched = { other: 1 };
    expect(updateSlideCustomData(untouched, {})).toBe(untouched);
    expect(updateSlideCustomData(undefined, {})).toBeUndefined();
  });

  it("compares slide data by value", () => {
    expect(isSameSlideData({}, { notes: "", hidden: false })).toBe(true);
    expect(isSameSlideData({ order: "a0" }, { order: "a1" })).toBe(false);
    expect(isSameSlideData({ hidden: true }, {})).toBe(false);
  });
});
