import { validateOrderKey } from "@excalidraw/fractional-indexing";

import type { ExcalidrawElement } from "@excalidraw/element/types";

/** Speaker-notes limit (ADR 0036 Q5). */
export const SLIDE_NOTES_MAX_LENGTH = 4000;

/**
 * Per-slide data, stored on the frame as `customData.slide` (ADR 0036 §1) so
 * collaboration, cloud, single-file, local storage and Vault v2 carry it
 * without any sync change.
 */
export type SlideData = {
  /** manual order key (fractional index); missing = ordered by position */
  order?: string;
  /** speaker notes, plain text */
  notes?: string;
  /** skipped by the slideshow and the PDF export, still listed (Q2) */
  hidden?: boolean;
};

const isValidOrderKey = (value: unknown): value is string => {
  if (typeof value !== "string" || !value) {
    return false;
  }
  try {
    validateOrderKey(value);
    return true;
  } catch {
    return false;
  }
};

/** Lenient read: wrong types are dropped, notes are capped. */
export const getSlideData = (element: ExcalidrawElement): SlideData => {
  if (element.type !== "frame") {
    return {};
  }
  const raw = element.customData?.slide;
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const data: SlideData = {};
  if (isValidOrderKey(raw.order)) {
    data.order = raw.order;
  }
  if (typeof raw.notes === "string" && raw.notes) {
    data.notes = raw.notes.slice(0, SLIDE_NOTES_MAX_LENGTH);
  }
  if (raw.hidden === true) {
    data.hidden = true;
  }
  return data;
};

/** Only valid, non-empty fields are written; an empty object removes the key. */
export const normalizeSlideData = (data: SlideData): SlideData | null => {
  const next: SlideData = {};
  if (isValidOrderKey(data.order)) {
    next.order = data.order;
  }
  if (typeof data.notes === "string" && data.notes) {
    next.notes = data.notes.slice(0, SLIDE_NOTES_MAX_LENGTH);
  }
  if (data.hidden === true) {
    next.hidden = true;
  }
  return Object.keys(next).length ? next : null;
};

export const updateSlideCustomData = (
  customData: ExcalidrawElement["customData"],
  data: SlideData,
): ExcalidrawElement["customData"] => {
  const slide = normalizeSlideData(data);
  if (slide) {
    return { ...customData, slide };
  }
  if (!customData || !("slide" in customData)) {
    return customData;
  }
  const { slide: _, ...rest } = customData;
  return Object.keys(rest).length ? rest : undefined;
};

export const isSameSlideData = (a: SlideData, b: SlideData) =>
  a.order === b.order &&
  (a.notes ?? "") === (b.notes ?? "") &&
  !!a.hidden === !!b.hidden;
