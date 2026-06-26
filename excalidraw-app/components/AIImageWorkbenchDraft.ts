import type { AIImageWorkbenchDraftState } from "./AIImageWorkbench";
import type {
  AIGenerationLogEntry,
  AIImageGenerationMode,
  PromptTemplate,
} from "../ai/types";

export const createCopyPromptActionState = (prompt: string) => ({
  canCopy: prompt.trim().length > 0,
  prompt,
});

export const createSendPromptToAssistantActionState = (prompt: string) => ({
  canSend: prompt.trim().length > 0,
  prompt: prompt.trim(),
});

export const sendPromptToWorkbenchDraft = (
  current: AIImageWorkbenchDraftState,
  prompt: string,
): AIImageWorkbenchDraftState => ({
  ...current,
  mediaType: "image",
  mode: "text-to-image",
  imageModes: {
    ...current.imageModes,
    "text-to-image": {
      ...current.imageModes["text-to-image"],
      prompt,
    },
  },
});

export const applyPromptTemplateToWorkbenchDraft = (
  current: AIImageWorkbenchDraftState,
  template: PromptTemplate,
): AIImageWorkbenchDraftState => {
  const nextMode = template.modes[0] || "text-to-image";

  return {
    ...current,
    mediaType: "image",
    mode: nextMode,
    imageModes: {
      ...current.imageModes,
      [nextMode]: {
        ...current.imageModes[nextMode],
        prompt: template.template,
      },
    },
  };
};

export const reuseGenerationLogInWorkbenchDraft = (
  current: AIImageWorkbenchDraftState,
  log: AIGenerationLogEntry,
): AIImageWorkbenchDraftState => {
  if (log.mediaType === "image" && isAIImageGenerationMode(log.mode)) {
    return {
      ...current,
      mediaType: "image",
      mode: log.mode,
      imageModes: {
        ...current.imageModes,
        [log.mode]: {
          ...current.imageModes[log.mode],
          selectedModelId:
            log.model.id || current.imageModes[log.mode].selectedModelId,
          prompt: log.prompt,
          negativePrompt: log.negativePrompt || "",
          params: {
            ...current.imageModes[log.mode].params,
            ...log.params,
          },
        },
      },
    };
  }

  if (log.mediaType === "video") {
    return {
      ...current,
      mediaType: "video",
      video: {
        ...current.video,
        selectedModelId: log.model.id || current.video.selectedModelId,
        prompt: log.prompt,
        negativePrompt: log.negativePrompt || "",
        params: {
          ...current.video.params,
          ...log.params,
        },
      },
    };
  }

  if (log.mediaType === "audio") {
    return {
      ...current,
      mediaType: "audio",
      audio: {
        ...current.audio,
        selectedModelId: log.model.id || current.audio.selectedModelId,
        prompt: log.prompt,
        negativePrompt: log.negativePrompt || "",
        params: {
          ...current.audio.params,
          ...log.params,
        },
      },
    };
  }

  return current;
};

export const isAIImageGenerationMode = (
  mode: AIGenerationLogEntry["mode"],
): mode is AIImageGenerationMode => {
  return (
    mode === "text-to-image" || mode === "image-to-image" || mode === "inpaint"
  );
};
