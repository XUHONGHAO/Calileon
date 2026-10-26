import { t } from "@excalidraw/excalidraw/i18n";

import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
} from "@excalidraw/element/types";
import type { AppState } from "@excalidraw/excalidraw/types";

import { getSlideData } from "./slideData";

import type { SlideData } from "./slideData";

export type Slide = {
  frame: ExcalidrawFrameElement;
  /** 1-based position in the full list; hidden slides keep their number */
  number: number;
  data: SlideData;
};

const compareIds = (a: { id: string }, b: { id: string }) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Same row: tops differ by less than half of the shorter frame (ADR 0036 §2). */
const isSameRow = (
  anchor: ExcalidrawFrameElement,
  frame: ExcalidrawFrameElement,
) => Math.abs(frame.y - anchor.y) < Math.min(anchor.height, frame.height) / 2;

const sortByPosition = (frames: ExcalidrawFrameElement[]) => {
  const byTop = [...frames].sort(
    (a, b) => a.y - b.y || a.x - b.x || compareIds(a, b),
  );
  const rows: ExcalidrawFrameElement[][] = [];
  for (const frame of byTop) {
    const row = rows[rows.length - 1];
    if (row && isSameRow(row[0], frame)) {
      row.push(frame);
    } else {
      rows.push([frame]);
    }
  }
  return rows.flatMap((row) =>
    row.sort((a, b) => a.x - b.x || a.y - b.y || compareIds(a, b)),
  );
};

/**
 * Every non-deleted `frame` is a slide; `magicframe` is not (Q1). Manually
 * ordered slides come first, the rest follow in reading order.
 */
export const getSlides = (elements: readonly ExcalidrawElement[]): Slide[] => {
  const ordered: { frame: ExcalidrawFrameElement; data: SlideData }[] = [];
  const unordered: ExcalidrawFrameElement[] = [];
  const dataById = new Map<string, SlideData>();
  for (const element of elements) {
    if (element.type !== "frame" || element.isDeleted) {
      continue;
    }
    const data = getSlideData(element);
    dataById.set(element.id, data);
    if (data.order) {
      ordered.push({ frame: element, data });
    } else {
      unordered.push(element);
    }
  }
  ordered.sort((a, b) =>
    a.data.order! < b.data.order!
      ? -1
      : a.data.order! > b.data.order!
      ? 1
      : compareIds(a.frame, b.frame),
  );
  return [
    ...ordered.map(({ frame }) => frame),
    ...sortByPosition(unordered),
  ].map((frame, index) => ({
    frame,
    number: index + 1,
    data: dataById.get(frame.id)!,
  }));
};

export const getPlayableSlides = (slides: readonly Slide[]) =>
  slides.filter((slide) => !slide.data.hidden);

export const hasManualOrder = (slides: readonly Slide[]) =>
  slides.some((slide) => !!slide.data.order);

/** The frame's own name, or "Slide N" (never the editor's English "Frame"). */
export const getSlideTitle = (slide: Slide) =>
  slide.frame.name?.trim() ||
  t("ai.presentation.untitledSlide", { number: slide.number });

const containsPoint = (frame: ExcalidrawFrameElement, x: number, y: number) =>
  x >= frame.x &&
  x <= frame.x + frame.width &&
  y >= frame.y &&
  y <= frame.y + frame.height;

const distanceToFrame = (
  frame: ExcalidrawFrameElement,
  x: number,
  y: number,
) => {
  const dx = Math.max(frame.x - x, 0, x - (frame.x + frame.width));
  const dy = Math.max(frame.y - y, 0, y - (frame.y + frame.height));
  return Math.hypot(dx, dy);
};

/**
 * "Current" slide for "play from here": the selected frame (or the frame of a
 * selected element), else the frame under the viewport centre, else the
 * nearest one.
 */
export const getCurrentSlideId = (
  slides: readonly Slide[],
  elements: readonly ExcalidrawElement[],
  appState: Pick<
    AppState,
    "selectedElementIds" | "scrollX" | "scrollY" | "zoom" | "width" | "height"
  >,
): string | null => {
  if (!slides.length) {
    return null;
  }
  const slideIds = new Set(slides.map((slide) => slide.frame.id));
  for (const element of elements) {
    if (!appState.selectedElementIds[element.id] || element.isDeleted) {
      continue;
    }
    if (slideIds.has(element.id)) {
      return element.id;
    }
    if (element.frameId && slideIds.has(element.frameId)) {
      return element.frameId;
    }
  }
  const zoom = appState.zoom.value;
  const centerX = appState.width / 2 / zoom - appState.scrollX;
  const centerY = appState.height / 2 / zoom - appState.scrollY;
  const containing = slides.find((slide) =>
    containsPoint(slide.frame, centerX, centerY),
  );
  if (containing) {
    return containing.frame.id;
  }
  let nearest = slides[0];
  let nearestDistance = Infinity;
  for (const slide of slides) {
    const distance = distanceToFrame(slide.frame, centerX, centerY);
    if (distance < nearestDistance) {
      nearest = slide;
      nearestDistance = distance;
    }
  }
  return nearest.frame.id;
};

/**
 * Where the slideshow starts for a requested slide: itself, or the first
 * playable slide after it when it is hidden, else the first playable one.
 */
export const getPlayableStartIndex = (
  slides: readonly Slide[],
  frameId: string | null,
) => {
  const playable = getPlayableSlides(slides);
  if (!playable.length) {
    return -1;
  }
  if (!frameId) {
    return 0;
  }
  const at = slides.findIndex((slide) => slide.frame.id === frameId);
  if (at === -1) {
    return 0;
  }
  const next = slides.slice(at).find((slide) => !slide.data.hidden);
  return next ? playable.indexOf(next) : 0;
};
