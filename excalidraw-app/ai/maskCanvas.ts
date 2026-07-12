import type { AppState } from "@excalidraw/excalidraw/types";
import type {
  BinaryFileData,
  BinaryFiles,
  DataURL,
} from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawFreeDrawElement,
  ExcalidrawImageElement,
} from "@excalidraw/element/types";

import { dataURLToFile } from "./imageCanvas";

export const DEFAULT_MASK_BRUSH_SIZE = 20;
export const MASK_SOURCE_IMAGE_LOAD_TIMEOUT_MS = 10_000;
const MAX_MASK_PREVIEW_CANVAS_DIMENSION = 1024;

export const MASK_BRUSH_SIZE_LIMITS = {
  min: 10,
  max: 50,
} as const;

export type MaskDrawingConfig = {
  strokeColor: ExcalidrawFreeDrawElement["strokeColor"];
  backgroundColor: ExcalidrawFreeDrawElement["backgroundColor"];
  strokeWidth: ExcalidrawFreeDrawElement["strokeWidth"];
  roughness: ExcalidrawFreeDrawElement["roughness"];
  opacity: ExcalidrawFreeDrawElement["opacity"];
  strokeStyle: ExcalidrawFreeDrawElement["strokeStyle"];
};

export type MaskDrawingAppState = Pick<
  AppState,
  | "currentItemStrokeColor"
  | "currentItemBackgroundColor"
  | "currentItemStrokeWidth"
  | "currentItemStrokeStyle"
  | "currentItemRoughness"
  | "currentItemOpacity"
>;

export const MASK_DRAWING_CONFIG: MaskDrawingConfig = {
  strokeColor: "#ffffff",
  backgroundColor: "transparent",
  strokeWidth: DEFAULT_MASK_BRUSH_SIZE,
  roughness: 0,
  opacity: 0,
  strokeStyle: "solid",
};

export const MASK_ERASER_CONFIG: MaskDrawingConfig = {
  ...MASK_DRAWING_CONFIG,
  strokeColor: "#000000",
};

export const getMaskDrawingConfig = (isErasing: boolean) =>
  isErasing ? MASK_ERASER_CONFIG : MASK_DRAWING_CONFIG;

export const getMaskDrawingAppState = (
  isErasing: boolean,
  brushSize: number,
): MaskDrawingAppState => {
  const config = getMaskDrawingConfig(isErasing);

  return {
    currentItemStrokeColor: config.strokeColor,
    currentItemBackgroundColor: config.backgroundColor,
    currentItemStrokeWidth: brushSize,
    currentItemStrokeStyle: config.strokeStyle,
    currentItemRoughness: config.roughness,
    currentItemOpacity: config.opacity,
  };
};

export const generateMaskPreview = (
  targetImage: ExcalidrawImageElement,
  maskElements: readonly ExcalidrawFreeDrawElement[],
  canvas: HTMLCanvasElement = document.createElement("canvas"),
  canvasSize: MaskCanvasSize = getMaskCanvasSize(targetImage),
  canvasTransform: MaskCanvasTransform = getMaskPreviewTransform(
    targetImage,
    canvasSize,
  ),
) => {
  const { width, height } = normalizeMaskCanvasSize(canvasSize);
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext("2d");
  if (!context) {
    return canvas.toDataURL("image/png");
  }

  context.clearRect(0, 0, width, height);
  context.fillStyle = "#000000";
  context.fillRect(0, 0, width, height);

  for (const element of maskElements) {
    drawMaskFreeDrawElement(context, targetImage, element, canvasTransform);
  }

  return canvas.toDataURL("image/png");
};

export const exportMaskAsFile = async (
  targetImage: ExcalidrawImageElement,
  maskElements: readonly ExcalidrawFreeDrawElement[],
  files: BinaryFiles,
  signal?: AbortSignal,
) => {
  const canvas = document.createElement("canvas");
  const canvasSize = await getMaskExportCanvasSize(targetImage, files, signal);
  const dataURL = generateMaskPreview(
    targetImage,
    maskElements,
    canvas,
    canvasSize,
    getMaskDisplayToNaturalTransform(targetImage, canvasSize),
  ) as DataURL;

  return dataURLToFile(dataURL, `mask-${targetImage.id}.png`, "image/png");
};

type MaskCanvasSize = {
  width: number;
  height: number;
};

export type MaskCanvasTransform = {
  scaleX: number;
  scaleY: number;
  translateX: number;
  translateY: number;
};

const getMaskPreviewTransform = (
  targetImage: ExcalidrawImageElement,
  canvasSize: MaskCanvasSize,
): MaskCanvasTransform => {
  const displaySize = getMaskCanvasSize(targetImage);

  return {
    scaleX: canvasSize.width / displaySize.width,
    scaleY: canvasSize.height / displaySize.height,
    translateX: 0,
    translateY: 0,
  };
};

const getMaskCanvasSize = (targetImage: ExcalidrawImageElement) =>
  normalizeMaskCanvasSize({
    width: targetImage.width,
    height: targetImage.height,
  });

export const getMaskDisplayToNaturalTransform = (
  targetImage: ExcalidrawImageElement,
  naturalSize: MaskCanvasSize,
): MaskCanvasTransform => {
  const displaySize = getMaskCanvasSize(targetImage);
  const crop = getNormalizedImageCrop(targetImage, naturalSize);
  const isFlippedX = targetImage.scale[0] < 0;
  const isFlippedY = targetImage.scale[1] < 0;

  return {
    scaleX: (isFlippedX ? -1 : 1) * (crop.width / displaySize.width),
    scaleY: (isFlippedY ? -1 : 1) * (crop.height / displaySize.height),
    translateX: isFlippedX ? crop.x + crop.width : crop.x,
    translateY: isFlippedY ? crop.y + crop.height : crop.y,
  };
};

const getNormalizedImageCrop = (
  targetImage: ExcalidrawImageElement,
  naturalSize: MaskCanvasSize,
) => {
  const crop = targetImage.crop;

  if (!crop) {
    return {
      x: 0,
      y: 0,
      width: naturalSize.width,
      height: naturalSize.height,
    };
  }

  if (
    !Number.isFinite(crop.x) ||
    !Number.isFinite(crop.y) ||
    !Number.isFinite(crop.width) ||
    !Number.isFinite(crop.height) ||
    !Number.isFinite(crop.naturalWidth) ||
    !Number.isFinite(crop.naturalHeight) ||
    crop.width <= 0 ||
    crop.height <= 0 ||
    crop.naturalWidth <= 0 ||
    crop.naturalHeight <= 0
  ) {
    throw new Error("Cannot export an AI mask with invalid crop dimensions.");
  }

  const naturalScaleX = naturalSize.width / crop.naturalWidth;
  const naturalScaleY = naturalSize.height / crop.naturalHeight;

  return {
    x: crop.x * naturalScaleX,
    y: crop.y * naturalScaleY,
    width: crop.width * naturalScaleX,
    height: crop.height * naturalScaleY,
  };
};

export const getMaskPreviewCanvasSize = (
  targetImage: ExcalidrawImageElement,
  maxDimension = MAX_MASK_PREVIEW_CANVAS_DIMENSION,
) => {
  const canvasSize = getMaskCanvasSize(targetImage);
  const largestDimension = Math.max(canvasSize.width, canvasSize.height);

  if (largestDimension <= maxDimension) {
    return canvasSize;
  }

  const scale = maxDimension / largestDimension;

  return normalizeMaskCanvasSize({
    width: canvasSize.width * scale,
    height: canvasSize.height * scale,
  });
};

const getMaskExportCanvasSize = async (
  targetImage: ExcalidrawImageElement,
  files: BinaryFiles,
  signal?: AbortSignal,
) => {
  const fileData = targetImage.fileId ? files[targetImage.fileId] : undefined;

  if (!fileData) {
    throw new Error("Cannot export an AI mask without its source image file.");
  }

  return loadImageDimensions(fileData, signal);
};

const normalizeMaskCanvasSize = ({ width, height }: MaskCanvasSize) => ({
  width: Math.max(1, Math.round(Math.abs(width))),
  height: Math.max(1, Math.round(Math.abs(height))),
});

const loadImageDimensions = (
  fileData: BinaryFileData,
  signal?: AbortSignal,
) => {
  return new Promise<MaskCanvasSize>((resolve, reject) => {
    const image = new Image();
    let settled = false;

    const finish = (
      result:
        | { status: "resolved"; value: MaskCanvasSize }
        | { status: "rejected"; error: Error },
    ) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();

      if (result.status === "resolved") {
        resolve(result.value);
      } else {
        reject(result.error);
      }
    };

    const handleAbort = () => {
      finish({ status: "rejected", error: createAbortError() });
    };

    const cleanup = () => {
      window.clearTimeout(timeoutId);
      image.onload = null;
      image.onerror = null;
      signal?.removeEventListener("abort", handleAbort);
    };

    const timeoutId = window.setTimeout(() => {
      finish({
        status: "rejected",
        error: new Error(
          "Timed out while decoding the source image dimensions.",
        ),
      });
    }, MASK_SOURCE_IMAGE_LOAD_TIMEOUT_MS);

    image.onload = () => {
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;

      if (
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        width <= 0 ||
        height <= 0
      ) {
        finish({
          status: "rejected",
          error: new Error("Could not determine the source image dimensions."),
        });
        return;
      }

      finish({
        status: "resolved",
        value: normalizeMaskCanvasSize({ width, height }),
      });
    };
    image.onerror = () => {
      finish({
        status: "rejected",
        error: new Error("Could not decode the source image dimensions."),
      });
    };

    if (signal?.aborted) {
      handleAbort();
      return;
    }

    signal?.addEventListener("abort", handleAbort, { once: true });
    try {
      image.src = fileData.dataURL;
    } catch {
      finish({
        status: "rejected",
        error: new Error("Could not decode the source image dimensions."),
      });
    }
  });
};

const createAbortError = () => {
  if (typeof DOMException !== "undefined") {
    return new DOMException("AI mask export was aborted.", "AbortError");
  }

  return Object.assign(new Error("AI mask export was aborted."), {
    name: "AbortError",
  });
};

const drawMaskFreeDrawElement = (
  context: CanvasRenderingContext2D,
  targetImage: ExcalidrawImageElement,
  element: ExcalidrawFreeDrawElement,
  canvasTransform: MaskCanvasTransform,
) => {
  if (!element.points.length) {
    return;
  }

  context.strokeStyle = getMaskStrokeColor(element.strokeColor);
  context.lineWidth = element.strokeWidth;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.save();
  context.setTransform(
    canvasTransform.scaleX,
    0,
    0,
    canvasTransform.scaleY,
    canvasTransform.translateX,
    canvasTransform.translateY,
  );

  const [startX, startY] = localMaskPointToDisplayPoint(
    targetImage,
    element,
    element.points[0],
  );

  context.beginPath();
  context.moveTo(startX, startY);

  if (element.points.length === 1) {
    context.arc(startX, startY, context.lineWidth / 2, 0, Math.PI * 2);
    context.fillStyle = context.strokeStyle;
    context.fill();
    context.restore();
    return;
  }

  for (const point of element.points.slice(1)) {
    const [x, y] = localMaskPointToDisplayPoint(targetImage, element, point);
    context.lineTo(x, y);
  }

  context.stroke();
  context.restore();
};

const getMaskStrokeColor = (strokeColor: string) =>
  strokeColor.toLowerCase() === MASK_ERASER_CONFIG.strokeColor
    ? "#000000"
    : "#ffffff";

export const localMaskPointToDisplayPoint = (
  targetImage: ExcalidrawImageElement,
  element: ExcalidrawFreeDrawElement,
  point: readonly [number, number],
) => {
  const elementCenter = getElementCenter(element);
  const scenePoint = rotatePoint(
    [element.x + point[0], element.y + point[1]],
    elementCenter,
    element.angle,
  );
  const targetCenter = getElementCenter(targetImage);
  const targetPoint = rotatePoint(scenePoint, targetCenter, -targetImage.angle);

  return [targetPoint[0] - targetImage.x, targetPoint[1] - targetImage.y];
};

const getElementCenter = (
  element: Pick<ExcalidrawImageElement, "x" | "y" | "width" | "height">,
) => [element.x + element.width / 2, element.y + element.height / 2] as const;

const rotatePoint = (
  point: readonly [number, number],
  center: readonly [number, number],
  angle: number,
) => {
  if (!angle) {
    return point;
  }

  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const translatedX = point[0] - center[0];
  const translatedY = point[1] - center[1];

  return [
    translatedX * cos - translatedY * sin + center[0],
    translatedX * sin + translatedY * cos + center[1],
  ] as const;
};
