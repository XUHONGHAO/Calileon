import type {
  AIImageGenerationMetadata,
  AIImageGenerationMode,
  AIImageGenerationOutput,
  AIImageGenerationParams,
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
      remoteURL: output.remoteURL,
      revisedPrompt: output.revisedPrompt,
    },
    createdAt,
  };

  if (sourceImages) {
    metadata.sourceImages = sourceImages;
  }

  return metadata;
};
