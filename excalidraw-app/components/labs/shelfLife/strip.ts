import { useSyncExternalStore } from "react";
import {
  CaptureUpdateAction,
  getShelfLifeData,
  getShelfLifeRoot,
  setShelfLifeVisualsEnabled,
  SHELF_LIFE_DAY,
} from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

export type ShelfLifeEntry = {
  id: string;
  /** The rectangle's bound text, first line; empty when it has none. */
  text: string;
  expiresAt: number;
  state: "expired" | "due" | "fresh";
};

const LABEL_MAX = 14;

const firstLine = (value: string) => {
  const line = value.trim().split(/\r?\n/)[0]?.trim() ?? "";
  return line.length > LABEL_MAX ? `${line.slice(0, LABEL_MAX - 1)}…` : line;
};

/** Every note with a shelf life, soonest deadline first (expired lead). */
export const getShelfLifeEntries = (
  elements: readonly ExcalidrawElement[],
  now = Date.now(),
): ShelfLifeEntry[] => {
  const map = new Map(elements.map((el) => [el.id, el]));
  const boundText = new Map<string, string>();
  for (const el of elements) {
    if (!el.isDeleted && el.type === "text" && el.containerId) {
      boundText.set(el.containerId, el.text);
    }
  }
  const entries: ShelfLifeEntry[] = [];
  for (const el of elements) {
    const data = getShelfLifeData(el);
    if (!data || el.isDeleted || getShelfLifeRoot(el, map) !== el) {
      continue;
    }
    const left = data.expiresAt - now;
    entries.push({
      id: el.id,
      text: firstLine(boundText.get(el.id) ?? ""),
      expiresAt: data.expiresAt,
      state: left <= 0 ? "expired" : left <= SHELF_LIFE_DAY ? "due" : "fresh",
    });
  }
  return entries.sort(
    (a, b) => a.expiresAt - b.expiresAt || a.id.localeCompare(b.id),
  );
};

// ------------------------------------------------------------ preference
// One app-only preference shared by the strip and the panel. "hidden" turns
// the strip off entirely; "collapsed" keeps only its toggle button.

export type ShelfLifeStripMode = "open" | "collapsed" | "hidden";
const STORAGE_KEY = "calileon-shelf-life-strip";
const listeners = new Set<() => void>();

const read = (): ShelfLifeStripMode => {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "collapsed" || value === "hidden" ? value : "open";
  } catch {
    return "open";
  }
};
let mode = read();

export const setShelfLifeStripMode = (next: ShelfLifeStripMode) => {
  mode = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // storage unavailable: keep the in-memory choice for this session
  }
  listeners.forEach((listener) => listener());
};

export const useShelfLifeStripMode = () =>
  useSyncExternalStore(subscribe, () => mode);

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---------------------------------------------------- canvas visuals switch
// Local view preference: hides tint, fading and badges on this device only.
// Deadlines stay stored and synced; the strip keeps listing them.

const VISUALS_KEY = "calileon-shelf-life-visuals";
const readVisuals = () => {
  try {
    return localStorage.getItem(VISUALS_KEY) !== "off";
  } catch {
    return true;
  }
};
let visuals = readVisuals();
setShelfLifeVisualsEnabled(visuals);

export const setShelfLifeVisuals = (
  next: boolean,
  api?: ExcalidrawImperativeAPI | null,
) => {
  visuals = next;
  setShelfLifeVisualsEnabled(next);
  try {
    localStorage.setItem(VISUALS_KEY, next ? "on" : "off");
  } catch {
    // storage unavailable: keep the in-memory choice for this session
  }
  listeners.forEach((listener) => listener());
  // Same elements, same versions: only a repaint (collab/save see no change).
  api?.updateScene({
    elements: api.getSceneElementsIncludingDeleted(),
    captureUpdate: CaptureUpdateAction.NEVER,
  });
};

export const useShelfLifeVisuals = () =>
  useSyncExternalStore(subscribe, () => visuals);
