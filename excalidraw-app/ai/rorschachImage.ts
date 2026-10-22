import { t } from "@excalidraw/excalidraw/i18n";

import type { DataURL } from "@excalidraw/excalidraw/types";

import { generateImagesWithOpenAIAdapter } from "./openAIImageAdapter";
import {
  describeErrorMessage,
  toRorschachImageOutput,
} from "./rorschachSession";

import type { AIImageModel, AIImageProviderConfig } from "./types";
import type {
  RorschachAttempt,
  RorschachImageOutput,
  RorschachPersona,
} from "./rorschachTypes";

export type RunRorschachImageOptions = {
  attempt: RorschachAttempt;
  imageDataURL: string;
  imagePrompt: string;
  persona: RorschachPersona;
  model: AIImageModel;
  config: AIImageProviderConfig;
  signal: AbortSignal;
  isCurrent: () => boolean;
  onPatch: (attemptId: string, patch: Partial<RorschachAttempt>) => void;
  deps?: {
    generate?: typeof generateImagesWithOpenAIAdapter;
  };
};

export const RORSCHACH_IMAGE_PARAMS = { size: "1024x1024", n: 1 };

/**
 * Stage 2: image-to-image completion on top of the original scribble.
 * Always reuses the attempt's already validated prompt; it never re-reads.
 */
export const runRorschachImage = async ({
  attempt,
  imageDataURL,
  imagePrompt,
  persona,
  model,
  config,
  signal,
  isCurrent,
  onPatch,
  deps,
}: RunRorschachImageOptions): Promise<RorschachImageOutput | null> => {
  const generate = deps?.generate || generateImagesWithOpenAIAdapter;

  onPatch(attempt.id, {
    imageStatus: "running",
    imageError: null,
    imageOutput: null,
  });

  try {
    const outputs = await generate({
      config: {
        ...config,
        defaultModel: model.model,
        models: [
          model,
          ...config.models.filter((item) => item.id !== model.id),
        ],
      },
      mode: "image-to-image",
      model: model.model,
      prompt: imagePrompt,
      params: RORSCHACH_IMAGE_PARAMS,
      sources: [
        {
          elementId: model.id,
          file: new File([], "rorschach-source.png", { type: "image/png" }),
          dataURL: imageDataURL as DataURL,
          width: 1024,
          height: 1024,
        },
      ],
      signal,
    });

    if (!isCurrent()) {
      return null;
    }

    const output = toRorschachImageOutput(outputs[0] || null);
    if (!output) {
      onPatch(attempt.id, {
        imageStatus: "failed",
        imageError: t("labs.rorschach.errors.emptyImage"),
      });
      return null;
    }

    onPatch(attempt.id, {
      imageStatus: "succeeded",
      imageOutput: output,
      imageError: null,
    });
    return output;
  } catch (error) {
    if (!isCurrent()) {
      return null;
    }
    onPatch(attempt.id, {
      imageStatus: signal.aborted ? "cancelled" : "failed",
      imageError: signal.aborted
        ? t("labs.rorschach.errors.cancelled")
        : describeErrorMessage(error),
    });
    return null;
  }
};
