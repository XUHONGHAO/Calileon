import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { generateIdFromFile } from "@excalidraw/excalidraw/data/blob";
import {
  getCommonBounds,
  getSelectedElements,
  getVisibleSceneBounds,
  newImageElement,
  syncInvalidIndices,
} from "@excalidraw/element";

import type {
  AppState,
  BinaryFileData,
  DataURL,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  FileId,
  InitializedExcalidrawImageElement,
  NonDeleted,
} from "@excalidraw/element/types";

import { getMimeTypeFromDataURL } from "./openAIImageAdapter";

import type {
  AIImageGenerationMetadata,
  AIImageGenerationOutput,
} from "./types";

type InsertGeneratedImageOptions = {
  excalidrawAPI: ExcalidrawImperativeAPI;
  output: AIImageGenerationOutput;
  metadata: AIImageGenerationMetadata;
  index: number;
  placement?: GeneratedImagePlacement;
};

const MAX_INSERTED_IMAGE_SIZE = 640;
const SELECTION_INSERT_GAP = 48;
const REFERENCE_INSERT_GAP = 16;

export type GeneratedImagePlacement = {
  kind: "reference";
  elementIds: readonly string[];
};

export const insertGeneratedImageIntoCanvas = async ({
  excalidrawAPI,
  output,
  metadata,
  index,
  placement,
}: InsertGeneratedImageOptions) => {
  const fileId = isRemoteImageOutput(output)
    ? createRemoteImageFileId(index)
    : await generateIdFromFile(
        dataURLToFile(
          output.dataURL,
          `ai-generated-${Date.now()}-${index}.${getExtensionFromMimeType(
            output.mimeType,
          )}`,
          output.mimeType,
        ),
      );
  const dimensions = await getImageDimensions(output.dataURL);
  const fittedDimensions = fitImageDimensions(dimensions);
  const appState = excalidrawAPI.getAppState();
  const elements = excalidrawAPI.getSceneElements();
  const selectedElements = getSelectedElements(elements, appState);
  const position = getGeneratedImagePosition(
    fittedDimensions,
    selectedElements,
    elements,
    appState,
    placement,
  );

  const binaryFileData: BinaryFileData = {
    id: fileId,
    dataURL: output.dataURL,
    mimeType: (output.mimeType ||
      getMimeTypeFromDataURL(output.dataURL) ||
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
      aiGeneration: metadata,
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

export const dataURLToFile = (
  dataURL: DataURL,
  fileName: string,
  mimeType?: string,
) => {
  const [meta, data] = dataURL.split(",");
  const isBase64 = meta.includes(";base64");
  const resolvedMimeType =
    mimeType || meta.match(/^data:([^;,]+)/)?.[1] || "application/octet-stream";
  const binaryString = isBase64 ? atob(data) : decodeURIComponent(data);
  const bytes = new Uint8Array(binaryString.length);

  for (let index = 0; index < binaryString.length; index++) {
    bytes[index] = binaryString.charCodeAt(index);
  }

  return new File([bytes], fileName, { type: resolvedMimeType });
};

export const fileToDataURL = (file: File): Promise<DataURL> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as DataURL);
    reader.onerror = (error) => reject(error);
    reader.readAsDataURL(file);
  });
};

const getImageDimensions = async (dataURL: DataURL) => {
  return new Promise<{ width: number; height: number }>((resolve) => {
    const image = new Image();

    image.onload = () => {
      resolve({
        width: image.naturalWidth || image.width || MAX_INSERTED_IMAGE_SIZE,
        height: image.naturalHeight || image.height || MAX_INSERTED_IMAGE_SIZE,
      });
    };
    image.onerror = () => {
      resolve({
        width: MAX_INSERTED_IMAGE_SIZE,
        height: MAX_INSERTED_IMAGE_SIZE,
      });
    };
    image.src = dataURL;
  });
};

const fitImageDimensions = ({
  width,
  height,
}: {
  width: number;
  height: number;
}) => {
  const maxDimension = Math.max(width, height);

  if (maxDimension <= MAX_INSERTED_IMAGE_SIZE) {
    return { width, height };
  }

  const scale = MAX_INSERTED_IMAGE_SIZE / maxDimension;

  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
};

export const getGeneratedImagePosition = (
  dimensions: { width: number; height: number },
  selectedElements: readonly ExcalidrawElement[],
  sceneElements: readonly ExcalidrawElement[],
  appState: AppState,
  placement?: GeneratedImagePlacement,
) => {
  if (placement?.kind === "reference" && placement.elementIds.length) {
    const referenceElementIds = new Set(placement.elementIds);
    const referenceElements = sceneElements.filter((element) =>
      referenceElementIds.has(element.id),
    );

    if (referenceElements.length) {
      const [, minY, maxX] = getCommonBounds(referenceElements);

      return {
        x: maxX + REFERENCE_INSERT_GAP,
        y: minY,
      };
    }
  }

  if (selectedElements.length) {
    const [, minY, maxX, maxY] = getCommonBounds(selectedElements);

    return {
      x: maxX + SELECTION_INSERT_GAP,
      y: minY + (maxY - minY - dimensions.height) / 2,
    };
  }

  const [minX, minY, maxX, maxY] = getVisibleSceneBounds(appState);

  return {
    x: minX + (maxX - minX - dimensions.width) / 2,
    y: minY + (maxY - minY - dimensions.height) / 2,
  };
};

const getExtensionFromMimeType = (mimeType: string) => {
  if (mimeType === "image/jpeg") {
    return "jpg";
  }
  if (mimeType === "image/webp") {
    return "webp";
  }
  if (mimeType === "image/gif") {
    return "gif";
  }
  return "png";
};

const isRemoteImageOutput = (output: AIImageGenerationOutput) => {
  return (
    output.storageType === "remote-url" || /^https?:\/\//i.test(output.dataURL)
  );
};

const createRemoteImageFileId = (index: number) => {
  return `ai-remote-${Date.now()}-${index}-${Math.random()
    .toString(36)
    .slice(2, 8)}` as FileId;
};
