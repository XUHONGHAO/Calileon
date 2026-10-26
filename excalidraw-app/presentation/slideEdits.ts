import {
  generateKeyBetween,
  generateNKeysBetween,
} from "@excalidraw/fractional-indexing";
import { newElementWith } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import {
  SLIDE_NOTES_MAX_LENGTH,
  getSlideData,
  isSameSlideData,
  updateSlideCustomData,
} from "./slideData";
import { getSlides } from "./slides";

import type { SlideData } from "./slideData";

/**
 * Pure scene edits for the presentation panel. Each returns the next element
 * array, or `null` when nothing changed, so the caller makes exactly one
 * undoable `updateScene` per user action.
 */

const replaceElements = (
  elements: readonly ExcalidrawElement[],
  updates: ReadonlyMap<
    string,
    (element: ExcalidrawElement) => ExcalidrawElement
  >,
) => {
  let changed = false;
  const next = elements.map((element) => {
    const update = updates.get(element.id);
    if (!update) {
      return element;
    }
    const result = update(element);
    changed ||= result !== element;
    return result;
  });
  return changed ? next : null;
};

const withSlideData = (element: ExcalidrawElement, data: SlideData) => {
  if (isSameSlideData(getSlideData(element), data)) {
    return element;
  }
  return newElementWith(
    element,
    { customData: updateSlideCustomData(element.customData, data) },
    // `customData: undefined` (last key removed) must still be written
    true,
  );
};

export const updateSlide = (
  elements: readonly ExcalidrawElement[],
  frameId: string,
  patch: Partial<SlideData>,
) =>
  replaceElements(
    elements,
    new Map([
      [
        frameId,
        (element) =>
          element.type === "frame" && !element.isDeleted
            ? withSlideData(element, { ...getSlideData(element), ...patch })
            : element,
      ],
    ]),
  );

export const setSlideNotes = (
  elements: readonly ExcalidrawElement[],
  frameId: string,
  notes: string,
) =>
  updateSlide(elements, frameId, {
    notes: notes.slice(0, SLIDE_NOTES_MAX_LENGTH) || undefined,
  });

export const setSlideHidden = (
  elements: readonly ExcalidrawElement[],
  frameId: string,
  hidden: boolean,
) => updateSlide(elements, frameId, { hidden: hidden || undefined });

/** Writes the frame's `name` (the same field the canvas label edits). */
export const renameSlide = (
  elements: readonly ExcalidrawElement[],
  frameId: string,
  name: string,
) => {
  const nextName = name.trim() || null;
  return replaceElements(
    elements,
    new Map([
      [
        frameId,
        (element) =>
          element.type === "frame" &&
          !element.isDeleted &&
          element.name !== nextName
            ? newElementWith(element, { name: nextName })
            : element,
      ],
    ]),
  );
};

/**
 * Moves one slide to `toIndex` of the full list. The first manual move (or a
 * list with keyless / colliding keys) writes keys for every slide in the
 * current display order; afterwards only the moved slide gets a new key.
 */
export const moveSlide = (
  elements: readonly ExcalidrawElement[],
  frameId: string,
  toIndex: number,
) => {
  const slides = getSlides(elements);
  const from = slides.findIndex((slide) => slide.frame.id === frameId);
  if (from === -1) {
    return null;
  }
  const to = Math.max(0, Math.min(slides.length - 1, toIndex));
  if (to === from) {
    return null;
  }
  const reordered = [...slides];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved);

  const keys = reordered.map((slide) => slide.data.order);
  const rest = keys.filter((_, index) => index !== to);
  const canMoveOne =
    rest.every(Boolean) &&
    rest.every((key, index) => index === 0 || rest[index - 1]! < key!);

  const updates = new Map<
    string,
    (element: ExcalidrawElement) => ExcalidrawElement
  >();
  if (canMoveOne) {
    const order = generateKeyBetween(
      keys[to - 1] ?? null,
      keys[to + 1] ?? null,
    );
    updates.set(moved.frame.id, (element) =>
      withSlideData(element, { ...getSlideData(element), order }),
    );
  } else {
    const fresh = generateNKeysBetween(null, null, reordered.length);
    reordered.forEach((slide, index) => {
      updates.set(slide.frame.id, (element) =>
        withSlideData(element, {
          ...getSlideData(element),
          order: fresh[index],
        }),
      );
    });
  }
  return replaceElements(elements, updates);
};

/** "Reorder by position": drops every manual key. */
export const resetSlideOrder = (elements: readonly ExcalidrawElement[]) => {
  const updates = new Map<
    string,
    (element: ExcalidrawElement) => ExcalidrawElement
  >();
  for (const slide of getSlides(elements)) {
    if (slide.data.order) {
      updates.set(slide.frame.id, (element) =>
        withSlideData(element, { ...getSlideData(element), order: undefined }),
      );
    }
  }
  return updates.size ? replaceElements(elements, updates) : null;
};
