import type { AIImageGenerationMode, AIModelMediaType } from "../ai/types";

export type AIImageWorkbenchStatusItem = {
  label: string;
  value: string;
  tone: "default" | "ready" | "warning" | "reference" | "mask" | "history";
};

export type AIImageWorkbenchRunStatus =
  | "idle"
  | "generating"
  | "succeeded"
  | "failed"
  | "canceled"
  | "inserted";

export type AIImageWorkbenchStatusInput = {
  mediaType: AIModelMediaType;
  mode: AIImageGenerationMode;
  selectedModelLabel: string | null;
  hasSelectedModelBaseURL: boolean;
  selectedModelId: string;
  prompt: string;
  modelSupportsMode: boolean;
  referenceCount: number;
  selectedImageCount: number;
  hasCurrentMask: boolean;
  hasExcalidrawAPI: boolean;
  isGenerating: boolean;
  runStatus?: AIImageWorkbenchRunStatus;
};

export type AIImageWorkbenchConfigurationNotice = {
  message: string;
  actionLabel: string;
} | null;

export const getAIImageWorkbenchModeLabel = ({
  mediaType,
  mode,
}: Pick<AIImageWorkbenchStatusInput, "mediaType" | "mode">) => {
  if (mediaType !== "image") {
    return getMediaTypeLabel(mediaType);
  }

  if (mode === "text-to-image") {
    return "Text";
  }
  if (mode === "image-to-image") {
    return "Reference";
  }
  return "Inpaint";
};

export const createAIImageWorkbenchStatus = (
  input: AIImageWorkbenchStatusInput,
) => {
  const requiresReference = input.mode !== "text-to-image";
  const requiresMask = input.mode === "inpaint";
  const activeReferenceCount = requiresMask
    ? input.selectedImageCount
    : input.referenceCount;
  const hasPrompt = !!input.prompt.trim();
  const canGenerate =
    input.mediaType === "image" &&
    input.hasExcalidrawAPI &&
    input.hasSelectedModelBaseURL &&
    !!input.selectedModelId &&
    hasPrompt &&
    input.modelSupportsMode &&
    (!requiresReference || activeReferenceCount > 0) &&
    (!requiresMask ||
      (input.selectedImageCount === 1 && input.hasCurrentMask)) &&
    !input.isGenerating;
  const runStatus = input.isGenerating
    ? "generating"
    : input.runStatus || "idle";
  const modelStatus = getModelStatus(input);

  const statusStripItems: AIImageWorkbenchStatusItem[] = [
    {
      label: "Mode",
      value: getAIImageWorkbenchModeLabel(input),
      tone: "default",
    },
    {
      label: "Model",
      value: modelStatus.value,
      tone: modelStatus.tone,
    },
    {
      label: "Prompt",
      value: hasPrompt ? "Ready" : "Empty",
      tone: hasPrompt ? "ready" : "warning",
    },
    {
      label: "Refs",
      value:
        input.mediaType === "image" &&
        (requiresReference || input.referenceCount)
          ? `${activeReferenceCount} active`
          : "Optional",
      tone:
        requiresReference && activeReferenceCount === 0
          ? "warning"
          : "reference",
    },
    {
      label: "Mask",
      value: input.hasCurrentMask ? "Ready" : requiresMask ? "Needed" : "None",
      tone: input.hasCurrentMask
        ? "mask"
        : requiresMask
        ? "warning"
        : "default",
    },
    {
      label: "Run",
      value: getRunStatusLabel(runStatus),
      tone: getRunStatusTone(runStatus),
    },
  ];

  return {
    activeReferenceCount,
    canGenerate,
    requiresMask,
    requiresReference,
    statusStripItems,
  };
};

const getModelStatus = (
  input: AIImageWorkbenchStatusInput,
): Pick<AIImageWorkbenchStatusItem, "value" | "tone"> => {
  if (!input.selectedModelId || !input.selectedModelLabel) {
    return {
      value: "No model",
      tone: "warning",
    };
  }

  if (!input.hasSelectedModelBaseURL) {
    return {
      value: "Missing endpoint",
      tone: "warning",
    };
  }

  if (!input.modelSupportsMode) {
    return {
      value: "Unsupported mode",
      tone: "warning",
    };
  }

  return {
    value: input.selectedModelLabel,
    tone: "ready",
  };
};

export const getAIImageWorkbenchConfigurationNotice = ({
  mediaType,
  hasModelsForMediaType,
  selectedModelId,
  hasSelectedModelBaseURL,
  modelSupportsMode,
}: Pick<
  AIImageWorkbenchStatusInput,
  | "mediaType"
  | "selectedModelId"
  | "hasSelectedModelBaseURL"
  | "modelSupportsMode"
> & {
  hasModelsForMediaType: boolean;
}): AIImageWorkbenchConfigurationNotice => {
  if (!hasModelsForMediaType) {
    return {
      message: `Add ${getMediaTypeLabel(
        mediaType,
      ).toLowerCase()} model in AI Settings.`,
      actionLabel: "Open AI Settings",
    };
  }

  if (selectedModelId && !hasSelectedModelBaseURL) {
    return {
      message: "Add a model endpoint before generating.",
      actionLabel: "Open AI Settings",
    };
  }

  if (selectedModelId && !modelSupportsMode) {
    return {
      message: "Selected model does not support this mode.",
      actionLabel: "Open AI Settings",
    };
  }

  return null;
};

const getRunStatusLabel = (runStatus: AIImageWorkbenchRunStatus) => {
  if (runStatus === "generating") {
    return "Generating";
  }
  if (runStatus === "succeeded") {
    return "Succeeded";
  }
  if (runStatus === "failed") {
    return "Failed";
  }
  if (runStatus === "canceled") {
    return "Canceled";
  }
  if (runStatus === "inserted") {
    return "Inserted";
  }
  return "Ready";
};

const getRunStatusTone = (
  runStatus: AIImageWorkbenchRunStatus,
): AIImageWorkbenchStatusItem["tone"] => {
  if (runStatus === "failed" || runStatus === "canceled") {
    return "warning";
  }
  if (runStatus === "generating") {
    return "history";
  }
  if (runStatus === "succeeded" || runStatus === "inserted") {
    return "ready";
  }
  return "ready";
};

const getMediaTypeLabel = (mediaType: AIModelMediaType) => {
  if (mediaType === "video") {
    return "Video";
  }
  if (mediaType === "audio") {
    return "Audio";
  }
  return "Image";
};
