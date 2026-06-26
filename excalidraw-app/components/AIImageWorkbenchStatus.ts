import { t } from "@excalidraw/excalidraw/i18n";

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
    return t("ai.common.text");
  }
  if (mode === "image-to-image") {
    return t("ai.common.reference");
  }
  return t("ai.common.inpaint");
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
      label: t("ai.workbench.status.labels.mode"),
      value: getAIImageWorkbenchModeLabel(input),
      tone: "default",
    },
    {
      label: t("ai.workbench.status.labels.model"),
      value: modelStatus.value,
      tone: modelStatus.tone,
    },
    {
      label: t("ai.workbench.status.labels.prompt"),
      value: hasPrompt
        ? t("ai.workbench.status.values.ready")
        : t("ai.workbench.status.values.empty"),
      tone: hasPrompt ? "ready" : "warning",
    },
    {
      label: t("ai.workbench.status.labels.refs"),
      value:
        input.mediaType === "image" &&
        (requiresReference || input.referenceCount)
          ? t("ai.workbench.status.values.active", {
              count: activeReferenceCount,
            })
          : t("ai.workbench.status.values.optional"),
      tone:
        requiresReference && activeReferenceCount === 0
          ? "warning"
          : "reference",
    },
    {
      label: t("ai.workbench.status.labels.mask"),
      value: input.hasCurrentMask
        ? t("ai.workbench.status.values.ready")
        : requiresMask
        ? t("ai.workbench.status.values.needed")
        : t("ai.workbench.status.values.none"),
      tone: input.hasCurrentMask
        ? "mask"
        : requiresMask
        ? "warning"
        : "default",
    },
    {
      label: t("ai.workbench.status.labels.run"),
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
      value: t("ai.workbench.status.values.noModel"),
      tone: "warning",
    };
  }

  if (!input.hasSelectedModelBaseURL) {
    return {
      value: t("ai.workbench.status.values.missingEndpoint"),
      tone: "warning",
    };
  }

  if (!input.modelSupportsMode) {
    return {
      value: t("ai.workbench.status.values.unsupportedMode"),
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
      message: t("ai.workbench.status.notice.addModel", {
        mediaType: getMediaTypeLabel(mediaType).toLowerCase(),
      }),
      actionLabel: t("ai.common.openSettings"),
    };
  }

  if (selectedModelId && !hasSelectedModelBaseURL) {
    return {
      message: t("ai.workbench.status.notice.addEndpoint"),
      actionLabel: t("ai.common.openSettings"),
    };
  }

  if (selectedModelId && !modelSupportsMode) {
    return {
      message: t("ai.workbench.status.notice.unsupportedMode"),
      actionLabel: t("ai.common.openSettings"),
    };
  }

  return null;
};

const getRunStatusLabel = (runStatus: AIImageWorkbenchRunStatus) => {
  if (runStatus === "generating") {
    return t("ai.workbench.status.values.generating");
  }
  if (runStatus === "succeeded") {
    return t("ai.workbench.status.values.succeeded");
  }
  if (runStatus === "failed") {
    return t("ai.workbench.status.values.failed");
  }
  if (runStatus === "canceled") {
    return t("ai.workbench.status.values.canceled");
  }
  if (runStatus === "inserted") {
    return t("ai.workbench.status.values.inserted");
  }
  return t("ai.workbench.status.values.ready");
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
    return t("ai.common.video");
  }
  if (mediaType === "audio") {
    return t("ai.common.audio");
  }
  return t("ai.common.image");
};
