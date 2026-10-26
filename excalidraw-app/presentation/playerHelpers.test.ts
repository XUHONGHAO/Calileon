import { MAX_ZOOM, MIN_ZOOM } from "@excalidraw/common";

import type { NormalizedZoomValue } from "@excalidraw/excalidraw/types";

import {
  formatElapsed,
  getFitZoom,
  getFrameScreenRect,
  getPresentationKeyAction,
  getTimerElapsed,
  resetTimer,
  toggleTimer,
} from "./playerHelpers";
import { makeFrame } from "./testUtils";

const key = (value: string, modifiers: Partial<KeyboardEvent> = {}) => ({
  key: value,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...modifiers,
});

describe("slideshow keys (ADR 0036 §3)", () => {
  it("maps keyboard and clicker keys", () => {
    for (const value of ["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"]) {
      expect(getPresentationKeyAction(key(value))).toBe("next");
    }
    for (const value of ["n", "N"]) {
      expect(getPresentationKeyAction(key(value))).toBe("next");
    }
    for (const value of ["ArrowLeft", "ArrowUp", "PageUp", "Backspace", "p"]) {
      expect(getPresentationKeyAction(key(value))).toBe("prev");
    }
    expect(getPresentationKeyAction(key("Home"))).toBe("first");
    expect(getPresentationKeyAction(key("End"))).toBe("last");
    expect(getPresentationKeyAction(key("L"))).toBe("laser");
    expect(getPresentationKeyAction(key("Escape"))).toBe("exit");
  });

  it("leaves other keys and browser shortcuts alone", () => {
    expect(getPresentationKeyAction(key("r"))).toBeNull();
    expect(getPresentationKeyAction(key("1"))).toBeNull();
    expect(
      getPresentationKeyAction(key("ArrowRight", { ctrlKey: true })),
    ).toBeNull();
    expect(getPresentationKeyAction(key("p", { metaKey: true }))).toBeNull();
    expect(getPresentationKeyAction(key("n", { altKey: true }))).toBeNull();
  });
});

describe("camera helpers", () => {
  it("fits the frame along its tighter axis (R4: no 0.1 rounding)", () => {
    const wide = makeFrame({ id: "wide", width: 1600, height: 900 });
    expect(getFitZoom(wide, { width: 1280, height: 800 })).toBeCloseTo(0.8);
    const tall = makeFrame({ id: "tall", width: 400, height: 1000 });
    expect(getFitZoom(tall, { width: 1280, height: 800 })).toBeCloseTo(0.8);
    const odd = makeFrame({ id: "odd", width: 333, height: 100 });
    expect(getFitZoom(odd, { width: 1000, height: 1000 })).toBeCloseTo(
      1000 / 333,
    );
  });

  it("clamps to the editor's zoom range", () => {
    const tiny = makeFrame({ id: "tiny", width: 1, height: 1 });
    expect(getFitZoom(tiny, { width: 1280, height: 800 })).toBe(MAX_ZOOM);
    const huge = makeFrame({ id: "huge", width: 1e7, height: 1e7 });
    expect(getFitZoom(huge, { width: 1280, height: 800 })).toBe(MIN_ZOOM);
  });

  it("projects a frame to screen coordinates", () => {
    const frame = makeFrame({
      id: "f",
      x: 100,
      y: 50,
      width: 200,
      height: 100,
    });
    expect(
      getFrameScreenRect(frame, {
        scrollX: -50,
        scrollY: 10,
        zoom: { value: 2 as NormalizedZoomValue },
        offsetLeft: 5,
        offsetTop: 7,
      }),
    ).toEqual({ x: 105, y: 127, width: 400, height: 200 });
  });
});

describe("presenter timer", () => {
  it("formats elapsed time", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(-5)).toBe("0:00");
    expect(formatElapsed(61_999)).toBe("1:01");
    expect(formatElapsed(10 * 60_000)).toBe("10:00");
    expect(formatElapsed(3_600_000 + 5 * 60_000 + 7_000)).toBe("1:05:07");
  });

  it("pauses, resumes and resets", () => {
    let timer = { startedAt: 1000, pausedAt: null as number | null };
    expect(getTimerElapsed(timer, 4000)).toBe(3000);
    timer = toggleTimer(timer, 4000);
    expect(getTimerElapsed(timer, 9000)).toBe(3000);
    timer = toggleTimer(timer, 9000);
    expect(timer.pausedAt).toBeNull();
    expect(getTimerElapsed(timer, 10_000)).toBe(4000);
    timer = resetTimer(timer, 10_000);
    expect(getTimerElapsed(timer, 10_500)).toBe(500);
    const paused = resetTimer(toggleTimer(timer, 11_000), 12_000);
    expect(getTimerElapsed(paused, 20_000)).toBe(0);
  });
});
