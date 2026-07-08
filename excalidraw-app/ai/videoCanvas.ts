import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { ROUGHNESS, STROKE_WIDTH } from "@excalidraw/common";
import {
  getSelectedElements,
  newEmbeddableElement,
  syncInvalidIndices,
} from "@excalidraw/element";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawEmbeddableElement,
  NonDeleted,
} from "@excalidraw/element/types";

import { getGeneratedImagePosition } from "./imageCanvas";

import type { AIVideoGenerationMetadata } from "./types";

const MAX_INSERTED_VIDEO_SIZE = 640;
const DEFAULT_VIDEO_WIDTH = 640;
const DEFAULT_VIDEO_HEIGHT = 360;
const METADATA_LOAD_TIMEOUT_MS = 6000;

// A conservative check for URLs we're willing to render as an inline <video>.
// Used by the app's `validateEmbeddable` so a generated video URL passes the
// embeddable gate (which otherwise only allows a fixed platform whitelist), and
// re-runs on refresh since validation is keyed off the element's link. We accept
// http(s) URLs whose path ends in a known video extension OR carries a `/video/`
// path hint, since signed CDN links often omit the extension.
const VIDEO_EXTENSION_RE = /\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i;

export const isLikelyVideoURL = (url: string | null | undefined): boolean => {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    if (VIDEO_EXTENSION_RE.test(parsed.pathname)) {
      return true;
    }
    // Some gateways hand back extension-less signed URLs but keep a hint in the
    // path (…/video/…) — accept those too so playback isn't blocked.
    return /\/video[s]?\//i.test(parsed.pathname);
  } catch {
    return false;
  }
};

/**
 * Read a video's intrinsic dimensions via a metadata-only <video> load. Unlike
 * first-frame capture, reading `videoWidth`/`videoHeight` does NOT taint a
 * canvas, so this works for cross-origin CDN URLs without any CORS headers. Used
 * only to size the inserted card to the real aspect ratio; never throws — a
 * failure (or timeout) resolves to `null` and the caller falls back to 16:9.
 */
export const getVideoDimensions = (
  videoURL: string,
  signal?: AbortSignal,
): Promise<{ width: number; height: number } | null> => {
  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve(null);
      return;
    }

    const video = document.createElement("video");
    let settled = false;

    const finish = (value: { width: number; height: number } | null) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeoutId);
      video.onloadedmetadata = null;
      video.onerror = null;
      signal?.removeEventListener("abort", onAbort);
      video.removeAttribute("src");
      video.load();
      resolve(value);
    };

    const onAbort = () => finish(null);

    const timeoutId = window.setTimeout(
      () => finish(null),
      METADATA_LOAD_TIMEOUT_MS,
    );

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => {
      const width = video.videoWidth;
      const height = video.videoHeight;
      finish(width > 0 && height > 0 ? { width, height } : null);
    };
    video.onerror = () => finish(null);
    video.src = videoURL;
  });
};

type InsertVideoEmbedOptions = {
  excalidrawAPI: ExcalidrawImperativeAPI;
  metadata: AIVideoGenerationMetadata;
  // Optional size hint (the video's intrinsic dimensions). Falls back to a 16:9
  // default when unknown. Placement is auto-computed relative to the current
  // selection / viewport, same as generated images.
  dimensions?: { width: number; height: number } | null;
};

/**
 * Insert an `embeddable` element that the app renders as a native
 * `<video controls>` via its `renderEmbeddable` prop, so the generated video
 * plays inline on the canvas. The real video URL rides on both the element's
 * native `link` (so `validateEmbeddable` passes) and
 * `customData.aiVideoGeneration` (so the app knows to render a player).
 *
 * The card gets a thin / solid / architect (plain) border by default so it reads
 * as a clean video frame rather than the hand-drawn default.
 */
export const insertVideoEmbedIntoCanvas = ({
  excalidrawAPI,
  metadata,
  dimensions,
}: InsertVideoEmbedOptions) => {
  const fitted = fitVideoDimensions({
    width: dimensions?.width || DEFAULT_VIDEO_WIDTH,
    height: dimensions?.height || DEFAULT_VIDEO_HEIGHT,
  });
  const appState = excalidrawAPI.getAppState();
  const elements = excalidrawAPI.getSceneElements();
  const selectedElements = getSelectedElements(elements, appState);
  const position = getGeneratedImagePosition(
    fitted,
    selectedElements,
    elements,
    appState,
  );

  const embedElement = newEmbeddableElement({
    type: "embeddable",
    x: position.x,
    y: position.y,
    width: fitted.width,
    height: fitted.height,
    // Default frame: thin width, solid style, plain (architect) roughness.
    strokeWidth: STROKE_WIDTH.thin,
    strokeStyle: "solid",
    roughness: ROUGHNESS.architect,
    link: metadata.videoURL,
    customData: {
      aiVideoGeneration: metadata,
    },
  }) as NonDeleted<ExcalidrawEmbeddableElement>;
  const nextElements = [...elements, embedElement];

  syncInvalidIndices(nextElements);

  excalidrawAPI.updateScene({
    elements: nextElements,
    appState: {
      selectedElementIds: {
        [embedElement.id]: true,
      },
    },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });

  return embedElement;
};

const fitVideoDimensions = ({
  width,
  height,
}: {
  width: number;
  height: number;
}) => {
  const safeWidth = width > 0 ? width : DEFAULT_VIDEO_WIDTH;
  const safeHeight = height > 0 ? height : DEFAULT_VIDEO_HEIGHT;
  const maxDimension = Math.max(safeWidth, safeHeight);

  if (maxDimension <= MAX_INSERTED_VIDEO_SIZE) {
    return { width: safeWidth, height: safeHeight };
  }

  const scale = MAX_INSERTED_VIDEO_SIZE / maxDimension;

  return {
    width: Math.round(safeWidth * scale),
    height: Math.round(safeHeight * scale),
  };
};
