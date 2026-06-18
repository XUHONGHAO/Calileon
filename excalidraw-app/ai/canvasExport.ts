import { exportToBlob, MIME_TYPES } from "@excalidraw/excalidraw";
import { getDataURL } from "@excalidraw/excalidraw/data/blob";
import { getCommonBounds } from "@excalidraw/element";

import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  DataURL,
} from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  InitializedExcalidrawImageElement,
} from "@excalidraw/element/types";

import { dataURLToFile } from "./imageCanvas";
import { createAIReferenceId } from "./referenceIds";

import type {
  AIImageSourceEnhanced,
  AIImageSourceType,
  AIReferenceExportOptions,
} from "./types";

export const DEFAULT_AI_REFERENCE_EXPORT_OPTIONS: AIReferenceExportOptions = {
  background: "transparent",
  padding: "padded",
  maxSize: "1024",
};

const LARGE_SELECTION_WARNING_BYTES = 10 * 1024 * 1024;

export const detectSourceType = (
  elements: readonly ExcalidrawElement[],
): AIImageSourceType => {
  const hasImage = elements.some((element) => element.type === "image");
  const hasNonImage = elements.some((element) => element.type !== "image");

  if (hasImage && hasNonImage) {
    return "mixed";
  }

  return hasImage ? "imported" : "canvas";
};

export const createImportedReferenceSource = ({
  element,
  fileData,
  index,
  createdAt = createAIReferenceId(),
}: {
  element: InitializedExcalidrawImageElement;
  fileData: BinaryFileData;
  index: number;
  createdAt?: number;
}): AIImageSourceEnhanced => {
  return {
    index,
    elementId: element.id,
    elementIds: [element.id],
    fileId: element.fileId,
    dataURL: fileData.dataURL,
    width: element.width,
    height: element.height,
    file: dataURLToFile(
      fileData.dataURL,
      `reference-${element.fileId}.png`,
      fileData.mimeType,
    ),
    sourceType: "imported",
    createdAt,
  };
};

export const exportSelectionToReferenceSource = async ({
  elements,
  appState,
  files,
  options,
  index,
}: {
  elements: readonly ExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
  options: AIReferenceExportOptions;
  index: number;
}): Promise<{
  source: AIImageSourceEnhanced;
  warning?: string;
}> => {
  const createdAt = createAIReferenceId();
  const maxWidthOrHeight =
    options.maxSize === "auto" ? undefined : Number(options.maxSize);
  const sourceType = detectSourceType(elements);
  const appStateForExport = {
    ...appState,
    exportBackground: options.background !== "transparent",
    viewBackgroundColor:
      options.background === "white" ? "#ffffff" : appState.viewBackgroundColor,
  };

  const blob = await exportToBlob({
    elements,
    appState: appStateForExport,
    files,
    mimeType: MIME_TYPES.png,
    exportPadding: options.padding === "tight" ? 0 : 16,
    maxWidthOrHeight,
  });
  const dataURL = (await getDataURL(blob)) as DataURL;
  const elementIds = elements.map((element) => element.id);
  const dimensions = await getDataURLDimensions(dataURL);
  const file = new File([blob], `reference-canvas-${createdAt}.png`, {
    type: blob.type || MIME_TYPES.png,
  });

  return {
    source: {
      index,
      elementId: elementIds[0] || `canvas-${createdAt}`,
      elementIds,
      file,
      dataURL,
      width: dimensions.width,
      height: dimensions.height,
      sourceType,
      createdAt,
      locked: true,
    },
    warning:
      estimateSelectionBlobSize(elements) > LARGE_SELECTION_WARNING_BYTES
        ? "Selection is very large (>10MB). Consider simplifying."
        : undefined,
  };
};

export const estimateSelectionBlobSize = (
  elements: readonly ExcalidrawElement[],
) => {
  if (!elements.length) {
    return 0;
  }

  const [minX, minY, maxX, maxY] = getCommonBounds(elements);
  const width = Math.max(0, maxX - minX);
  const height = Math.max(0, maxY - minY);

  return width * height * 4;
};

const getDataURLDimensions = (dataURL: DataURL) => {
  return new Promise<{ width: number; height: number }>((resolve) => {
    const image = new Image();

    image.onload = () => {
      resolve({
        width: image.naturalWidth || image.width || 0,
        height: image.naturalHeight || image.height || 0,
      });
    };
    image.onerror = () => {
      resolve({ width: 0, height: 0 });
    };
    image.src = dataURL;
  });
};
