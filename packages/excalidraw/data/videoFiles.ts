import { isInitializedVideoElement } from "@excalidraw/element";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";

import type { BinaryFiles } from "../types";

/** fileIds referenced by (non-deleted or deleted) camera recordings */
export const getVideoFileIds = (elements: readonly ExcalidrawElement[]) => {
  const ids = new Set<FileId>();
  for (const element of elements) {
    if (isInitializedVideoElement(element)) {
      ids.add(element.fileId);
    }
  }
  return ids;
};

/**
 * Drops camera-recording files from `files`, keeping every element (and its
 * inline poster). Used wherever a scene leaves the owner without its videos:
 * image exports with an embedded scene, legacy share links, the embed host
 * API (ADR 0035 §8). Receivers render the poster with an "unavailable" badge.
 */
export const stripVideoFiles = (
  elements: readonly ExcalidrawElement[],
  files: BinaryFiles,
): { files: BinaryFiles; stripped: boolean } => {
  const videoFileIds = getVideoFileIds(elements);
  if (!videoFileIds.size) {
    return { files, stripped: false };
  }
  let stripped = false;
  const next: BinaryFiles = {};
  for (const [id, file] of Object.entries(files)) {
    if (videoFileIds.has(id as FileId)) {
      stripped = true;
      continue;
    }
    next[id] = file;
  }
  return { files: stripped ? next : files, stripped };
};
