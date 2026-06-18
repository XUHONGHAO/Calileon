import { dataURLToFile } from "../ai/imageCanvas";

import type {
  AIImageGenerationMetadata,
  AIImageGenerationMode,
  AIImageGenerationOutput,
  AIImageSourceEnhanced,
} from "../ai/types";

export type GeneratedAsset = {
  id: string;
  output: AIImageGenerationOutput;
  metadata: AIImageGenerationMetadata;
  insertedElementId: string;
  insertedFileId: AIImageSourceEnhanced["fileId"];
  width: number;
  height: number;
  createdAt: string;
  index: number;
  modelLabel: string;
  siteName: string;
};

export const createGeneratedAssetReferenceSource = (
  asset: GeneratedAsset,
  createdAt: number,
): Omit<AIImageSourceEnhanced, "index"> | null => {
  if (!isLocalImageDataURL(asset.output.dataURL)) {
    return null;
  }

  return {
    elementId: asset.insertedElementId,
    elementIds: [asset.insertedElementId],
    fileId: asset.insertedFileId,
    file: dataURLToFile(
      asset.output.dataURL,
      getGeneratedAssetReferenceFileName(asset, createdAt),
      asset.output.mimeType,
    ),
    dataURL: asset.output.dataURL,
    width: asset.width,
    height: asset.height,
    sourceType: "imported",
    locked: true,
    createdAt,
  };
};

export const isLocalImageDataURL = (value: string) => {
  return value.startsWith("data:image/");
};

export const getGeneratedAssetModeLabel = (mode: AIImageGenerationMode) => {
  if (mode === "text-to-image") {
    return "Text to image";
  }
  if (mode === "image-to-image") {
    return "Reference";
  }
  return "Inpaint";
};

export const getGeneratedAssetReferenceFileName = (
  asset: GeneratedAsset,
  createdAt: number,
) => {
  return `ai-generated-reference-${createdAt}-${
    asset.index + 1
  }.${getExtensionFromMimeType(asset.output.mimeType)}`;
};

export const getGeneratedAssetActionLabels = (
  asset: Pick<GeneratedAsset, "index">,
) => {
  const assetLabel = `generated asset #${asset.index + 1}`;

  return {
    insert: `Insert ${assetLabel} into canvas`,
    useAsReference: `Use ${assetLabel} as reference`,
    reuseSettings: `Reuse generation settings from ${assetLabel}`,
    copyPrompt: `Copy prompt from ${assetLabel}`,
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
