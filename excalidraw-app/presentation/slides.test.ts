import { newMagicFrameElement } from "@excalidraw/element";

import type { NormalizedZoomValue } from "@excalidraw/excalidraw/types";

import {
  getCurrentSlideId,
  getPlayableSlides,
  getPlayableStartIndex,
  getSlideTitle,
  getSlides,
  hasManualOrder,
} from "./slides";
import { ids, makeChild, makeFrame } from "./testUtils";

const viewport = (
  overrides: Partial<{
    selectedElementIds: Record<string, true>;
    scrollX: number;
    scrollY: number;
    zoom: number;
  }> = {},
) => ({
  selectedElementIds: overrides.selectedElementIds ?? {},
  scrollX: overrides.scrollX ?? 0,
  scrollY: overrides.scrollY ?? 0,
  zoom: { value: (overrides.zoom ?? 1) as NormalizedZoomValue },
  width: 1000,
  height: 600,
});

describe("getSlides (ADR 0036 §2)", () => {
  it("lists non-deleted frames only; magic frames are not slides", () => {
    const slides = getSlides([
      makeFrame({ id: "a" }),
      makeFrame({ id: "gone", x: 500, isDeleted: true }),
      { ...newMagicFrameElement({ x: 900, y: 0, width: 50, height: 50 }) },
      makeChild("child", "a"),
    ]);
    expect(ids(slides)).toEqual(["a"]);
    expect(slides[0].number).toBe(1);
  });

  it("orders by rows, then left to right", () => {
    // b's top is within half a frame height of a's: same row
    const slides = getSlides([
      makeFrame({ id: "row2-right", x: 400, y: 300 }),
      makeFrame({ id: "row1-right", x: 400, y: 30 }),
      makeFrame({ id: "row2-left", x: 0, y: 320 }),
      makeFrame({ id: "row1-left", x: 0, y: 0 }),
    ]);
    expect(ids(slides)).toEqual([
      "row1-left",
      "row1-right",
      "row2-left",
      "row2-right",
    ]);
  });

  it("starts a new row once the top moves by half of the shorter frame", () => {
    const slides = getSlides([
      makeFrame({ id: "low", x: 0, y: 46 }),
      makeFrame({ id: "high", x: 400, y: 0 }),
    ]);
    expect(ids(slides)).toEqual(["high", "low"]);
  });

  it("puts manually ordered slides first, by key, then the rest by position", () => {
    const slides = getSlides([
      makeFrame({ id: "free-right", x: 400 }),
      makeFrame({ id: "second", x: 0, slide: { order: "a1" } }),
      makeFrame({ id: "free-left", x: 0, y: 500 }),
      makeFrame({ id: "first", x: 800, slide: { order: "a0" } }),
    ]);
    expect(ids(slides)).toEqual(["first", "second", "free-right", "free-left"]);
    expect(slides.map((slide) => slide.number)).toEqual([1, 2, 3, 4]);
    expect(hasManualOrder(slides)).toBe(true);
    expect(hasManualOrder(getSlides([makeFrame({ id: "x" })]))).toBe(false);
  });

  it("breaks key ties by id so every client agrees", () => {
    const slides = getSlides([
      makeFrame({ id: "b", slide: { order: "a0" } }),
      makeFrame({ id: "a", slide: { order: "a0" } }),
    ]);
    expect(ids(slides)).toEqual(["a", "b"]);
  });

  it("keeps hidden slides in the list and numbering, but not in the playable list", () => {
    const slides = getSlides([
      makeFrame({ id: "a", x: 0 }),
      makeFrame({ id: "b", x: 400, slide: { hidden: true } }),
      makeFrame({ id: "c", x: 800 }),
    ]);
    expect(slides.map((slide) => slide.number)).toEqual([1, 2, 3]);
    expect(ids(getPlayableSlides(slides))).toEqual(["a", "c"]);
  });
});

describe("getSlideTitle", () => {
  it("uses the frame name, else a numbered fallback", () => {
    const [named, unnamed, blank] = getSlides([
      makeFrame({ id: "a", x: 0, name: "  Intro  " }),
      makeFrame({ id: "b", x: 400 }),
      makeFrame({ id: "c", x: 800, name: "   " }),
    ]);
    expect(getSlideTitle(named)).toBe("Intro");
    expect(getSlideTitle(unnamed)).toBe("Slide 2");
    expect(getSlideTitle(blank)).toBe("Slide 3");
  });
});

describe("getCurrentSlideId", () => {
  const elements = [
    makeFrame({ id: "left", x: 0, y: 0, width: 400, height: 300 }),
    makeFrame({ id: "right", x: 1000, y: 0, width: 400, height: 300 }),
    makeChild("inside-right", "right", 1100, 100),
    makeChild("loose", null, 600, 600),
  ];
  const slides = getSlides(elements);

  it("prefers the selected frame, then the frame of a selected element", () => {
    expect(
      getCurrentSlideId(
        slides,
        elements,
        viewport({ selectedElementIds: { right: true } }),
      ),
    ).toBe("right");
    expect(
      getCurrentSlideId(
        slides,
        elements,
        viewport({ selectedElementIds: { "inside-right": true } }),
      ),
    ).toBe("right");
  });

  it("falls back to the frame under the viewport centre", () => {
    // centre = (500 / zoom - scrollX, 300 / zoom - scrollY)
    expect(
      getCurrentSlideId(
        slides,
        elements,
        viewport({
          selectedElementIds: { loose: true },
          scrollX: -700,
          scrollY: 150,
        }),
      ),
    ).toBe("right");
  });

  it("then to the nearest frame", () => {
    expect(
      getCurrentSlideId(slides, elements, viewport({ scrollX: 0, scrollY: 0 })),
    ).toBe("left");
    expect(
      getCurrentSlideId(slides, elements, viewport({ scrollX: -1500 })),
    ).toBe("right");
    expect(getCurrentSlideId([], elements, viewport())).toBeNull();
  });
});

describe("getPlayableStartIndex", () => {
  const slides = getSlides([
    makeFrame({ id: "a", x: 0 }),
    makeFrame({ id: "b", x: 400, slide: { hidden: true } }),
    makeFrame({ id: "c", x: 800 }),
    makeFrame({ id: "d", x: 1200, slide: { hidden: true } }),
  ]);

  it("starts at the requested slide, or the next playable one after it", () => {
    expect(getPlayableStartIndex(slides, null)).toBe(0);
    expect(getPlayableStartIndex(slides, "c")).toBe(1);
    expect(getPlayableStartIndex(slides, "b")).toBe(1);
  });

  it("falls back to the first playable slide", () => {
    expect(getPlayableStartIndex(slides, "d")).toBe(0);
    expect(getPlayableStartIndex(slides, "missing")).toBe(0);
  });

  it("returns -1 when nothing can play", () => {
    expect(
      getPlayableStartIndex(
        getSlides([makeFrame({ id: "x", slide: { hidden: true } })]),
        null,
      ),
    ).toBe(-1);
  });
});
