import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { ROUGHNESS, STROKE_WIDTH } from "@excalidraw/common";
import {
  getSelectedElements,
  newEmbeddableElement,
  syncInvalidIndices,
} from "@excalidraw/element";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  ExcalidrawEmbeddableElement,
  NonDeleted,
} from "@excalidraw/element/types";

import { getGeneratedImagePosition } from "./imageCanvas";

import type { AIVideoGenerationMetadata } from "./types";

const MAX_INSERTED_VIDEO_SIZE = 640;
const DEFAULT_VIDEO_WIDTH = 640;
const DEFAULT_VIDEO_HEIGHT = 360;
const METADATA_LOAD_TIMEOUT_MS = 6000;
const AI_VIDEO_ASSET_LINK_PREFIX = "urn:excalidraw:ai-video:";

// AI video URLs may be opaque, extension-less, and signed. The URL shape does
// not establish trust; callers must also require valid AI video element metadata.
export const isSafeAIVideoURL = (
  url: string | null | undefined,
): url is string => {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};

export const getAIVideoURLFromEmbeddable = (
  element: Pick<ExcalidrawElement, "type" | "link" | "customData">,
): string | null => {
  if (element.type !== "embeddable" || !element.link) {
    return null;
  }

  const metadata = (
    element.customData as { aiVideoGeneration?: unknown } | null
  )?.aiVideoGeneration;

  if (!isAIVideoGenerationMetadata(metadata)) {
    return null;
  }

  return metadata.version === 1 && metadata.videoURL === element.link
    ? metadata.videoURL
    : null;
};

export const getAIVideoGenerationMetadataFromEmbeddable = (
  element: Pick<ExcalidrawElement, "type" | "customData">,
): AIVideoGenerationMetadata | null => {
  if (element.type !== "embeddable") {
    return null;
  }
  const metadata = (
    element.customData as { aiVideoGeneration?: unknown } | null
  )?.aiVideoGeneration;
  return isAIVideoGenerationMetadata(metadata) ? metadata : null;
};

export const buildAIVideoAssetLink = (assetId: string) =>
  `${AI_VIDEO_ASSET_LINK_PREFIX}${encodeURIComponent(assetId)}`;

export const getAIVideoAssetIdFromEmbeddable = (
  element: Pick<ExcalidrawElement, "type" | "link" | "customData">,
): string | null => {
  if (element.type !== "embeddable" || !element.link) {
    return null;
  }
  const metadata = (
    element.customData as { aiVideoGeneration?: unknown } | null
  )?.aiVideoGeneration;
  if (
    !isAIVideoGenerationMetadata(metadata) ||
    metadata.version !== 2 ||
    element.link !== buildAIVideoAssetLink(metadata.assetId)
  ) {
    return null;
  }
  return metadata.assetId;
};

export const isValidAIVideoEmbeddable = (
  element: Pick<ExcalidrawElement, "type" | "link" | "customData">,
) =>
  !!getAIVideoURLFromEmbeddable(element) ||
  !!getAIVideoAssetIdFromEmbeddable(element);

const isAIVideoGenerationMetadata = (
  value: unknown,
): value is AIVideoGenerationMetadata => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const metadata = value as Partial<AIVideoGenerationMetadata>;
  const params = metadata.params;
  const assetId = (metadata as { assetId?: unknown }).assetId;

  return (
    (metadata.version === 1 || metadata.version === 2) &&
    metadata.kind === "video" &&
    (metadata.mode === "text-to-video" || metadata.mode === "image-to-video") &&
    typeof metadata.model === "string" &&
    typeof metadata.prompt === "string" &&
    !!params &&
    typeof params === "object" &&
    !Array.isArray(params) &&
    typeof params.size === "string" &&
    typeof params.n === "number" &&
    Number.isFinite(params.n) &&
    params.n > 0 &&
    isOptionalFiniteNumber(params.seed, true) &&
    isOptionalString(params.quality) &&
    isOptionalString(params.style) &&
    isOptionalFiniteNumber(params.referenceStrength) &&
    isOptionalFiniteNumber(params.duration) &&
    isOptionalFiniteNumber(params.fps) &&
    isOptionalString(params.resolution) &&
    isOptionalString(params.aspectRatio) &&
    isOptionalString(params.audioFormat) &&
    isOptionalString(params.voice) &&
    (metadata.version === 1
      ? isSafeAIVideoURL(metadata.videoURL)
      : typeof assetId === "string" && !!assetId) &&
    typeof metadata.mimeType === "string" &&
    metadata.mimeType.startsWith("video/") &&
    isOptionalFiniteNumber(metadata.durationSeconds) &&
    isOptionalFiniteNumber((metadata as { width?: unknown }).width) &&
    isOptionalFiniteNumber((metadata as { height?: unknown }).height) &&
    isOptionalString(metadata.revisedPrompt) &&
    typeof metadata.createdAt === "string" &&
    !Number.isNaN(Date.parse(metadata.createdAt))
  );
};

const isOptionalString = (value: unknown) =>
  value === undefined || typeof value === "string";

const isOptionalFiniteNumber = (value: unknown, allowNull = false) =>
  value === undefined ||
  (allowNull && value === null) ||
  (typeof value === "number" && Number.isFinite(value));

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
    link:
      metadata.version === 1
        ? metadata.videoURL
        : buildAIVideoAssetLink(metadata.assetId),
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
