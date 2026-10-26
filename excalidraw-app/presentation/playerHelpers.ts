import { MAX_ZOOM, MIN_ZOOM } from "@excalidraw/common";

import type { ExcalidrawFrameElement } from "@excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";

export type PresentationKeyAction =
  | "next"
  | "prev"
  | "first"
  | "last"
  | "laser"
  | "exit";

/** Slideshow keys (ADR 0036 §3); clickers send PageUp / PageDown. */
export const getPresentationKeyAction = (event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): PresentationKeyAction | null => {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return null;
  }
  switch (event.key) {
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
    case " ":
    case "Enter":
    case "n":
    case "N":
      return "next";
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
    case "Backspace":
    case "p":
    case "P":
      return "prev";
    case "Home":
      return "first";
    case "End":
      return "last";
    case "l":
    case "L":
      return "laser";
    case "Escape":
      return "exit";
    default:
      return null;
  }
};

type Viewport = Pick<AppState, "width" | "height">;

/**
 * Zoom that makes the frame exactly fill the viewport along its tighter axis.
 * Passed to `scrollToContent` as both `minZoom` and `maxZoom`, which bypasses
 * the editor's 0.1-step rounding (ADR 0036 R4).
 */
export const getFitZoom = (frame: ExcalidrawFrameElement, viewport: Viewport) =>
  Math.min(
    MAX_ZOOM,
    Math.max(
      MIN_ZOOM,
      Math.min(
        viewport.width / Math.max(frame.width, 1),
        viewport.height / Math.max(frame.height, 1),
      ),
    ),
  );

export type ScreenRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export const getFrameScreenRect = (
  frame: ExcalidrawFrameElement,
  appState: Pick<
    AppState,
    "scrollX" | "scrollY" | "zoom" | "offsetLeft" | "offsetTop"
  >,
): ScreenRect => {
  const zoom = appState.zoom.value;
  return {
    x: (frame.x + appState.scrollX) * zoom + appState.offsetLeft,
    y: (frame.y + appState.scrollY) * zoom + appState.offsetTop,
    width: frame.width * zoom,
    height: frame.height * zoom,
  };
};

/** "mm:ss", or "h:mm:ss" past an hour. */
export const formatElapsed = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mmss = `${String(minutes).padStart(hours ? 2 : 1, "0")}:${String(
    seconds,
  ).padStart(2, "0")}`;
  return hours ? `${hours}:${mmss}` : mmss;
};

export const prefersReducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export type PresentationTimer = {
  startedAt: number;
  /** when paused, the moment it was paused */
  pausedAt: number | null;
};

export const getTimerElapsed = (timer: PresentationTimer, now: number) =>
  (timer.pausedAt ?? now) - timer.startedAt;

export const toggleTimer = (
  timer: PresentationTimer,
  now: number,
): PresentationTimer =>
  timer.pausedAt === null
    ? { ...timer, pausedAt: now }
    : { startedAt: timer.startedAt + (now - timer.pausedAt), pausedAt: null };

export const resetTimer = (
  timer: PresentationTimer,
  now: number,
): PresentationTimer => ({
  startedAt: now,
  pausedAt: timer.pausedAt === null ? null : now,
});
