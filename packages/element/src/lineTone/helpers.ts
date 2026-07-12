import { LINE_TONES } from "./types";

import type { ExcalidrawElement } from "../types";
import type { LineTone, LineToneData } from "./types";

const LINE_TONE_SET: ReadonlySet<LineTone> = new Set(LINE_TONES);

/**
 * Normalizes untrusted persisted data. Unknown versions and tones deliberately
 * resolve to `null`, which means the ordinary line appearance.
 */
export const normalizeLineToneData = (value: unknown): LineToneData | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const data = value as Partial<LineToneData>;
  return data.version === 1 && LINE_TONE_SET.has(data.tone as LineTone)
    ? { version: 1, tone: data.tone as LineTone }
    : null;
};

/** Ordinary lines, arrows, and elbow arrows (which are arrows) support tone. */
export const isLineToneSupportedElement = (
  element: Pick<ExcalidrawElement, "type"> | null | undefined,
): boolean => element?.type === "line" || element?.type === "arrow";

export const getLineToneData = (
  element: ExcalidrawElement | null | undefined,
): LineToneData | null => {
  if (!element || !isLineToneSupportedElement(element)) {
    return null;
  }
  return normalizeLineToneData(element.customData?.lineTone);
};

export const getLineTone = (
  element: ExcalidrawElement | null | undefined,
): LineTone | null => getLineToneData(element)?.tone ?? null;

/**
 * Returns a fresh `customData` value suitable for an element update patch.
 * Other extension data is preserved; clearing the final key returns undefined.
 */
export const updateLineToneCustomData = (
  customData: ExcalidrawElement["customData"],
  tone: LineTone | null,
): ExcalidrawElement["customData"] => {
  if (tone !== null && LINE_TONE_SET.has(tone)) {
    return {
      ...customData,
      lineTone: { version: 1 as const, tone },
    };
  }

  if (!customData || !("lineTone" in customData)) {
    return customData;
  }

  const { lineTone: _lineTone, ...rest } = customData;
  return Object.keys(rest).length ? rest : undefined;
};

/** Pure helper; callers remain responsible for normal element version bumps. */
export const setLineTone = <T extends ExcalidrawElement>(
  element: T,
  tone: LineTone | null,
): T => {
  if (!isLineToneSupportedElement(element)) {
    return element;
  }

  const customData = updateLineToneCustomData(element.customData, tone);
  if (customData === element.customData) {
    return element;
  }
  return { ...element, customData };
};

export const clearLineToneData = <T extends ExcalidrawElement>(
  element: T,
): T => {
  const customData = updateLineToneCustomData(element.customData, null);
  return customData === element.customData
    ? element
    : { ...element, customData };
};
