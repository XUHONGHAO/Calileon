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
    drawMaskFreeDrawElement(context, targetImage, element, { width, height });
  }

  return canvas.toDataURL("image/png");
};

export const exportMaskAsFile = (
  targetImage: ExcalidrawImageElement,
  maskElements: readonly ExcalidrawFreeDrawElement[],
  files: BinaryFiles,
) => {
  const canvas = document.createElement("canvas");
  const canvasSize = getMaskExportCanvasSize(targetImage, files);
  const dataURL = generateMaskPreview(
    targetImage,
    maskElements,
    canvas,
    canvasSize,
  ) as DataURL;

  return dataURLToFile(dataURL, `mask-${targetImage.id}.png`, "image/png");
};

type MaskCanvasSize = {
  width: number;
  height: number;
};

type BinaryFileDataWithDimensions = BinaryFileData & {
  naturalWidth?: number;
  naturalHeight?: number;
  width?: number;
  height?: number;
};

const getMaskCanvasSize = (targetImage: ExcalidrawImageElement) =>
  normalizeMaskCanvasSize({
    width: targetImage.width,
    height: targetImage.height,
  });

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

const getMaskExportCanvasSize = (
  targetImage: ExcalidrawImageElement,
  files: BinaryFiles,
) => {
  const fileData = targetImage.fileId
    ? (files[targetImage.fileId] as BinaryFileDataWithDimensions | undefined)
    : undefined;

  return normalizeMaskCanvasSize({
    width:
      getPositiveDimension(fileData?.naturalWidth) ??
      getPositiveDimension(fileData?.width) ??
      getPositiveDimension(targetImage.crop?.naturalWidth) ??
      targetImage.width,
    height:
      getPositiveDimension(fileData?.naturalHeight) ??
      getPositiveDimension(fileData?.height) ??
      getPositiveDimension(targetImage.crop?.naturalHeight) ??
      targetImage.height,
  });
};

const normalizeMaskCanvasSize = ({ width, height }: MaskCanvasSize) => ({
  width: Math.max(1, Math.round(Math.abs(width))),
  height: Math.max(1, Math.round(Math.abs(height))),
});

const getPositiveDimension = (dimension: number | undefined) => {
  return typeof dimension === "number" && Number.isFinite(dimension)
    ? Math.max(1, Math.round(Math.abs(dimension)))
    : undefined;
};

const drawMaskFreeDrawElement = (
  context: CanvasRenderingContext2D,
  targetImage: ExcalidrawImageElement,
  element: ExcalidrawFreeDrawElement,
  canvasSize: MaskCanvasSize,
) => {
  if (!element.points.length) {
    return;
  }

  context.strokeStyle = getMaskStrokeColor(element.strokeColor);
  context.lineWidth = getScaledStrokeWidth(targetImage, element, canvasSize);
  context.lineCap = "round";
  context.lineJoin = "round";

  const [startX, startY] = localMaskPointToCanvasPoint(
    targetImage,
    element,
    element.points[0],
    canvasSize,
  );

  context.beginPath();
  context.moveTo(startX, startY);

  if (element.points.length === 1) {
    context.arc(startX, startY, context.lineWidth / 2, 0, Math.PI * 2);
    context.fillStyle = context.strokeStyle;
    context.fill();
    return;
  }

  for (const point of element.points.slice(1)) {
    const [x, y] = localMaskPointToCanvasPoint(
      targetImage,
      element,
      point,
      canvasSize,
    );
    context.lineTo(x, y);
  }

  context.stroke();
};

const getMaskStrokeColor = (strokeColor: string) =>
  strokeColor.toLowerCase() === MASK_ERASER_CONFIG.strokeColor
    ? "#000000"
    : "#ffffff";

const localMaskPointToCanvasPoint = (
  targetImage: ExcalidrawImageElement,
  element: ExcalidrawFreeDrawElement,
  point: readonly [number, number],
  canvasSize: MaskCanvasSize,
) => {
  const elementCenter = getElementCenter(element);
  const scenePoint = rotatePoint(
    [element.x + point[0], element.y + point[1]],
    elementCenter,
    element.angle,
  );
  const targetCenter = getElementCenter(targetImage);
  const targetPoint = rotatePoint(scenePoint, targetCenter, -targetImage.angle);
  const displaySize = getMaskCanvasSize(targetImage);
  const scaleX = canvasSize.width / displaySize.width;
  const scaleY = canvasSize.height / displaySize.height;

  return [
    (targetPoint[0] - targetImage.x) * scaleX,
    (targetPoint[1] - targetImage.y) * scaleY,
  ];
};

const getScaledStrokeWidth = (
  targetImage: ExcalidrawImageElement,
  element: ExcalidrawFreeDrawElement,
  canvasSize: MaskCanvasSize,
) => {
  const displaySize = getMaskCanvasSize(targetImage);
  const scaleX = canvasSize.width / displaySize.width;
  const scaleY = canvasSize.height / displaySize.height;

  return element.strokeWidth * Math.max(scaleX, scaleY);
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
