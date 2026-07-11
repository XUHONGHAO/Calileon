import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { DataURL } from "@excalidraw/excalidraw/types";
import type { ExcalidrawFreeDrawElement } from "@excalidraw/element/types";

import { dataURLToFile } from "../ai/imageCanvas";

import type { AIImageEditableMask } from "../ai/types";

// Inpaint masks are drawn per canvas image and, until now, lived only in the
// in-memory workbench draft — a refresh dropped them. We persist the mask's
// base64 dataURL (the source of truth for both the preview and the rebuilt
// File) plus its freedraw strokes so an in-progress inpaint survives a reload.

const MAX_PERSISTED_MASKS = 12;
// base64 PNGs are large; keep a generous budget and trim oldest masks first.
const MAX_PERSISTED_MASK_STATE_BYTES = 4 * 1024 * 1024;

type PersistedMask = {
  imageId: string;
  dataURL: DataURL;
  elements: readonly ExcalidrawFreeDrawElement[];
  updatedAt: number;
  fileName: string;
  mimeType: string;
};

export const getMaskPersistenceKey = (
  excalidrawAPI: ExcalidrawImperativeAPI,
) => {
  // getName() fabricates a timestamped Untitled name when appState.name is
  // null, which made every persistence read/write use a different key.
  const sceneName = excalidrawAPI.getAppState().name?.trim() || "default";

  return `ai-inpaint-masks-${encodeURIComponent(
    `${window.location.pathname}${window.location.search}:${sceneName}`,
  )}`;
};

export const persistMaskState = (
  key: string,
  masksByImageId: Record<string, AIImageEditableMask>,
) => {
  try {
    const entries = Object.entries(masksByImageId)
      // Only masks whose dataURL has landed can be rebuilt on restore; the
      // dataURL is patched in asynchronously right after the mask is created.
      .filter(([, mask]) => typeof mask.dataURL === "string" && !!mask.dataURL)
      // Newest first so the trim loop below discards the oldest under quota.
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, MAX_PERSISTED_MASKS)
      .map(
        ([imageId, mask]): PersistedMask => ({
          imageId,
          dataURL: mask.dataURL as DataURL,
          elements: mask.elements,
          updatedAt: mask.updatedAt,
          fileName: mask.file.name,
          mimeType: mask.file.type || "image/png",
        }),
      );

    if (!entries.length) {
      localStorage.removeItem(key);
      return;
    }

    const payload = { version: 1, masks: entries };
    let serialized = JSON.stringify(payload);

    while (
      serialized.length > MAX_PERSISTED_MASK_STATE_BYTES &&
      payload.masks.length > 0
    ) {
      payload.masks.pop();
      serialized = JSON.stringify(payload);
    }

    localStorage.setItem(key, serialized);
  } catch (error) {
    console.error("Could not persist AI inpaint masks", error);
  }
};

export const loadPersistedMaskState = (
  key: string,
): Record<string, AIImageEditableMask> => {
  try {
    const rawValue = localStorage.getItem(key);

    if (!rawValue) {
      return {};
    }

    const parsed = JSON.parse(rawValue);
    const masks = Array.isArray(parsed?.masks) ? parsed.masks : [];
    const restored: Record<string, AIImageEditableMask> = {};

    for (const value of masks) {
      const mask = normalizePersistedMask(value);
      if (mask) {
        restored[mask.imageId] = mask.record;
      }
    }

    return restored;
  } catch (error) {
    console.error("Could not restore AI inpaint masks", error);
    return {};
  }
};

const normalizePersistedMask = (
  value: unknown,
): { imageId: string; record: AIImageEditableMask } | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const imageId =
    typeof candidate.imageId === "string" ? candidate.imageId : "";
  const dataURL =
    typeof candidate.dataURL === "string" ? (candidate.dataURL as DataURL) : "";

  if (!imageId || !dataURL) {
    return null;
  }

  const elements = Array.isArray(candidate.elements)
    ? (candidate.elements as readonly ExcalidrawFreeDrawElement[])
    : [];
  const updatedAt =
    typeof candidate.updatedAt === "number" ? candidate.updatedAt : Date.now();
  const fileName =
    typeof candidate.fileName === "string"
      ? candidate.fileName
      : `mask-${imageId}.png`;
  const mimeType =
    typeof candidate.mimeType === "string" ? candidate.mimeType : "image/png";

  return {
    imageId,
    record: {
      file: dataURLToFile(dataURL, fileName, mimeType),
      dataURL,
      elements,
      updatedAt,
    },
  };
};
