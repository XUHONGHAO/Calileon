import type {
  AIImageWorkbenchDraftState,
  ReplacedWorkbenchPrompt,
} from "./AIImageWorkbench";
import type {
  AIGenerationLogEntry,
  AIImageGenerationMode,
  AIModelMediaType,
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

const IMAGE_GENERATION_MODES: readonly AIImageGenerationMode[] = [
  "text-to-image",
  "image-to-image",
  "inpaint",
];

/**
 * The three image modes share one prompt and negative prompt (model and params
 * stay per mode), so switching Text / Reference / Inpaint never makes the
 * prompt "disappear".
 */
export const withSharedImagePrompt = (
  imageModes: AIImageWorkbenchDraftState["imageModes"],
  patch: { prompt?: string; negativePrompt?: string },
): AIImageWorkbenchDraftState["imageModes"] => {
  const next = { ...imageModes };
  for (const mode of IMAGE_GENERATION_MODES) {
    next[mode] = { ...imageModes[mode], ...patch };
  }
  return next;
};

const getMediaDraft = (
  current: AIImageWorkbenchDraftState,
  mediaType: AIModelMediaType,
) =>
  mediaType === "image" ? current.imageModes[current.mode] : current[mediaType];

/**
 * An external write (assistant hand-off, template, history reuse) replaces the
 * prompt in place. Keep what it replaced so the workbench can offer "Restore"
 * instead of the text being lost; `null` when nothing non-empty was replaced.
 */
const getReplacedPrompt = (
  current: AIImageWorkbenchDraftState,
  mediaType: AIModelMediaType,
  next: { prompt: string; negativePrompt?: string },
): ReplacedWorkbenchPrompt | null => {
  const draft = getMediaDraft(current, mediaType);
  const replacesPrompt = !!draft.prompt.trim() && draft.prompt !== next.prompt;
  const replacesNegativePrompt =
    next.negativePrompt !== undefined &&
    !!draft.negativePrompt.trim() &&
    draft.negativePrompt !== next.negativePrompt;

  return replacesPrompt || replacesNegativePrompt
    ? {
        mediaType,
        prompt: draft.prompt,
        negativePrompt: draft.negativePrompt,
      }
    : null;
};

export const sendPromptToWorkbenchDraft = (
  current: AIImageWorkbenchDraftState,
  prompt: string,
): AIImageWorkbenchDraftState => ({
  ...current,
  mediaType: "image",
  mode: "text-to-image",
  imageModes: withSharedImagePrompt(current.imageModes, { prompt }),
  replacedPrompt: getReplacedPrompt(current, "image", { prompt }),
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
    imageModes: withSharedImagePrompt(current.imageModes, {
      prompt: template.template,
    }),
    replacedPrompt: getReplacedPrompt(current, "image", {
      prompt: template.template,
    }),
  };
};

export const reuseGenerationLogInWorkbenchDraft = (
  current: AIImageWorkbenchDraftState,
  log: AIGenerationLogEntry,
): AIImageWorkbenchDraftState => {
  const nextPrompt = {
    prompt: log.prompt,
    negativePrompt: log.negativePrompt || "",
  };

  if (log.mediaType === "image" && isAIImageGenerationMode(log.mode)) {
    const imageModes = withSharedImagePrompt(current.imageModes, nextPrompt);

    return {
      ...current,
      mediaType: "image",
      mode: log.mode,
      imageModes: {
        ...imageModes,
        [log.mode]: {
          ...imageModes[log.mode],
          selectedModelId:
            log.model.id || current.imageModes[log.mode].selectedModelId,
          params: {
            ...current.imageModes[log.mode].params,
            ...log.params,
          },
        },
      },
      replacedPrompt: getReplacedPrompt(current, "image", nextPrompt),
    };
  }

  if (log.mediaType === "video" || log.mediaType === "audio") {
    const mediaType = log.mediaType;

    return {
      ...current,
      mediaType,
      [mediaType]: {
        ...current[mediaType],
        selectedModelId: log.model.id || current[mediaType].selectedModelId,
        ...nextPrompt,
        params: {
          ...current[mediaType].params,
          ...log.params,
        },
      },
      replacedPrompt: getReplacedPrompt(current, mediaType, nextPrompt),
    };
  }

  return current;
};

/** Puts a replaced prompt back and clears the offer. */
export const restoreReplacedPromptInWorkbenchDraft = (
  current: AIImageWorkbenchDraftState,
): AIImageWorkbenchDraftState => {
  const replaced = current.replacedPrompt;

  if (!replaced) {
    return current;
  }

  const restored = {
    prompt: replaced.prompt,
    negativePrompt: replaced.negativePrompt,
  };

  if (replaced.mediaType === "image") {
    return {
      ...current,
      mediaType: "image",
      imageModes: withSharedImagePrompt(current.imageModes, restored),
      replacedPrompt: null,
    };
  }

  return {
    ...current,
    mediaType: replaced.mediaType,
    [replaced.mediaType]: { ...current[replaced.mediaType], ...restored },
    replacedPrompt: null,
  };
};

export const isAIImageGenerationMode = (
  mode: AIGenerationLogEntry["mode"],
): mode is AIImageGenerationMode => {
  return (
    mode === "text-to-image" || mode === "image-to-image" || mode === "inpaint"
  );
};
