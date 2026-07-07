import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { generateIdFromFile } from "@excalidraw/excalidraw/data/blob";
import {
  getSelectedElements,
  newImageElement,
  syncInvalidIndices,
} from "@excalidraw/element";

import type {
  BinaryFileData,
  DataURL,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type {
  InitializedExcalidrawImageElement,
  NonDeleted,
} from "@excalidraw/element/types";

import { dataURLToFile, getGeneratedImagePosition } from "./imageCanvas";
import { getMimeTypeFromDataURL } from "./openAIImageAdapter";

import type { AIVideoGenerationMetadata } from "./types";

const MAX_INSERTED_COVER_SIZE = 640;
const DEFAULT_COVER_WIDTH = 640;
const DEFAULT_COVER_HEIGHT = 360;

// Cross-origin video frames taint the canvas, so `toDataURL` throws. We only ever
// get a real first-frame cover when the CDN sends permissive CORS headers; anytime
// it does not (the common case for signed CDN links) we fall back to a generated
// placeholder cover so the main flow is never blocked. See decision 0015 §5.
const FIRST_FRAME_TIMEOUT_MS = 8000;

export type VideoCover = {
  dataURL: DataURL;
  mimeType: string;
  width: number;
  height: number;
  storageType: "data-url" | "placeholder";
};

type InsertVideoCoverOptions = {
  excalidrawAPI: ExcalidrawImperativeAPI;
  cover: VideoCover;
  metadata: AIVideoGenerationMetadata;
};

/**
 * Resolve a cover image for a generated video, in priority order:
 *   1. provider-supplied thumbnail (already fetched to a data URL by the adapter)
 *   2. first frame captured from the video URL via <video> + canvas
 *   3. a generated placeholder cover with a play glyph
 * Never throws — a failure at any step degrades to the placeholder.
 */
export const resolveVideoCover = async ({
  thumbnailDataURL,
  videoURL,
  signal,
}: {
  thumbnailDataURL?: DataURL;
  videoURL: string;
  signal?: AbortSignal;
}): Promise<VideoCover> => {
  if (thumbnailDataURL) {
    const dimensions = await getImageDimensions(thumbnailDataURL);

    return {
      dataURL: thumbnailDataURL,
      mimeType: getMimeTypeFromDataURL(thumbnailDataURL) || "image/png",
      width: dimensions.width,
      height: dimensions.height,
      storageType: "data-url",
    };
  }

  const firstFrame = await captureVideoFirstFrame(videoURL, signal).catch(
    () => null,
  );

  if (firstFrame) {
    return { ...firstFrame, storageType: "data-url" };
  }

  return createPlaceholderCover();
};

/**
 * Insert the cover image element into the canvas with the real video URL stored
 * on `customData.aiVideoGeneration`. The canvas has no video element type, so the
 * cover doubles as the handle for the video (opened on click by the workbench).
 */
export const insertVideoCoverIntoCanvas = async ({
  excalidrawAPI,
  cover,
  metadata,
}: InsertVideoCoverOptions) => {
  const fileId = await generateIdFromFile(
    dataURLToFile(
      cover.dataURL,
      `ai-video-cover-${Date.now()}.${getExtensionFromMimeType(
        cover.mimeType,
      )}`,
      cover.mimeType,
    ),
  );
  const fittedDimensions = fitCoverDimensions(cover);
  const appState = excalidrawAPI.getAppState();
  const elements = excalidrawAPI.getSceneElements();
  const selectedElements = getSelectedElements(elements, appState);
  const position = getGeneratedImagePosition(
    fittedDimensions,
    selectedElements,
    elements,
    appState,
  );

  const binaryFileData: BinaryFileData = {
    id: fileId,
    dataURL: cover.dataURL,
    mimeType: (cover.mimeType ||
      getMimeTypeFromDataURL(cover.dataURL) ||
      "image/png") as BinaryFileData["mimeType"],
    created: Date.now(),
    lastRetrieved: Date.now(),
  };

  const imageElement = newImageElement({
    type: "image",
    x: position.x,
    y: position.y,
    width: fittedDimensions.width,
    height: fittedDimensions.height,
    status: "saved",
    fileId,
    customData: {
      aiVideoGeneration: metadata,
    },
  }) as NonDeleted<InitializedExcalidrawImageElement>;
  const nextElements = [...elements, imageElement];

  syncInvalidIndices(nextElements);

  excalidrawAPI.addFiles([binaryFileData]);
  excalidrawAPI.updateScene({
    elements: nextElements,
    appState: {
      selectedElementIds: {
        [imageElement.id]: true,
      },
    },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });

  return imageElement;
};

const captureVideoFirstFrame = (
  videoURL: string,
  signal?: AbortSignal,
): Promise<{
  dataURL: DataURL;
  mimeType: string;
  width: number;
  height: number;
}> => {
  return new Promise((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error("No document available for first-frame capture."));
      return;
    }

    const video = document.createElement("video");
    let settled = false;

    const cleanup = () => {
      video.onloadeddata = null;
      video.onseeked = null;
      video.onerror = null;
      signal?.removeEventListener("abort", onAbort);
      video.removeAttribute("src");
      video.load();
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeoutId);
      cleanup();
      reject(error);
    };

    const onAbort = () => {
      const abortError = new Error("Aborted");
      abortError.name = "AbortError";
      fail(abortError);
    };

    const timeoutId = window.setTimeout(() => {
      fail(new Error("First-frame capture timed out."));
    }, FIRST_FRAME_TIMEOUT_MS);

    const drawFrame = () => {
      if (settled) {
        return;
      }

      try {
        const width = video.videoWidth || DEFAULT_COVER_WIDTH;
        const height = video.videoHeight || DEFAULT_COVER_HEIGHT;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");

        if (!context) {
          fail(new Error("Could not acquire a 2D context."));
          return;
        }

        context.drawImage(video, 0, 0, width, height);
        // Throws a SecurityError on a tainted (cross-origin) canvas.
        const dataURL = canvas.toDataURL("image/png") as DataURL;

        settled = true;
        window.clearTimeout(timeoutId);
        cleanup();
        resolve({ dataURL, mimeType: "image/png", width, height });
      } catch (error: any) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });

    video.muted = true;
    video.crossOrigin = "anonymous";
    video.preload = "auto";
    video.onloadeddata = () => {
      try {
        video.currentTime = 0;
      } catch {
        drawFrame();
      }
    };
    video.onseeked = drawFrame;
    video.onerror = () => fail(new Error("Could not load video for capture."));
    video.src = videoURL;
  });
};

/**
 * A neutral placeholder cover with a centered play triangle, used when a real
 * frame can't be captured (cross-origin taint, load failure, no thumbnail).
 */
export const createPlaceholderCover = (): VideoCover => {
  const width = DEFAULT_COVER_WIDTH;
  const height = DEFAULT_COVER_HEIGHT;

  if (typeof document === "undefined") {
    return {
      dataURL: PLACEHOLDER_FALLBACK_DATA_URL,
      mimeType: "image/svg+xml",
      width,
      height,
      storageType: "placeholder",
    };
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");

  if (!context) {
    return {
      dataURL: PLACEHOLDER_FALLBACK_DATA_URL,
      mimeType: "image/svg+xml",
      width,
      height,
      storageType: "placeholder",
    };
  }

  context.fillStyle = "#1e1e2e";
  context.fillRect(0, 0, width, height);

  const glyphSize = Math.min(width, height) * 0.22;
  const centerX = width / 2;
  const centerY = height / 2;

  context.fillStyle = "rgba(255, 255, 255, 0.92)";
  context.beginPath();
  context.moveTo(centerX - glyphSize / 2, centerY - glyphSize / 1.6);
  context.lineTo(centerX - glyphSize / 2, centerY + glyphSize / 1.6);
  context.lineTo(centerX + glyphSize, centerY);
  context.closePath();
  context.fill();

  return {
    dataURL: canvas.toDataURL("image/png") as DataURL,
    mimeType: "image/png",
    width,
    height,
    storageType: "placeholder",
  };
};

// Static SVG cover for non-DOM environments (SSR / tests without canvas).
const PLACEHOLDER_FALLBACK_DATA_URL = `data:image/svg+xml;base64,${btoaSafe(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${DEFAULT_COVER_WIDTH}" height="${DEFAULT_COVER_HEIGHT}" viewBox="0 0 ${DEFAULT_COVER_WIDTH} ${DEFAULT_COVER_HEIGHT}"><rect width="100%" height="100%" fill="#1e1e2e"/><polygon points="290,150 290,210 350,180" fill="rgba(255,255,255,0.92)"/></svg>`,
)}` as DataURL;

function btoaSafe(value: string): string {
  if (typeof btoa === "function") {
    return btoa(value);
  }

  // Node fallback for tests.
  return Buffer.from(value, "utf-8").toString("base64");
}

const getImageDimensions = async (dataURL: DataURL) => {
  return new Promise<{ width: number; height: number }>((resolve) => {
    if (typeof Image === "undefined") {
      resolve({ width: DEFAULT_COVER_WIDTH, height: DEFAULT_COVER_HEIGHT });
      return;
    }

    const image = new Image();

    image.onload = () => {
      resolve({
        width: image.naturalWidth || image.width || DEFAULT_COVER_WIDTH,
        height: image.naturalHeight || image.height || DEFAULT_COVER_HEIGHT,
      });
    };
    image.onerror = () => {
      resolve({ width: DEFAULT_COVER_WIDTH, height: DEFAULT_COVER_HEIGHT });
    };
    image.src = dataURL;
  });
};

const fitCoverDimensions = ({
  width,
  height,
}: {
  width: number;
  height: number;
}) => {
  const safeWidth = width > 0 ? width : DEFAULT_COVER_WIDTH;
  const safeHeight = height > 0 ? height : DEFAULT_COVER_HEIGHT;
  const maxDimension = Math.max(safeWidth, safeHeight);

  if (maxDimension <= MAX_INSERTED_COVER_SIZE) {
    return { width: safeWidth, height: safeHeight };
  }

  const scale = MAX_INSERTED_COVER_SIZE / maxDimension;

  return {
    width: Math.round(safeWidth * scale),
    height: Math.round(safeHeight * scale),
  };
};

const getExtensionFromMimeType = (mimeType: string) => {
  if (mimeType === "image/jpeg") {
    return "jpg";
  }
  if (mimeType === "image/webp") {
    return "webp";
  }
  if (mimeType === "image/svg+xml") {
    return "svg";
  }
  return "png";
};
