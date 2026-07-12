import { sanitizePersistedURL } from "./sanitizePersistedURL";

import type {
  AIImageGenerationMetadata,
  AIImageGenerationMode,
  AIImageGenerationOutput,
  AIImageGenerationParams,
  AIVideoGenerationMetadata,
  AIVideoGenerationMetadataV2,
  AIVideoGenerationMode,
  AIVideoGenerationOutput,
} from "./types";

export const createAIImageGenerationMetadata = ({
  mode,
  model,
  prompt,
  negativePrompt,
  params,
  sourceElementIds,
  sourceImages,
  output,
  index,
  createdAt = new Date().toISOString(),
}: {
  mode: AIImageGenerationMode;
  model: string;
  prompt: string;
  negativePrompt?: string;
  params: AIImageGenerationParams;
  sourceElementIds: string[];
  sourceImages?: AIImageGenerationMetadata["sourceImages"];
  output: AIImageGenerationOutput;
  index: number;
  createdAt?: string;
}): AIImageGenerationMetadata => {
  const metadata: AIImageGenerationMetadata = {
    version: 1,
    kind: "image",
    mode,
    model,
    prompt,
    negativePrompt,
    params,
    sourceElementIds,
    output: {
      provider: "openai-compatible",
      index,
      mimeType: output.mimeType,
      remoteURL: output.remoteURL
        ? sanitizePersistedURL(output.remoteURL)
        : undefined,
      revisedPrompt: output.revisedPrompt,
    },
    createdAt,
  };

  if (sourceImages) {
    metadata.sourceImages = sourceImages;
  }

  return metadata;
};

export const createAIVideoGenerationMetadata = ({
  mode,
  model,
  prompt,
  params,
  output,
  createdAt = new Date().toISOString(),
}: {
  mode: AIVideoGenerationMode;
  model: string;
  prompt: string;
  params: AIImageGenerationParams;
  output: AIVideoGenerationOutput;
  createdAt?: string;
}): AIVideoGenerationMetadata => {
  return {
    version: 1,
    kind: "video",
    mode,
    model,
    prompt,
    params,
    videoURL: output.videoURL,
    mimeType: output.mimeType,
    durationSeconds: output.durationSeconds,
    revisedPrompt: output.revisedPrompt,
    createdAt,
  };
};

export const createAIVideoAssetMetadata = ({
  mode,
  model,
  prompt,
  params,
  asset,
  createdAt = new Date().toISOString(),
}: {
  mode: AIVideoGenerationMode;
  model: string;
  prompt: string;
  params: AIImageGenerationParams;
  asset: {
    assetId: string;
    mimeType: string;
    width?: number;
    height?: number;
    durationSeconds?: number;
    revisedPrompt?: string;
  };
  createdAt?: string;
}): AIVideoGenerationMetadataV2 => ({
  version: 2,
  kind: "video",
  mode,
  model,
  prompt,
  params,
  assetId: asset.assetId,
  mimeType: asset.mimeType,
  width: asset.width,
  height: asset.height,
  durationSeconds: asset.durationSeconds,
  revisedPrompt: asset.revisedPrompt,
  createdAt,
});
