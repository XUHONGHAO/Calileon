import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

import type { CastAppStateSnapshot, CastSceneSnapshot } from "./types";

const APP_STATE_KEYS = [
  "scrollX",
  "scrollY",
  "zoom",
  "viewBackgroundColor",
  "theme",
  "gridSize",
  "gridStep",
  "gridModeEnabled",
  "zenModeEnabled",
  "viewModeEnabled",
  "luminaEnabled",
  "luminaAmbient",
  "luminaCaustics",
] as const;

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const zoomValue = (value: unknown): number => {
  if (typeof value === "number") {
    return value;
  }
  if (value && typeof value === "object" && "value" in value) {
    const nested = (value as { value?: unknown }).value;
    return typeof nested === "number" ? nested : 1;
  }
  return 1;
};

export const normalizeCastAppState = (
  appState: Record<string, unknown>,
): CastAppStateSnapshot => {
  const normalized: Record<string, unknown> = {};
  for (const key of APP_STATE_KEYS) {
    if (key in appState && appState[key] !== undefined) {
      normalized[key] =
        key === "zoom" ? zoomValue(appState[key]) : cloneJson(appState[key]);
    }
  }
  normalized.scrollX =
    typeof normalized.scrollX === "number" ? normalized.scrollX : 0;
  normalized.scrollY =
    typeof normalized.scrollY === "number" ? normalized.scrollY : 0;
  normalized.zoom = zoomValue(normalized.zoom);
  delete normalized.luminaGameMode;
  return normalized as CastAppStateSnapshot;
};

export const sanitizeCastElement = <T extends ExcalidrawElement>(
  element: T,
): T => {
  const sanitized = cloneJson(element) as T & {
    customData?: Record<string, unknown>;
  };
  if (sanitized.customData) {
    delete sanitized.customData.luminaGame;
    if (Object.keys(sanitized.customData).length === 0) {
      delete sanitized.customData;
    }
  }
  return sanitized;
};

export const sanitizeCastFiles = (files: BinaryFiles): BinaryFiles =>
  cloneJson(files);

export const sanitizeCastSnapshot = (snapshot: CastSceneSnapshot) => ({
  elements: snapshot.elements.map(sanitizeCastElement),
  appState: normalizeCastAppState(snapshot.appState),
  files: sanitizeCastFiles(snapshot.files),
});

export const cloneCastValue = cloneJson;
