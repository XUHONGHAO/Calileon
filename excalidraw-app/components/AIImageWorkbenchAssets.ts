import { t } from "@excalidraw/excalidraw/i18n";

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
    return t("ai.settings.options.textToImage");
  }
  if (mode === "image-to-image") {
    return t("ai.common.reference");
  }
  return t("ai.common.inpaint");
};

export const getGeneratedAssetReferenceFileName = (
  asset: GeneratedAsset,
  createdAt: number,
) => {
  return `ai-generated-reference-${createdAt}-${
    asset.index + 1
  }.${getExtensionFromMimeType(asset.output.mimeType)}`;
};

export const getGeneratedAssetDownloadFileName = (asset: GeneratedAsset) => {
  return `ai-generated-${asset.index + 1}.${getExtensionFromMimeType(
    asset.output.mimeType,
  )}`;
};

export const downloadImageFromURL = (url: string, fileName: string) => {
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  // Remote provider URLs may not honor the download attribute cross-origin, so
  // fall back to opening them in a new tab where the user can save manually.
  if (!isLocalImageDataURL(url)) {
    anchor.target = "_blank";
  }
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
};

export const downloadGeneratedAsset = (asset: GeneratedAsset) => {
  downloadImageFromURL(
    asset.output.dataURL,
    getGeneratedAssetDownloadFileName(asset),
  );
};

export const getImageDownloadFileName = (
  mimeType: string | undefined,
  createdAt: number,
) => {
  return `ai-generated-${createdAt}.${getExtensionFromMimeType(
    mimeType || "image/png",
  )}`;
};

export const getGeneratedAssetActionLabels = (
  asset: Pick<GeneratedAsset, "index">,
) => {
  const assetLabel = t("ai.workbench.assetActions.assetLabel", {
    index: asset.index + 1,
  });

  return {
    insert: t("ai.workbench.assetActions.insert", { asset: assetLabel }),
    useAsReference: t("ai.workbench.assetActions.useAsReference", {
      asset: assetLabel,
    }),
    reuseSettings: t("ai.workbench.assetActions.reuseSettings", {
      asset: assetLabel,
    }),
    copyPrompt: t("ai.workbench.assetActions.copyPrompt", {
      asset: assetLabel,
    }),
    download: t("ai.workbench.assetActions.download", {
      asset: assetLabel,
    }),
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
