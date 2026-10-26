import {
  VIDEO_ELEMENT_DEFAULT_SIZE,
  VIDEO_POSTER_MAX_LENGTH,
  VIDEO_RECORDING_MAX_DURATION,
  VIDEO_RECORDING_MIN_DURATION,
} from "@excalidraw/common";
import { clamp } from "@excalidraw/math";

import type { ExcalidrawVideoElement } from "../types";

/**
 * Size of a freshly inserted video: long side VIDEO_ELEMENT_DEFAULT_SIZE,
 * aspect ratio of the recording. Only used at creation; restore never
 * recomputes geometry (ADR 0035 §2).
 */
export const getVideoElementSize = (
  naturalWidth: number,
  naturalHeight: number,
) => {
  const safeWidth =
    Number.isFinite(naturalWidth) && naturalWidth > 0 ? naturalWidth : 16;
  const safeHeight =
    Number.isFinite(naturalHeight) && naturalHeight > 0 ? naturalHeight : 9;
  const scale = VIDEO_ELEMENT_DEFAULT_SIZE / Math.max(safeWidth, safeHeight);
  return {
    width: Math.round(safeWidth * scale),
    height: Math.round(safeHeight * scale),
  };
};

/** `0:07`, `0:30` — recordings never exceed a minute. */
export const formatVideoDuration = (duration: number) => {
  const seconds = Math.max(0, Math.round(duration / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const POSTER_RE = /^data:image\/(?:webp|jpeg);base64,[A-Za-z0-9+/]+=*$/;

export const isValidVideoPoster = (poster: unknown): poster is string =>
  typeof poster === "string" &&
  poster.length <= VIDEO_POSTER_MAX_LENGTH &&
  POSTER_RE.test(poster);

export const isVideoElementPlayable = (
  element: Pick<ExcalidrawVideoElement, "fileId" | "status">,
) => !!element.fileId && element.status !== "error";

const isPositiveFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

export type RestoredVideoFields = Pick<
  ExcalidrawVideoElement,
  "source" | "duration" | "hasAudio" | "poster" | "width" | "height" | "angle"
>;

/**
 * Validates untrusted video fields. Returns null for an unknown `source` so
 * the element is dropped rather than silently rewritten (ADR 0035 §2).
 */
export const restoreVideoFields = (
  element: Record<string, unknown>,
): RestoredVideoFields | null => {
  const { source, duration, width, height } = element;
  if (source !== "camera") {
    return null;
  }
  const fallback = getVideoElementSize(16, 9);
  return {
    source,
    duration: Math.round(
      isPositiveFinite(duration)
        ? clamp(
            duration,
            VIDEO_RECORDING_MIN_DURATION,
            VIDEO_RECORDING_MAX_DURATION,
          )
        : VIDEO_RECORDING_MIN_DURATION,
    ),
    hasAudio: element.hasAudio === true,
    poster: isValidVideoPoster(element.poster) ? element.poster : null,
    // validated, never recomputed
    width: isPositiveFinite(width) ? width : fallback.width,
    height: isPositiveFinite(height) ? height : fallback.height,
    angle: 0 as ExcalidrawVideoElement["angle"],
  };
};
