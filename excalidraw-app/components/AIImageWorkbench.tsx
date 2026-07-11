import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyTextToSystemClipboard } from "@excalidraw/excalidraw/clipboard";
import { Button } from "@excalidraw/excalidraw/components/Button";
import { t } from "@excalidraw/excalidraw/i18n";
import {
  getSelectedElements,
  isInitializedImageElement,
} from "@excalidraw/element";
import { pointFrom } from "@excalidraw/math";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import type {
  ExcalidrawFreeDrawElement,
  InitializedExcalidrawImageElement,
} from "@excalidraw/element/types";
import type { LocalPoint } from "@excalidraw/math";

import { STORAGE_KEYS } from "../app_constants";
import {
  AI_IMAGE_CONFIG_UPDATED_EVENT,
  DEFAULT_AI_IMAGE_REQUEST_TIMEOUT_SECONDS,
  loadAIImageConfig,
  supportsAIImageMode,
} from "../ai/config";
import {
  DEFAULT_AI_IMAGE_NATIVE_MODEL,
  getAIImageAspectRatioOptions,
  getAIImageResolutionOptions,
  resolveAIImageSize,
} from "../ai/imageDimensions";
import {
  fileToDataURL,
  insertGeneratedImageIntoCanvas,
} from "../ai/imageCanvas";
import {
  createImportedReferenceSource,
  DEFAULT_AI_REFERENCE_EXPORT_OPTIONS,
  exportSelectionToReferenceSource,
} from "../ai/canvasExport";
import {
  AIImageGenerationError,
  buildOpenAIImageEndpoint,
  generateImagesWithOpenAIAdapter,
} from "../ai/openAIImageAdapter";
import {
  buildVideoOutput,
  buildVideoSubmitEndpoint,
  pollVideoTask,
  submitVideoTask,
} from "../ai/openAIVideoAdapter";
import {
  getVideoDimensions,
  insertVideoEmbedIntoCanvas,
} from "../ai/videoCanvas";
import {
  loadPendingVideoTasks,
  removeVideoTask,
  updateVideoTaskStatus,
  upsertVideoTask,
} from "../ai/videoTaskStore";
import {
  createAIImageGenerationMetadata,
  createAIVideoGenerationMetadata,
} from "../ai/metadata";
import {
  appendAIGenerationLog,
  createAIGenerationLogEntry,
  createErrorResponseDetails,
  createSuccessResponseDetails,
} from "../ai/generationLog";
import {
  AI_PROMPT_TEMPLATES_UPDATED_EVENT,
  getPromptTemplatesForMode,
} from "../ai/promptTemplates";
import { createAIReferenceId } from "../ai/referenceIds";
import { createAIOpenSettingsEvent } from "../ai/workflowEvents";

import {
  createGeneratedAssetReferenceSource,
  downloadGeneratedAsset,
  downloadImageFromURL,
  getGeneratedAssetActionLabels,
  getGeneratedAssetModeLabel,
  getImageDownloadFileName,
  isLocalImageDataURL,
} from "./AIImageWorkbenchAssets";
import { PromptEditor } from "./AIImageWorkbenchPromptEditor";
import {
  appendSelectedImageSources,
  clearReferenceWeight,
  loadPersistedReferenceState,
  markMissingReferenceElements,
  persistReferenceState,
  reindexReferenceImages,
  validatePromptReferences,
} from "./AIImageWorkbenchReferences";
import {
  getMaskPersistenceKey,
  loadPersistedMaskState,
  persistMaskState,
} from "./AIImageWorkbenchMasks";
import {
  createAIImageWorkbenchStatus,
  getAIImageWorkbenchConfigurationNotice,
} from "./AIImageWorkbenchStatus";
import {
  createCopyPromptActionState,
  createSendPromptToAssistantActionState,
  isAIImageGenerationMode,
} from "./AIImageWorkbenchDraft";

import "./AIImageWorkbench.scss";

import type {
  KeyboardEvent as ReactKeyboardEvent,
  SetStateAction,
} from "react";
import type {
  AIImageGenerationMetadata,
  AIImageGenerationMode,
  AIImageGenerationOutput,
  AIImageGenerationParams,
  AIImageEditableMask,
  AIImageProviderConfig,
  AIImageSourceEnhanced,
  AIModelMediaType,
  AIMaskReadyPayload,
  AIReferenceExportOptions,
  AIVideoGenerationMode,
  PendingVideoTask,
  PromptTemplate,
  PromptTemplateCategory,
} from "../ai/types";
import type { GeneratedImagePlacement } from "../ai/imageCanvas";
import type { PromptEditorHandle } from "./AIImageWorkbenchPromptEditor";
import type { AIImageWorkbenchRunStatus } from "./AIImageWorkbenchStatus";
import type { GeneratedAsset } from "./AIImageWorkbenchAssets";
import type { CloudAITaskRun } from "../data/cloud/cloudAITasks";

const DEFAULT_PARAMS: AIImageGenerationParams = {
  size: "1024x1024",
  n: 1,
  seed: null,
  quality: "auto",
  style: "",
  referenceStrength: 0.6,
  duration: 5,
  fps: 24,
  resolution: "auto",
  aspectRatio: "auto",
  audioFormat: "mp3",
  voice: "",
};

// Video reuses the shared params shape but must NOT inherit the image pixel
// `size` ("1024x1024"), which gateways read as a 1:1 aspect ratio. Video drives
// framing through `aspectRatio` + `resolution` instead, with concrete defaults
// so a request carries them even when the user never touches the dropdowns.
const DEFAULT_VIDEO_PARAMS: AIImageGenerationParams = {
  ...DEFAULT_PARAMS,
  size: "",
  duration: 10,
  aspectRatio: "16:9",
  resolution: "720P",
};

const MODE_OPTIONS: Array<{
  value: AIImageGenerationMode;
  labelKey: "ai.common.text" | "ai.common.reference" | "ai.common.inpaint";
}> = [
  { value: "text-to-image", labelKey: "ai.common.text" },
  { value: "image-to-image", labelKey: "ai.common.reference" },
  { value: "inpaint", labelKey: "ai.common.inpaint" },
];

const MEDIA_TYPE_OPTIONS: Array<{
  value: AIModelMediaType;
  labelKey: "ai.common.image" | "ai.common.video" | "ai.common.audio";
}> = [
  { value: "image", labelKey: "ai.common.image" },
  { value: "video", labelKey: "ai.common.video" },
  { value: "audio", labelKey: "ai.common.audio" },
];

const MAX_IMAGE_COUNT = 10;
// Most OpenAI-compatible image APIs accept a 32-bit unsigned seed. Keep the
// random range within that so manually typed and dice-rolled seeds behave the
// same across providers.
const MAX_SEED = 2147483647;

const createRandomSeed = () => Math.floor(Math.random() * (MAX_SEED + 1));

const diceIcon = (
  <svg
    aria-hidden="true"
    focusable="false"
    viewBox="0 0 24 24"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.75"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="3" width="18" height="18" rx="3" />
    <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="16" cy="8" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="8" cy="16" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="16" cy="16" r="1.2" fill="currentColor" stroke="none" />
  </svg>
);

type AIWorkbenchGenerationDraftState = {
  selectedModelId: string;
  prompt: string;
  negativePrompt: string;
  params: AIImageGenerationParams;
};

type AIImageModeDraftState = AIWorkbenchGenerationDraftState & {
  masksByImageId: Record<string, AIImageEditableMask>;
};

export type AIImageWorkbenchDraftState = {
  mediaType: AIModelMediaType;
  mode: AIImageGenerationMode;
  imageModes: Record<AIImageGenerationMode, AIImageModeDraftState>;
  video: AIWorkbenchGenerationDraftState;
  audio: AIWorkbenchGenerationDraftState;
};

type AIImageWorkbenchProps = {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  draftState?: AIImageWorkbenchDraftState;
  onDraftStateChange?: (
    value: SetStateAction<AIImageWorkbenchDraftState>,
  ) => void;
  onEnterMaskEditing?: (
    imageId: string,
    maskElements?: readonly ExcalidrawFreeDrawElement[],
  ) => void;
  onMaskReady?: (
    handler: ((payload: AIMaskReadyPayload) => void) | null,
  ) => void;
  onSendPromptToAssistant?: (prompt: string) => void;
  referenceAddRequest?: { id: number } | null;
  onCloudAITaskRun?: (run: CloudAITaskRun) => void | Promise<void>;
};

const isAIModelMediaType = (value: unknown): value is AIModelMediaType => {
  return value === "image" || value === "video" || value === "audio";
};

// The active media type (image / video / audio) is persisted so a page refresh
// keeps the user on the same generation tab instead of resetting to the default
// model's media type.
const loadPersistedMediaType = (): AIModelMediaType | null => {
  try {
    const raw = localStorage.getItem(
      STORAGE_KEYS.LOCAL_STORAGE_AI_WORKBENCH_MEDIA_TYPE,
    );

    return isAIModelMediaType(raw) ? raw : null;
  } catch {
    return null;
  }
};

const savePersistedMediaType = (mediaType: AIModelMediaType) => {
  try {
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_AI_WORKBENCH_MEDIA_TYPE,
      mediaType,
    );
  } catch {
    // Ignore storage failures (private mode / quota); the tab just won't persist.
  }
};

// The prompt, negative prompt, selected model and generation params are worth
// keeping across reloads so a half-written prompt survives an accidental
// refresh. `masksByImageId` is deliberately dropped: masks are large base64
// blobs bound to specific canvas images (persisted separately with the
// reference tray), so they must not bloat this lightweight draft snapshot.
const stripDraftGeneration = (draft: AIWorkbenchGenerationDraftState) => ({
  selectedModelId: draft.selectedModelId,
  prompt: draft.prompt,
  negativePrompt: draft.negativePrompt,
  params: draft.params,
});

const savePersistedWorkbenchDraft = (draft: AIImageWorkbenchDraftState) => {
  try {
    const payload = {
      mediaType: draft.mediaType,
      mode: draft.mode,
      imageModes: {
        "text-to-image": stripDraftGeneration(
          draft.imageModes["text-to-image"],
        ),
        "image-to-image": stripDraftGeneration(
          draft.imageModes["image-to-image"],
        ),
        inpaint: stripDraftGeneration(draft.imageModes.inpaint),
      },
      video: stripDraftGeneration(draft.video),
      audio: stripDraftGeneration(draft.audio),
    };

    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_AI_WORKBENCH_DRAFT,
      JSON.stringify(payload),
    );
  } catch {
    // Ignore storage failures (private mode / quota); the draft just won't persist.
  }
};

const loadPersistedWorkbenchDraft = (): {
  mode?: AIImageGenerationMode;
  imageModes?: Partial<
    Record<AIImageGenerationMode, Partial<AIWorkbenchGenerationDraftState>>
  >;
  video?: Partial<AIWorkbenchGenerationDraftState>;
  audio?: Partial<AIWorkbenchGenerationDraftState>;
} | null => {
  try {
    const raw = localStorage.getItem(
      STORAGE_KEYS.LOCAL_STORAGE_AI_WORKBENCH_DRAFT,
    );

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);

    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

// Restores a persisted per-mode draft onto a freshly built default, keeping the
// default whenever a field is missing. `selectedModelId` is only honored when
// the model still exists in the current config, so a deleted/renamed model
// falls back to the mode's default instead of pointing at a dead id.
const mergePersistedGenerationDraft = <
  T extends AIWorkbenchGenerationDraftState,
>(
  base: T,
  persisted: Partial<AIWorkbenchGenerationDraftState> | undefined,
  config: AIImageProviderConfig,
): T => {
  if (!persisted) {
    return base;
  }

  const modelExists =
    typeof persisted.selectedModelId === "string" &&
    config.models.some((model) => model.id === persisted.selectedModelId);

  return {
    ...base,
    selectedModelId: modelExists
      ? (persisted.selectedModelId as string)
      : base.selectedModelId,
    prompt:
      typeof persisted.prompt === "string" ? persisted.prompt : base.prompt,
    negativePrompt:
      typeof persisted.negativePrompt === "string"
        ? persisted.negativePrompt
        : base.negativePrompt,
    params:
      persisted.params && typeof persisted.params === "object"
        ? { ...base.params, ...persisted.params }
        : base.params,
  };
};

const loadInitialWorkbenchState = () => {
  const config = loadAIImageConfig();
  const defaultModel = config.models.find(
    (model) => model.id === config.defaultModel,
  );

  return {
    config,
    mediaType:
      loadPersistedMediaType() ||
      defaultModel?.mediaType ||
      ("image" as AIModelMediaType),
    selectedModelId: config.defaultModel,
  };
};

type AIWorkbenchT = typeof t;

const createDefaultParams = (): AIImageGenerationParams => ({
  ...DEFAULT_PARAMS,
});

const createGenerationDraftState = (
  selectedModelId: string,
  params: AIImageGenerationParams = createDefaultParams(),
): AIWorkbenchGenerationDraftState => ({
  selectedModelId,
  prompt: "",
  negativePrompt: "",
  params,
});

const createImageModeDraftState = (
  selectedModelId: string,
): AIImageModeDraftState => ({
  ...createGenerationDraftState(selectedModelId),
  masksByImageId: {},
});

export const createInitialAIImageWorkbenchDraftState =
  (): AIImageWorkbenchDraftState => {
    const initialState = loadInitialWorkbenchState();
    const config = initialState.config;
    const imageTextModelId = getDefaultModelIdForImageMode(
      config,
      "text-to-image",
    );
    const imageReferenceModelId = getDefaultModelIdForImageMode(
      config,
      "image-to-image",
    );
    const imageInpaintModelId = getDefaultModelIdForImageMode(
      config,
      "inpaint",
    );

    const defaults: AIImageWorkbenchDraftState = {
      mediaType: initialState.mediaType,
      mode: "text-to-image",
      imageModes: {
        "text-to-image": createImageModeDraftState(imageTextModelId),
        "image-to-image": createImageModeDraftState(imageReferenceModelId),
        inpaint: createImageModeDraftState(imageInpaintModelId),
      },
      video: createGenerationDraftState(
        getDefaultModelIdForMediaType(config, "video"),
        { ...DEFAULT_VIDEO_PARAMS },
      ),
      audio: createGenerationDraftState(
        getDefaultModelIdForMediaType(config, "audio"),
      ),
    };

    const persisted = loadPersistedWorkbenchDraft();

    if (!persisted) {
      return defaults;
    }

    return {
      // mediaType keeps its dedicated persistence (loadPersistedMediaType) so
      // the two stay consistent; mode falls back to the default when absent.
      mediaType: defaults.mediaType,
      mode:
        persisted.mode && isAIImageGenerationMode(persisted.mode)
          ? persisted.mode
          : defaults.mode,
      imageModes: {
        "text-to-image": {
          ...mergePersistedGenerationDraft(
            defaults.imageModes["text-to-image"],
            persisted.imageModes?.["text-to-image"],
            config,
          ),
          masksByImageId: {},
        },
        "image-to-image": {
          ...mergePersistedGenerationDraft(
            defaults.imageModes["image-to-image"],
            persisted.imageModes?.["image-to-image"],
            config,
          ),
          masksByImageId: {},
        },
        inpaint: {
          ...mergePersistedGenerationDraft(
            defaults.imageModes.inpaint,
            persisted.imageModes?.inpaint,
            config,
          ),
          masksByImageId: {},
        },
      },
      video: mergePersistedGenerationDraft(
        defaults.video,
        persisted.video,
        config,
      ),
      audio: mergePersistedGenerationDraft(
        defaults.audio,
        persisted.audio,
        config,
      ),
    };
  };

export const AIImageWorkbench = ({
  excalidrawAPI,
  draftState,
  onDraftStateChange,
  onEnterMaskEditing,
  onMaskReady,
  onSendPromptToAssistant,
  referenceAddRequest,
  onCloudAITaskRun,
}: AIImageWorkbenchProps) => {
  const [initialState] = useState(() => ({
    config: loadAIImageConfig(),
  }));
  const [config, setConfig] = useState<AIImageProviderConfig>(
    initialState.config,
  );
  const [internalDraftState, setInternalDraftState] =
    useState<AIImageWorkbenchDraftState>(
      createInitialAIImageWorkbenchDraftState,
    );
  const activeDraftState = draftState || internalDraftState;
  const setActiveDraftState = onDraftStateChange || setInternalDraftState;
  const { mediaType, mode } = activeDraftState;

  // Persist the draft (prompt / negative prompt / model / params per mode) so a
  // refresh keeps a half-written prompt and the chosen model. Debounced so a
  // burst of keystrokes writes localStorage once. mediaType has its own
  // dedicated persistence effect below.
  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      savePersistedWorkbenchDraft(activeDraftState);
    }, 300);

    return () => window.clearTimeout(timeoutId);
  }, [activeDraftState]);
  const activeGenerationDraft =
    mediaType === "image"
      ? activeDraftState.imageModes[mode]
      : activeDraftState[mediaType];

  const notifyCloudAITaskRun = useCallback(
    (run: CloudAITaskRun) => {
      if (!onCloudAITaskRun) {
        return;
      }

      void Promise.resolve(onCloudAITaskRun(run)).catch((error) => {
        console.error("Cloud AI task recording failed", error);
      });
    },
    [onCloudAITaskRun],
  );
  const { selectedModelId, prompt, negativePrompt, params } =
    activeGenerationDraft;
  const inpaintDraft = activeDraftState.imageModes.inpaint;
  const updateActiveGenerationDraft = useCallback(
    (
      updater: (
        current: AIWorkbenchGenerationDraftState,
      ) => AIWorkbenchGenerationDraftState,
    ) => {
      setActiveDraftState((current) => {
        if (current.mediaType === "image") {
          const currentMode = current.mode;
          const currentModeDraft = current.imageModes[currentMode];

          return {
            ...current,
            imageModes: {
              ...current.imageModes,
              [currentMode]: {
                ...currentModeDraft,
                ...updater(currentModeDraft),
              },
            },
          };
        }

        return {
          ...current,
          [current.mediaType]: updater(current[current.mediaType]),
        };
      });
    },
    [setActiveDraftState],
  );
  const setMediaType = useCallback(
    (nextMediaType: AIModelMediaType) => {
      savePersistedMediaType(nextMediaType);
      setActiveDraftState((current) => ({
        ...current,
        mediaType: nextMediaType,
      }));
    },
    [setActiveDraftState],
  );
  const setSelectedModelId = useCallback(
    (nextSelectedModelId: string) => {
      updateActiveGenerationDraft((current) => ({
        ...current,
        selectedModelId: nextSelectedModelId,
      }));
    },
    [updateActiveGenerationDraft],
  );
  const setMode = useCallback(
    (nextMode: AIImageGenerationMode) => {
      setActiveDraftState((current) => ({
        ...current,
        mode: nextMode,
      }));
    },
    [setActiveDraftState],
  );
  const setPrompt = useCallback(
    (nextPrompt: string) => {
      updateActiveGenerationDraft((current) => ({
        ...current,
        prompt: nextPrompt,
      }));
    },
    [updateActiveGenerationDraft],
  );
  const setNegativePrompt = useCallback(
    (nextNegativePrompt: string) => {
      updateActiveGenerationDraft((current) => ({
        ...current,
        negativePrompt: nextNegativePrompt,
      }));
    },
    [updateActiveGenerationDraft],
  );
  const setParams = useCallback(
    (nextParams: SetStateAction<AIImageGenerationParams>) => {
      updateActiveGenerationDraft((current) => ({
        ...current,
        params:
          typeof nextParams === "function"
            ? nextParams(current.params)
            : nextParams,
      }));
    },
    [updateActiveGenerationDraft],
  );
  const setMaskForImage = useCallback(
    (imageId: string, nextMask: AIImageEditableMask) => {
      setActiveDraftState((current) => ({
        ...current,
        imageModes: {
          ...current.imageModes,
          inpaint: {
            ...current.imageModes.inpaint,
            masksByImageId: {
              ...current.imageModes.inpaint.masksByImageId,
              [imageId]: nextMask,
            },
          },
        },
      }));
    },
    [setActiveDraftState],
  );
  const patchMaskDataURLForImage = useCallback(
    (
      imageId: string,
      updatedAt: number,
      dataURL: AIImageEditableMask["dataURL"],
    ) => {
      setActiveDraftState((current) => {
        const currentMask = current.imageModes.inpaint.masksByImageId[imageId];

        if (!currentMask || currentMask.updatedAt !== updatedAt) {
          return current;
        }

        return {
          ...current,
          imageModes: {
            ...current.imageModes,
            inpaint: {
              ...current.imageModes.inpaint,
              masksByImageId: {
                ...current.imageModes.inpaint.masksByImageId,
                [imageId]: {
                  ...currentMask,
                  dataURL,
                },
              },
            },
          },
        };
      });
    },
    [setActiveDraftState],
  );
  const clearMaskForImage = useCallback(
    (imageId: string) => {
      setActiveDraftState((current) => {
        const nextMasksByImageId = {
          ...current.imageModes.inpaint.masksByImageId,
        };
        delete nextMasksByImageId[imageId];

        return {
          ...current,
          imageModes: {
            ...current.imageModes,
            inpaint: {
              ...current.imageModes.inpaint,
              masksByImageId: nextMasksByImageId,
            },
          },
        };
      });
    },
    [setActiveDraftState],
  );
  const pruneMasksForElements = useCallback(
    (elements: readonly { id: string; isDeleted?: boolean }[]) => {
      setActiveDraftState((current) => {
        const masksByImageId = current.imageModes.inpaint.masksByImageId;
        const maskImageIds = Object.keys(masksByImageId);

        if (!maskImageIds.length) {
          return current;
        }

        const availableElementIds = new Set(
          elements
            .filter((element) => !element.isDeleted)
            .map((element) => element.id),
        );
        const nextMasksByImageId = { ...masksByImageId };
        let didPrune = false;

        for (const imageId of maskImageIds) {
          if (!availableElementIds.has(imageId)) {
            delete nextMasksByImageId[imageId];
            didPrune = true;
          }
        }

        if (!didPrune) {
          return current;
        }

        return {
          ...current,
          imageModes: {
            ...current.imageModes,
            inpaint: {
              ...current.imageModes.inpaint,
              masksByImageId: nextMasksByImageId,
            },
          },
        };
      });
    },
    [setActiveDraftState],
  );
  const [selectedSources, setSelectedSources] = useState<
    AIImageSourceEnhanced[]
  >([]);
  const [currentSelectedImageSources, setCurrentSelectedImageSources] =
    useState<AIImageSourceEnhanced[]>([]);
  const [isReferenceLocked, setIsReferenceLocked] = useState(false);
  const [selectedElementCount, setSelectedElementCount] = useState(0);
  const [referenceExportOptions, setReferenceExportOptions] =
    useState<AIReferenceExportOptions>(DEFAULT_AI_REFERENCE_EXPORT_OPTIONS);
  const [promptTemplates, setPromptTemplates] = useState<PromptTemplate[]>(() =>
    getPromptTemplatesForMode("text-to-image"),
  );
  const [isTemplateMenuOpen, setIsTemplateMenuOpen] = useState(false);
  const [referencePickerState, setReferencePickerState] = useState<{
    isOpen: boolean;
    replaceStart: number;
    replaceEnd: number;
    activeIndex: number;
  }>({
    isOpen: false,
    replaceStart: 0,
    replaceEnd: 0,
    activeIndex: 0,
  });
  const [draggedReferenceId, setDraggedReferenceId] = useState<number | null>(
    null,
  );
  const [batchMode, setBatchMode] = useState(false);
  const [selectedBatchIds, setSelectedBatchIds] = useState<Set<number>>(
    () => new Set(),
  );
  const [weightEditorId, setWeightEditorId] = useState<number | null>(null);
  const [weightDraft, setWeightDraft] = useState(0.6);
  const [batchWeightDraft, setBatchWeightDraft] = useState(0.6);
  const [selectedAIMetadata, setSelectedAIMetadata] =
    useState<AIImageGenerationMetadata | null>(null);
  const [generatedAssets, setGeneratedAssets] = useState<GeneratedAsset[]>([]);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [runStatus, setRunStatus] = useState<AIImageWorkbenchRunStatus>("idle");
  // In-flight async video tasks (submit -> poll). Persisted to localStorage so
  // polling resumes after a page refresh; see decision 0015.
  const [pendingVideoTasks, setPendingVideoTasks] = useState<
    PendingVideoTask[]
  >([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Per-task abort controllers keyed by taskId, so each poll loop can be
  // cancelled independently of the synchronous image generation.
  const videoPollControllersRef = useRef<Map<string, AbortController>>(
    new Map(),
  );
  const didResumeVideoTasksRef = useRef(false);
  const activeRunIdRef = useRef(0);
  const generationTimeoutRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const draftSignatureRef = useRef<string | null>(null);
  const lastReferenceAddRequestIdRef = useRef<number | null>(null);
  const promptInputRef = useRef<PromptEditorHandle | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const didRestoreReferenceImagesRef = useRef(false);
  const skipNextReferencePersistenceRef = useRef(false);
  const isReferenceLockedRef = useRef(isReferenceLocked);
  const selectionSignatureRef = useRef<string | null>(null);
  const persistReferenceTimeoutRef = useRef<number | null>(null);
  const didRestoreMasksRef = useRef(false);
  const skipNextMaskPersistenceRef = useRef(false);
  const persistMaskTimeoutRef = useRef<number | null>(null);
  const excalidrawAPIRef = useRef(excalidrawAPI);
  const generationStateRef = useRef({
    config,
    currentSelectedImageSources,
    inpaintDraft,
    mediaType,
    mode,
    negativePrompt,
    params,
    prompt,
    selectedModelId,
    selectedSources,
  });
  excalidrawAPIRef.current = excalidrawAPI;

  generationStateRef.current = {
    config,
    currentSelectedImageSources,
    inpaintDraft,
    mediaType,
    mode,
    negativePrompt,
    params,
    prompt,
    selectedModelId,
    selectedSources,
  };

  // Latest full draft state, read by the video path (which runs its own draft
  // regardless of the active media type / mode) without adding it to deps.
  const activeDraftStateRef = useRef(activeDraftState);
  activeDraftStateRef.current = activeDraftState;

  useEffect(() => {
    isReferenceLockedRef.current = isReferenceLocked;
  }, [isReferenceLocked]);

  const handleCanvasMaskReady = useCallback(
    (payload: AIMaskReadyPayload) => {
      const maskRecord: AIImageEditableMask = {
        file: payload.maskFile,
        elements: cloneMaskElements(payload.maskElements),
        updatedAt: Date.now(),
      };

      setMaskForImage(payload.imageId, maskRecord);
      fileToDataURL(payload.maskFile)
        .then((dataURL) => {
          patchMaskDataURLForImage(
            payload.imageId,
            maskRecord.updatedAt,
            dataURL,
          );
        })
        .catch((error) => {
          console.error("Could not create mask thumbnail", error);
        });
      setStatusMessage("");
      setErrorMessage("");
    },
    [patchMaskDataURLForImage, setMaskForImage],
  );

  const modelsForMediaType = useMemo(
    () => config.models.filter((model) => model.mediaType === mediaType),
    [config.models, mediaType],
  );

  const selectedModel = useMemo(
    () => modelsForMediaType.find((model) => model.id === selectedModelId),
    [modelsForMediaType, selectedModelId],
  );
  const selectedNativeModel =
    selectedModel?.nativeModel || DEFAULT_AI_IMAGE_NATIVE_MODEL;
  const aspectRatioOptions = useMemo(
    () => getAIImageAspectRatioOptions(selectedNativeModel),
    [selectedNativeModel],
  );
  const resolutionOptions = useMemo(
    () =>
      getAIImageResolutionOptions(
        selectedNativeModel,
        params.aspectRatio || "auto",
      ),
    [params.aspectRatio, selectedNativeModel],
  );

  const activeDraftSignature = useMemo(
    () =>
      JSON.stringify({
        mediaType,
        mode,
        selectedModelId,
        prompt,
        negativePrompt,
        params,
        selectedSources: selectedSources.map((source) => ({
          id: source.createdAt,
          elementId: source.elementId,
          weight: source.weight,
          missingElement: source.missingElement,
        })),
        currentSelectedImageSources: currentSelectedImageSources.map(
          (source) => source.elementId,
        ),
      }),
    [
      currentSelectedImageSources,
      mediaType,
      mode,
      negativePrompt,
      params,
      prompt,
      selectedModelId,
      selectedSources,
    ],
  );

  useEffect(() => {
    mountedRef.current = true;
    // Capture the Map instance so the cleanup uses the same reference that was
    // live during this effect, per react-hooks/exhaustive-deps. The Map persists
    // for the component's lifetime, so this reference stays valid.
    const videoPollControllers = videoPollControllersRef.current;
    const flushWorkbenchMediaState = () => {
      const api = excalidrawAPIRef.current;

      if (!api) {
        return;
      }

      if (didRestoreReferenceImagesRef.current) {
        const sources = generationStateRef.current.selectedSources;
        const key = getReferencePersistenceKey(api);

        if (sources.length) {
          persistReferenceState(key, {
            locked: isReferenceLockedRef.current,
            images: sources,
          });
        } else {
          try {
            localStorage.removeItem(key);
          } catch {
            // Ignore storage failures during page teardown.
          }
        }
      }

      if (didRestoreMasksRef.current) {
        persistMaskState(
          getMaskPersistenceKey(api),
          generationStateRef.current.inpaintDraft.masksByImageId,
        );
      }
    };

    window.addEventListener("pagehide", flushWorkbenchMediaState);

    return () => {
      window.removeEventListener("pagehide", flushWorkbenchMediaState);
      flushWorkbenchMediaState();
      mountedRef.current = false;
      activeRunIdRef.current += 1;
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;

      if (generationTimeoutRef.current !== null) {
        window.clearTimeout(generationTimeoutRef.current);
        generationTimeoutRef.current = null;
      }

      if (persistReferenceTimeoutRef.current !== null) {
        window.clearTimeout(persistReferenceTimeoutRef.current);
        persistReferenceTimeoutRef.current = null;
      }

      if (persistMaskTimeoutRef.current !== null) {
        window.clearTimeout(persistMaskTimeoutRef.current);
        persistMaskTimeoutRef.current = null;
      }

      // Abort in-flight video poll loops; the tasks stay in localStorage so a
      // remount (e.g. after a refresh) resumes them.
      for (const controller of videoPollControllers.values()) {
        controller.abort();
      }
      videoPollControllers.clear();
    };
  }, []);

  useEffect(() => {
    if (draftSignatureRef.current === null) {
      draftSignatureRef.current = activeDraftSignature;
      return;
    }

    if (draftSignatureRef.current === activeDraftSignature) {
      return;
    }

    draftSignatureRef.current = activeDraftSignature;

    if (!abortControllerRef.current) {
      setRunStatus("idle");
      setStatusMessage("");
      setErrorMessage("");
    }
  }, [activeDraftSignature]);

  useEffect(() => {
    const reloadConfig = () => {
      setConfig(loadAIImageConfig());
    };

    window.addEventListener(AI_IMAGE_CONFIG_UPDATED_EVENT, reloadConfig);
    window.addEventListener("storage", reloadConfig);

    return () => {
      window.removeEventListener(AI_IMAGE_CONFIG_UPDATED_EVENT, reloadConfig);
      window.removeEventListener("storage", reloadConfig);
    };
  }, []);

  // The editor registers a native wheel listener on its container that treats
  // any textarea/input as a canvas surface and zooms/pans instead of scrolling
  // the field. Stop wheel events over our form controls from bubbling to that
  // listener so scrolling inside prompt fields never moves the canvas. React's
  // synthetic stopPropagation cannot cancel the native container listener, so
  // this must be a native listener too. It runs in the bubble phase so the
  // field still scrolls normally before propagation is halted.
  useEffect(() => {
    const root = rootRef.current;

    if (!root) {
      return;
    }

    const stopWheelOnFormControls = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null;

      if (
        target?.closest("textarea, input, select, [contenteditable='true']")
      ) {
        event.stopPropagation();
      }
    };

    root.addEventListener("wheel", stopWheelOnFormControls);

    return () => {
      root.removeEventListener("wheel", stopWheelOnFormControls);
    };
  }, []);

  useEffect(() => {
    if (
      selectedModel &&
      (mediaType !== "image" || supportsAIImageMode(selectedModel, mode))
    ) {
      return;
    }

    const nextModelId =
      mediaType === "image"
        ? getDefaultModelIdForImageMode(config, mode)
        : getDefaultModelIdForMediaType(config, mediaType);

    if (nextModelId !== selectedModelId) {
      setSelectedModelId(nextModelId);
    }
  }, [
    config,
    mediaType,
    mode,
    selectedModel,
    selectedModelId,
    setSelectedModelId,
  ]);

  useEffect(() => {
    if (
      mediaType !== "image" ||
      config.models.some(
        (model) =>
          model.mediaType === "image" && supportsAIImageMode(model, mode),
      )
    ) {
      return;
    }

    const nextMode = MODE_OPTIONS.find((option) =>
      config.models.some(
        (model) =>
          model.mediaType === "image" &&
          supportsAIImageMode(model, option.value),
      ),
    );

    if (nextMode && nextMode.value !== mode) {
      setMode(nextMode.value);
    }
  }, [config.models, mediaType, mode, setMode]);

  const getSelectedImageSources = useCallback(
    (
      selectedImages?: readonly InitializedExcalidrawImageElement[],
      filesOverride?: ReturnType<ExcalidrawImperativeAPI["getFiles"]>,
    ) => {
      if (!excalidrawAPI) {
        return [];
      }

      const images =
        selectedImages ||
        getSelectedElements(
          excalidrawAPI.getSceneElements(),
          excalidrawAPI.getAppState(),
        ).filter(isInitializedImageElement);
      const files = filesOverride || excalidrawAPI.getFiles();

      return images
        .map((element, index): AIImageSourceEnhanced | null => {
          const fileData = files[element.fileId];

          if (!fileData) {
            return null;
          }

          return createImportedReferenceSource({
            element,
            fileData,
            index: index + 1,
          });
        })
        .filter((source): source is AIImageSourceEnhanced => !!source);
    },
    [excalidrawAPI],
  );

  const syncReferenceImagesFromSelection = useCallback(() => {
    const selectedImageSources = getSelectedImageSources();

    setSelectedSources((current) =>
      appendSelectedImageSources(current, selectedImageSources),
    );
  }, [getSelectedImageSources]);

  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }

    const syncSelection = () => {
      const appState = excalidrawAPI.getAppState();
      const selectedElementIds = Object.keys(
        appState.selectedElementIds,
      ).sort();
      const selectionSignature = selectedElementIds.join("|");

      if (
        Object.keys(generationStateRef.current.inpaintDraft.masksByImageId)
          .length
      ) {
        pruneMasksForElements(excalidrawAPI.getSceneElements());
      }

      if (selectionSignatureRef.current === selectionSignature) {
        return;
      }

      selectionSignatureRef.current = selectionSignature;
      const elements = excalidrawAPI.getSceneElements();
      const selectedElements = getSelectedElements(elements, appState);
      const selectedImages = selectedElements.filter(isInitializedImageElement);
      const selectedImageSources = getSelectedImageSources(
        selectedImages,
        excalidrawAPI.getFiles(),
      );

      setSelectedElementCount(selectedElements.length);
      setCurrentSelectedImageSources(selectedImageSources);

      if (!isReferenceLockedRef.current) {
        setSelectedSources((current) =>
          appendSelectedImageSources(
            markMissingReferenceElements(current, elements),
            selectedImageSources,
          ),
        );
      } else {
        setSelectedSources((current) =>
          markMissingReferenceElements(current, elements),
        );
      }

      const selectedAIImage =
        selectedImages.length === 1
          ? getAIImageElementMetadata(selectedImages[0])
          : null;
      setSelectedAIMetadata(selectedAIImage);
    };

    syncSelection();

    return excalidrawAPI.onChange(syncSelection);
  }, [excalidrawAPI, getSelectedImageSources, pruneMasksForElements]);

  useEffect(() => {
    if (!onMaskReady) {
      return;
    }

    onMaskReady(handleCanvasMaskReady);

    return () => {
      onMaskReady(null);
    };
  }, [handleCanvasMaskReady, onMaskReady]);

  useEffect(() => {
    if (mediaType !== "image") {
      return;
    }

    const supportedAspectRatios = getAIImageAspectRatioOptions(
      selectedNativeModel,
    ).map((option) => option.value);

    setParams((current) => {
      const aspectRatio = supportedAspectRatios.includes(
        current.aspectRatio || "auto",
      )
        ? current.aspectRatio || "auto"
        : "auto";
      const supportedResolutions = getAIImageResolutionOptions(
        selectedNativeModel,
        aspectRatio,
      ).map((option) => option.value);
      const resolution = supportedResolutions.includes(
        current.resolution || "auto",
      )
        ? current.resolution || "auto"
        : "auto";

      if (
        aspectRatio === current.aspectRatio &&
        resolution === current.resolution
      ) {
        return current;
      }

      return { ...current, aspectRatio, resolution };
    });
  }, [mediaType, selectedNativeModel, setParams]);

  const modelSupportsMode =
    mediaType !== "image" ||
    !selectedModel ||
    supportsAIImageMode(selectedModel, mode);
  const hasSelectedModelEndpoint = !!(selectedModel?.baseURL || config.baseURL);
  const availableSelectedSources = useMemo(
    () => selectedSources.filter((source) => !source.missingElement),
    [selectedSources],
  );
  // The canvas selection is transient and normally empty after a refresh. A
  // restored one-image reference tray remains the active inpaint source.
  const inpaintSourceCandidates = currentSelectedImageSources.length
    ? currentSelectedImageSources
    : availableSelectedSources;
  const selectedMaskImageId =
    inpaintSourceCandidates.length === 1
      ? inpaintSourceCandidates[0].elementId
      : null;
  const currentMask = selectedMaskImageId
    ? inpaintDraft.masksByImageId[selectedMaskImageId] || null
    : null;
  const editMaskLabel = currentMask
    ? "Re-edit mask on canvas"
    : "Edit mask on canvas";
  const isInpaintMode = mode === "inpaint";
  const maskEditableSource =
    isInpaintMode &&
    inpaintSourceCandidates.length === 1 &&
    inpaintSourceCandidates[0]?.fileId
      ? inpaintSourceCandidates[0]
      : null;
  const { canGenerate, requiresMask, requiresReference, statusStripItems } =
    createAIImageWorkbenchStatus({
      mediaType,
      mode,
      selectedModelLabel: selectedModel
        ? selectedModel.siteName || selectedModel.model
        : null,
      hasSelectedModelBaseURL: hasSelectedModelEndpoint,
      selectedModelId,
      prompt,
      modelSupportsMode,
      referenceCount: availableSelectedSources.length,
      selectedImageCount: inpaintSourceCandidates.length,
      hasCurrentMask: !!currentMask,
      hasExcalidrawAPI: !!excalidrawAPI,
      isGenerating,
      runStatus,
    });
  const configurationNotice = getAIImageWorkbenchConfigurationNotice({
    mediaType,
    hasModelsForMediaType: modelsForMediaType.length > 0,
    selectedModelId,
    hasSelectedModelBaseURL: hasSelectedModelEndpoint,
    modelSupportsMode,
  });

  const hasActiveVideoTasks = pendingVideoTasks.length > 0;
  const canGenerateVideo =
    mediaType === "video" &&
    !hasActiveVideoTasks &&
    !!prompt.trim() &&
    !!selectedModelId &&
    hasSelectedModelEndpoint;

  const seedDisabled =
    !!selectedModel && !supportsAIImageMode(selectedModel, "seed");

  const updateParams = useCallback(
    (patch: Partial<AIImageGenerationParams>) => {
      setParams((current) => ({ ...current, ...patch }));
    },
    [setParams],
  );

  const addSelectionAsReference = useCallback(async () => {
    if (!excalidrawAPI) {
      return;
    }

    const appState = excalidrawAPI.getAppState();
    const elements = excalidrawAPI.getSceneElements();
    const files = excalidrawAPI.getFiles();
    const selectedElements = getSelectedElements(elements, appState);

    if (!selectedElements.length) {
      setErrorMessage(t("ai.workbench.selectElementsFirst"));
      setStatusMessage("");
      return;
    }

    try {
      const { source, warning } = await exportSelectionToReferenceSource({
        elements: selectedElements,
        appState,
        files,
        options: referenceExportOptions,
        index: selectedSources.length + 1,
      });

      setIsReferenceLocked(true);
      setSelectedSources((current) =>
        reindexReferenceImages([...current, source]),
      );
      const successMessage = t("ai.workbench.referenceAdded", {
        index: source.index,
      });
      setStatusMessage(warning || successMessage);
      setErrorMessage("");
      excalidrawAPI.setToast({
        message: warning || successMessage,
      });
    } catch (error: any) {
      console.error("Could not export reference selection", error);
      setErrorMessage(
        error?.message || t("ai.workbench.exportSelectionFailed"),
      );
      setStatusMessage("");
    }
  }, [excalidrawAPI, referenceExportOptions, selectedSources.length]);

  const removeReferenceImage = useCallback((createdAt: number) => {
    setSelectedSources((current) =>
      reindexReferenceImages(
        current.filter((source) => source.createdAt !== createdAt),
      ),
    );
    setSelectedBatchIds((current) => {
      const next = new Set(current);
      next.delete(createdAt);
      return next;
    });
  }, []);

  const clearReferenceImages = useCallback(() => {
    if (
      selectedSources.length > 2 &&
      !window.confirm(t("ai.workbench.clearAllReferencesConfirm"))
    ) {
      return;
    }

    setSelectedSources([]);
    setSelectedBatchIds(new Set());
    setBatchMode(false);
  }, [selectedSources.length]);

  const toggleReferenceLock = useCallback(() => {
    setIsReferenceLocked((current) => {
      const nextLocked = !current;

      if (!nextLocked) {
        window.setTimeout(syncReferenceImagesFromSelection);
      }

      return nextLocked;
    });
  }, [syncReferenceImagesFromSelection]);

  const highlightReferenceSource = useCallback(
    (source: AIImageSourceEnhanced) => {
      if (!excalidrawAPI) {
        return;
      }

      const sourceElementIds = source.elementIds?.length
        ? source.elementIds
        : [source.elementId];
      const elements = excalidrawAPI.getSceneElements();
      const matchingElements = elements.filter((element) =>
        sourceElementIds.includes(element.id),
      );

      if (!matchingElements.length) {
        setSelectedSources((current) =>
          current.map((item) =>
            item.createdAt === source.createdAt
              ? { ...item, missingElement: true }
              : item,
          ),
        );
        excalidrawAPI.setToast({
          message: t("ai.workbench.originalNotFound"),
        });
        return;
      }

      excalidrawAPI.updateScene({
        appState: {
          selectedElementIds: Object.fromEntries(
            matchingElements.map((element) => [element.id, true]),
          ),
        },
      });
      try {
        excalidrawAPI.scrollToContent(matchingElements, { animate: true });
      } catch {
        // Older API builds may only support selection changes here.
      }
    },
    [excalidrawAPI],
  );

  const moveReferenceImage = useCallback((fromId: number, toId: number) => {
    if (fromId === toId) {
      return;
    }

    setSelectedSources((current) => {
      const fromIndex = current.findIndex(
        (source) => source.createdAt === fromId,
      );
      const toIndex = current.findIndex((source) => source.createdAt === toId);

      if (fromIndex < 0 || toIndex < 0) {
        return current;
      }

      const nextSources = [...current];
      const [source] = nextSources.splice(fromIndex, 1);
      nextSources.splice(toIndex, 0, source);

      return reindexReferenceImages(nextSources);
    });
  }, []);

  const openWeightEditor = useCallback(
    (source: AIImageSourceEnhanced) => {
      setWeightEditorId(source.createdAt);
      setWeightDraft(source.weight ?? params.referenceStrength ?? 0.6);
    },
    [params.referenceStrength],
  );

  const applyWeightEditor = useCallback(() => {
    if (weightEditorId == null) {
      return;
    }

    setSelectedSources((current) =>
      current.map((source) =>
        source.createdAt === weightEditorId
          ? { ...source, weight: clampNumber(weightDraft, 0, 1) }
          : source,
      ),
    );
    setWeightEditorId(null);
  }, [weightDraft, weightEditorId]);

  const resetReferenceWeight = useCallback((createdAt: number) => {
    setSelectedSources((current) =>
      current.map((source) => {
        if (source.createdAt !== createdAt) {
          return source;
        }

        return clearReferenceWeight(source);
      }),
    );
  }, []);

  const resetAllReferenceWeights = useCallback(() => {
    setSelectedSources((current) =>
      current.map((source) => clearReferenceWeight(source)),
    );
  }, []);

  const toggleBatchSelection = useCallback((createdAt: number) => {
    setSelectedBatchIds((current) => {
      const next = new Set(current);

      if (next.has(createdAt)) {
        next.delete(createdAt);
      } else {
        next.add(createdAt);
      }

      return next;
    });
  }, []);

  const selectAllBatchReferences = useCallback(() => {
    setSelectedBatchIds(
      new Set(selectedSources.map((source) => source.createdAt)),
    );
  }, [selectedSources]);

  const deleteSelectedBatchReferences = useCallback(() => {
    setSelectedSources((current) =>
      reindexReferenceImages(
        current.filter((source) => !selectedBatchIds.has(source.createdAt)),
      ),
    );
    setSelectedBatchIds(new Set());
  }, [selectedBatchIds]);

  const applyBatchWeight = useCallback(() => {
    setSelectedSources((current) =>
      current.map((source) =>
        selectedBatchIds.has(source.createdAt)
          ? { ...source, weight: clampNumber(batchWeightDraft, 0, 1) }
          : source,
      ),
    );
  }, [batchWeightDraft, selectedBatchIds]);

  useEffect(() => {
    const reloadTemplates = () => {
      setPromptTemplates(getPromptTemplatesForMode(mode));
    };

    reloadTemplates();
    window.addEventListener(AI_PROMPT_TEMPLATES_UPDATED_EVENT, reloadTemplates);
    window.addEventListener("storage", reloadTemplates);

    return () => {
      window.removeEventListener(
        AI_PROMPT_TEMPLATES_UPDATED_EVENT,
        reloadTemplates,
      );
      window.removeEventListener("storage", reloadTemplates);
    };
  }, [mode]);

  useEffect(() => {
    if (!excalidrawAPI || didRestoreReferenceImagesRef.current) {
      return;
    }

    didRestoreReferenceImagesRef.current = true;
    const savedState = loadPersistedReferenceState(
      getReferencePersistenceKey(excalidrawAPI),
      excalidrawAPI.getFiles(),
    );

    if (!savedState?.images.length) {
      return;
    }

    setIsReferenceLocked(savedState.locked);
    skipNextReferencePersistenceRef.current = true;
    setSelectedSources(reindexReferenceImages(savedState.images));
  }, [excalidrawAPI]);

  useEffect(() => {
    if (!excalidrawAPI || !didRestoreReferenceImagesRef.current) {
      return;
    }

    const key = getReferencePersistenceKey(excalidrawAPI);

    if (skipNextReferencePersistenceRef.current) {
      skipNextReferencePersistenceRef.current = false;
      return;
    }

    if (persistReferenceTimeoutRef.current !== null) {
      window.clearTimeout(persistReferenceTimeoutRef.current);
      persistReferenceTimeoutRef.current = null;
    }

    if (!selectedSources.length) {
      try {
        localStorage.removeItem(key);
      } catch {
        // Ignore storage failures (private mode); the tray just won't persist.
      }
      return;
    }

    persistReferenceTimeoutRef.current = window.setTimeout(() => {
      persistReferenceTimeoutRef.current = null;
      persistReferenceState(key, {
        locked: isReferenceLocked,
        images: selectedSources,
      });
    }, 250);
  }, [excalidrawAPI, isReferenceLocked, selectedSources]);

  // Restore inpaint masks once the API is ready, so a refresh keeps an
  // in-progress mask instead of forcing the user to redraw it.
  useEffect(() => {
    if (!excalidrawAPI || didRestoreMasksRef.current) {
      return;
    }

    didRestoreMasksRef.current = true;
    const restored = loadPersistedMaskState(
      getMaskPersistenceKey(excalidrawAPI),
    );

    if (!Object.keys(restored).length) {
      return;
    }

    skipNextMaskPersistenceRef.current = true;
    setActiveDraftState((current) => ({
      ...current,
      imageModes: {
        ...current.imageModes,
        inpaint: {
          ...current.imageModes.inpaint,
          // Restored masks seed only the images that don't already have a mask
          // in the live draft, so a freshly-drawn mask is never clobbered.
          masksByImageId: {
            ...restored,
            ...current.imageModes.inpaint.masksByImageId,
          },
        },
      },
    }));
  }, [excalidrawAPI, setActiveDraftState]);

  // Debounced persist whenever the mask map changes (drawn, updated, cleared).
  useEffect(() => {
    if (!excalidrawAPI || !didRestoreMasksRef.current) {
      return;
    }

    if (skipNextMaskPersistenceRef.current) {
      skipNextMaskPersistenceRef.current = false;
      return;
    }

    if (persistMaskTimeoutRef.current !== null) {
      window.clearTimeout(persistMaskTimeoutRef.current);
      persistMaskTimeoutRef.current = null;
    }

    const key = getMaskPersistenceKey(excalidrawAPI);
    persistMaskTimeoutRef.current = window.setTimeout(() => {
      persistMaskTimeoutRef.current = null;
      persistMaskState(key, inpaintDraft.masksByImageId);
    }, 300);
  }, [excalidrawAPI, inpaintDraft.masksByImageId]);

  useEffect(() => {
    if (
      !referenceAddRequest ||
      referenceAddRequest.id === lastReferenceAddRequestIdRef.current
    ) {
      return;
    }

    lastReferenceAddRequestIdRef.current = referenceAddRequest.id;
    addSelectionAsReference();
  }, [addSelectionAsReference, referenceAddRequest]);

  const promptReferenceWarnings = useMemo(
    () => validatePromptReferences(prompt, availableSelectedSources.length),
    [availableSelectedSources.length, prompt],
  );
  // Highlight `#1`/`图2`/`image 3` tokens only while a reference workflow is
  // active — text-to-image has no reference images, so the tokens carry no
  // meaning there. The PromptEditor paints valid refs (1..count) in the brand
  // color and out-of-range refs in red; passing 0 disables highlighting.
  const promptReferenceCount = requiresReference
    ? availableSelectedSources.length
    : 0;
  const copyPromptActionState = useMemo(
    () => createCopyPromptActionState(prompt),
    [prompt],
  );
  const sendPromptToAssistantActionState = useMemo(
    () => createSendPromptToAssistantActionState(prompt),
    [prompt],
  );

  const generate = useCallback(
    async (overrides?: {
      mode?: AIImageGenerationMode;
      model?: string;
      prompt?: string;
      negativePrompt?: string;
      params?: AIImageGenerationParams;
    }) => {
      if (abortControllerRef.current) {
        return;
      }

      if (!excalidrawAPI) {
        return;
      }

      const {
        config,
        currentSelectedImageSources,
        inpaintDraft,
        mediaType,
        mode,
        negativePrompt,
        params,
        prompt,
        selectedModelId,
        selectedSources,
      } = generationStateRef.current;
      const activeMode = overrides?.mode ?? mode;
      const activeModel = overrides?.model ?? selectedModelId;
      const activeModelCard =
        config.models.find((model) => model.id === activeModel) ||
        config.models.find((model) => model.model === activeModel);
      const activeModelName = activeModelCard?.model || activeModel;
      const activePrompt = overrides?.prompt ?? prompt;
      const activeNegativePrompt = overrides?.negativePrompt ?? negativePrompt;
      const activeParams = overrides?.params ?? params;
      const availableSources = selectedSources.filter(
        (source) => !source.missingElement,
      );
      const activeSources =
        activeMode === "text-to-image"
          ? []
          : activeMode === "inpaint"
          ? currentSelectedImageSources.length
            ? currentSelectedImageSources
            : availableSources
          : availableSources;
      const generatedImagePlacement =
        activeMode === "image-to-image"
          ? getGeneratedImageReferencePlacement(activeSources)
          : undefined;
      const activeSourceImagesMetadata = activeSources.map((source) => ({
        index: source.index,
        elementId: source.elementId,
        elementIds: source.elementIds,
        sourceType: source.sourceType,
        weight: source.weight,
      }));
      const effectiveParams = {
        ...activeParams,
        size: resolveAIImageSize({
          aspectRatio: activeParams.aspectRatio,
          mode: activeMode,
          nativeModel:
            activeModelCard?.nativeModel || DEFAULT_AI_IMAGE_NATIVE_MODEL,
          resolution: activeParams.resolution,
          sources: activeSources,
        }),
      };
      const submittedAt = new Date().toISOString();
      const activeBaseURL = activeModelCard?.baseURL || config.baseURL;
      const activeSiteName =
        activeModelCard?.siteName || activeModelCard?.label || "Unknown site";
      const endpoint = activeBaseURL
        ? buildOpenAIImageEndpoint(activeBaseURL, activeMode)
        : undefined;

      if (mediaType !== "image") {
        setErrorMessage(t("ai.workbench.onlyImageGeneration"));
        setStatusMessage("");
        setRunStatus("failed");
        return;
      }

      if (!activePrompt.trim()) {
        setErrorMessage(t("ai.workbench.promptRequired"));
        setRunStatus("failed");
        return;
      }

      if (activeMode === "image-to-image" && activeSources.length === 0) {
        setErrorMessage(
          selectedSources.length
            ? "Remove missing references or add an available reference image."
            : "Add at least one reference image.",
        );
        setStatusMessage("");
        setRunStatus("failed");
        return;
      }

      const activeMaskRecord =
        activeMode === "inpaint" && activeSources.length === 1
          ? inpaintDraft.masksByImageId[activeSources[0].elementId] || null
          : null;

      if (activeMode === "inpaint") {
        if (activeSources.length !== 1) {
          setErrorMessage(t("ai.workbench.selectOneImageBeforeGenerating"));
          setStatusMessage("");
          setRunStatus("failed");
          return;
        }

        if (!activeMaskRecord) {
          setErrorMessage(t("ai.workbench.drawMaskBeforeGenerating"));
          setStatusMessage("");
          setRunStatus("failed");
          return;
        }
      }

      const abortController = new AbortController();
      const runId = activeRunIdRef.current + 1;
      activeRunIdRef.current = runId;
      const timeoutSeconds =
        activeModelCard?.requestTimeoutSeconds ||
        DEFAULT_AI_IMAGE_REQUEST_TIMEOUT_SECONDS;
      let didTimeout = false;
      const timeoutId = window.setTimeout(() => {
        didTimeout = true;
        abortController.abort();
      }, timeoutSeconds * 1000);
      const isActiveRun = () =>
        mountedRef.current &&
        activeRunIdRef.current === runId &&
        abortControllerRef.current === abortController;

      abortControllerRef.current = abortController;
      generationTimeoutRef.current = timeoutId;
      setIsGenerating(true);
      setRunStatus("generating");
      setStatusMessage(t("ai.workbench.generatingImage"));
      setErrorMessage("");

      try {
        const activeMask =
          activeMode === "inpaint" && activeMaskRecord
            ? {
                file: activeMaskRecord.file,
                dataURL:
                  activeMaskRecord.dataURL ||
                  (await fileToDataURL(activeMaskRecord.file)),
              }
            : null;

        if (!isActiveRun()) {
          return;
        }

        const outputs = await generateImagesWithOpenAIAdapter({
          config: activeModelCard
            ? {
                ...config,
                baseURL: activeModelCard.baseURL,
                apiKey: activeModelCard.apiKey,
                models: [
                  activeModelCard,
                  ...config.models.filter(
                    (model) => model.id !== activeModelCard.id,
                  ),
                ],
              }
            : config,
          mode: activeMode,
          model: activeModelName,
          prompt: activePrompt.trim(),
          negativePrompt: activeNegativePrompt.trim() || undefined,
          params: effectiveParams,
          sources: activeSources,
          mask: activeMask,
          signal: abortController.signal,
        });

        if (!isActiveRun()) {
          return;
        }

        if (!isValidGenerationOutputs(outputs)) {
          throw new AIImageGenerationError(
            t("ai.workbench.malformedOutput"),
            "invalid-response",
            { outputs },
          );
        }

        const nextGeneratedAssets: GeneratedAsset[] = [];

        for (const [index, output] of outputs.entries()) {
          if (!isActiveRun()) {
            return;
          }

          const metadata = createAIImageGenerationMetadata({
            mode: activeMode,
            model: activeModelName,
            prompt: activePrompt.trim(),
            negativePrompt: activeNegativePrompt.trim() || undefined,
            params: effectiveParams,
            sourceElementIds:
              activeMode === "text-to-image"
                ? []
                : activeSources.flatMap((source) =>
                    source.elementIds?.length
                      ? source.elementIds
                      : [source.elementId],
                  ),
            sourceImages:
              activeMode === "text-to-image"
                ? undefined
                : activeSourceImagesMetadata,
            output,
            index,
          });

          if (!isActiveRun()) {
            return;
          }

          const insertedElement = await insertGeneratedImageIntoCanvas({
            excalidrawAPI,
            output,
            metadata,
            index,
            placement: generatedImagePlacement,
          });

          if (!isActiveRun()) {
            return;
          }

          nextGeneratedAssets.push({
            id: createGeneratedAssetId(index),
            output,
            metadata,
            insertedElementId: insertedElement.id,
            insertedFileId: insertedElement.fileId,
            width: insertedElement.width,
            height: insertedElement.height,
            createdAt: metadata.createdAt,
            index,
            modelLabel: activeModelCard?.label || activeModelName,
            siteName: activeSiteName,
          });
        }

        if (!isActiveRun()) {
          return;
        }

        const insertedCount = outputs.length;
        setGeneratedAssets((current) =>
          [...nextGeneratedAssets, ...current].slice(0, 12),
        );
        notifyCloudAITaskRun({
          submittedAt,
          completedAt: new Date().toISOString(),
          mediaType,
          mode: activeMode,
          status: "success",
          model: {
            id: activeModelCard?.id || activeModel,
            name: activeModelName,
            siteName: activeSiteName,
          },
          prompt: activePrompt.trim(),
          negativePrompt: activeNegativePrompt.trim() || undefined,
          params: effectiveParams,
          sources: activeSources,
          outputs: nextGeneratedAssets.map((asset) => ({
            output: asset.output,
            insertedElementId: asset.insertedElementId,
            insertedFileId: asset.insertedFileId,
          })),
        });
        appendGenerationLogEntry(
          createAIGenerationLogEntry({
            submittedAt,
            mediaType,
            mode: activeMode,
            status: "success",
            model: {
              id: activeModelCard?.id || activeModel,
              name: activeModelName,
              siteName: activeSiteName,
            },
            prompt: activePrompt.trim(),
            negativePrompt: activeNegativePrompt.trim() || undefined,
            params: effectiveParams,
            baseURL: activeBaseURL,
            endpoint,
            responseSummary:
              insertedCount === 1
                ? t("ai.workbench.generatedImageInserted")
                : t("ai.workbench.generatedImagesInserted", {
                    count: insertedCount,
                  }),
            responseDetails: createSuccessResponseDetails(outputs),
          }),
        );
        setStatusMessage(
          insertedCount === 1
            ? t("ai.workbench.generatedImageInserted")
            : t("ai.workbench.generatedImagesInserted", {
                count: insertedCount,
              }),
        );
        setRunStatus("inserted");
        excalidrawAPI.setToast({
          message: t("ai.workbench.generatedImageInserted"),
        });
      } catch (error: any) {
        if (!isActiveRun()) {
          return;
        }

        console.error("AI image generation failed", error);

        if (error?.name === "AbortError") {
          if (didTimeout) {
            notifyCloudAITaskRun({
              submittedAt,
              completedAt: new Date().toISOString(),
              mediaType,
              mode: activeMode,
              status: "failed",
              model: {
                id: activeModelCard?.id || activeModel,
                name: activeModelName,
                siteName: activeSiteName,
              },
              prompt: activePrompt.trim(),
              negativePrompt: activeNegativePrompt.trim() || undefined,
              params: effectiveParams,
              sources: activeSources,
              errorCode: "timeout",
              errorMessage: t("ai.workbench.generationTimedOut", {
                seconds: timeoutSeconds,
              }),
            });
            appendGenerationLogEntry(
              createAIGenerationLogEntry({
                submittedAt,
                mediaType,
                mode: activeMode,
                status: "failed",
                model: {
                  id: activeModelCard?.id || activeModel,
                  name: activeModelName,
                  siteName: activeSiteName,
                },
                prompt: activePrompt.trim(),
                negativePrompt: activeNegativePrompt.trim() || undefined,
                params: effectiveParams,
                baseURL: activeBaseURL,
                endpoint,
                responseSummary: t("ai.workbench.generationTimedOut", {
                  seconds: timeoutSeconds,
                }),
                responseDetails: createErrorResponseDetails(error),
              }),
            );
            setErrorMessage(
              t("ai.workbench.generationTimedOut", {
                seconds: timeoutSeconds,
              }),
            );
            setStatusMessage("");
            setRunStatus("failed");
          } else {
            notifyCloudAITaskRun({
              submittedAt,
              completedAt: new Date().toISOString(),
              mediaType,
              mode: activeMode,
              status: "canceled",
              model: {
                id: activeModelCard?.id || activeModel,
                name: activeModelName,
                siteName: activeSiteName,
              },
              prompt: activePrompt.trim(),
              negativePrompt: activeNegativePrompt.trim() || undefined,
              params: effectiveParams,
              sources: activeSources,
              errorCode: "canceled",
              errorMessage: t("ai.workbench.generationCanceled"),
            });
            appendGenerationLogEntry(
              createAIGenerationLogEntry({
                submittedAt,
                mediaType,
                mode: activeMode,
                status: "canceled",
                model: {
                  id: activeModelCard?.id || activeModel,
                  name: activeModelName,
                  siteName: activeSiteName,
                },
                prompt: activePrompt.trim(),
                negativePrompt: activeNegativePrompt.trim() || undefined,
                params: effectiveParams,
                baseURL: activeBaseURL,
                endpoint,
                responseSummary: t("ai.workbench.generationCanceled"),
                responseDetails: createErrorResponseDetails(error),
              }),
            );
            setStatusMessage(t("ai.workbench.generationCanceled"));
            setRunStatus("canceled");
          }
          return;
        }

        const errorMessage =
          error instanceof AIImageGenerationError
            ? error.message
            : getUnknownErrorMessage(error, t);
        notifyCloudAITaskRun({
          submittedAt,
          completedAt: new Date().toISOString(),
          mediaType,
          mode: activeMode,
          status: "failed",
          model: {
            id: activeModelCard?.id || activeModel,
            name: activeModelName,
            siteName: activeSiteName,
          },
          prompt: activePrompt.trim(),
          negativePrompt: activeNegativePrompt.trim() || undefined,
          params: effectiveParams,
          sources: activeSources,
          errorCode:
            error instanceof AIImageGenerationError ? error.code : "unknown",
          errorMessage,
        });
        appendGenerationLogEntry(
          createAIGenerationLogEntry({
            submittedAt,
            mediaType,
            mode: activeMode,
            status: "failed",
            model: {
              id: activeModelCard?.id || activeModel,
              name: activeModelName,
              siteName: activeSiteName,
            },
            prompt: activePrompt.trim(),
            negativePrompt: activeNegativePrompt.trim() || undefined,
            params: effectiveParams,
            baseURL: activeBaseURL,
            endpoint,
            responseSummary: errorMessage,
            responseDetails: createErrorResponseDetails(error),
          }),
        );
        setErrorMessage(errorMessage);
        setStatusMessage("");
        setRunStatus("failed");
      } finally {
        window.clearTimeout(timeoutId);
        if (generationTimeoutRef.current === timeoutId) {
          generationTimeoutRef.current = null;
        }

        if (isActiveRun()) {
          setIsGenerating(false);
          abortControllerRef.current = null;
        }
      }
    },
    [excalidrawAPI, notifyCloudAITaskRun],
  );

  const cancelGeneration = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

  const syncPendingVideoTasks = useCallback(() => {
    setPendingVideoTasks(loadPendingVideoTasks());
  }, []);

  // Poll a single submitted task until it completes or fails. On completion it
  // resolves a cover image (thumbnail -> first frame -> placeholder) and inserts
  // it into the canvas with the real video URL on customData.aiVideoGeneration.
  // Runs against a per-task AbortController so it can be cancelled independently
  // of image generation and survives across a resume-on-mount.
  const runVideoPollLoop = useCallback(
    async (task: PendingVideoTask, controller: AbortController) => {
      const POLL_INTERVAL_MS = 4000;
      const delay = (ms: number) =>
        new Promise<void>((resolve) => {
          const timeoutId = window.setTimeout(resolve, ms);

          controller.signal.addEventListener(
            "abort",
            () => {
              window.clearTimeout(timeoutId);
              resolve();
            },
            { once: true },
          );
        });

      const currentConfig = generationStateRef.current.config;
      const modelCard =
        currentConfig.models.find((model) => model.id === task.modelId) ||
        currentConfig.models.find((model) => model.model === task.model);
      const baseURL =
        modelCard?.baseURL || task.baseURL || currentConfig.baseURL;
      const apiKey = modelCard?.apiKey || currentConfig.apiKey;
      const siteName = task.siteName;
      const endpoint = baseURL ? buildVideoSubmitEndpoint(baseURL) : undefined;

      try {
        while (!controller.signal.aborted) {
          const result = await pollVideoTask({
            baseURL,
            apiKey,
            taskId: task.taskId,
            signal: controller.signal,
          });

          if (controller.signal.aborted || !mountedRef.current) {
            return;
          }

          if (result.status === "failed") {
            appendGenerationLogEntry(
              createAIGenerationLogEntry({
                submittedAt: task.submittedAt,
                mediaType: "video",
                mode: "text-to-video",
                status: "failed",
                model: {
                  id: task.modelId,
                  name: task.model,
                  siteName,
                },
                prompt: task.prompt,
                params: task.params,
                baseURL,
                endpoint,
                responseSummary:
                  result.error || t("ai.workbench.videoTaskFailed"),
                responseDetails: { error: result.error },
              }),
            );
            removeVideoTask(task.taskId);
            syncPendingVideoTasks();
            setErrorMessage(result.error || t("ai.workbench.videoTaskFailed"));
            setStatusMessage("");
            setRunStatus("failed");
            return;
          }

          if (result.status !== "completed") {
            updateVideoTaskStatus(task.taskId, result.status);
            syncPendingVideoTasks();
            setStatusMessage(
              result.progress != null
                ? t("ai.workbench.videoTaskPollingProgress", {
                    progress: Math.round(result.progress),
                  })
                : t("ai.workbench.videoTaskPolling"),
            );
            await delay(POLL_INTERVAL_MS);
            continue;
          }

          // Completed: build output + read the video's intrinsic size, then
          // insert it as an inline-playing embeddable card.
          const output = buildVideoOutput(result);

          // Metadata-only probe for the real aspect ratio. Cross-origin safe
          // (reading videoWidth/Height never taints a canvas) and falls back to
          // a 16:9 default on failure/timeout, so it never blocks insertion.
          const dimensions = await getVideoDimensions(
            output.videoURL,
            controller.signal,
          );

          if (controller.signal.aborted || !mountedRef.current) {
            return;
          }

          const metadata = createAIVideoGenerationMetadata({
            mode: task.mode,
            model: task.model,
            prompt: task.prompt,
            params: task.params,
            output,
          });

          if (excalidrawAPI) {
            insertVideoEmbedIntoCanvas({
              excalidrawAPI,
              metadata,
              dimensions,
            });
          }

          appendGenerationLogEntry(
            createAIGenerationLogEntry({
              submittedAt: task.submittedAt,
              mediaType: "video",
              mode: "text-to-video",
              status: "success",
              model: {
                id: task.modelId,
                name: task.model,
                siteName,
              },
              prompt: task.prompt,
              params: task.params,
              baseURL,
              endpoint,
              responseSummary: t("ai.workbench.videoReady"),
              responseDetails: {
                videoURL: output.videoURL,
                durationSeconds: output.durationSeconds,
              },
            }),
          );

          removeVideoTask(task.taskId);
          syncPendingVideoTasks();
          setStatusMessage(t("ai.workbench.videoReady"));
          setErrorMessage("");
          setRunStatus("inserted");
          excalidrawAPI?.setToast({ message: t("ai.workbench.videoReady") });
          return;
        }
      } catch (error: any) {
        if (error?.name === "AbortError" || controller.signal.aborted) {
          return;
        }

        console.error("AI video task polling failed", error);
        appendGenerationLogEntry(
          createAIGenerationLogEntry({
            submittedAt: task.submittedAt,
            mediaType: "video",
            mode: "text-to-video",
            status: "failed",
            model: {
              id: task.modelId,
              name: task.model,
              siteName,
            },
            prompt: task.prompt,
            params: task.params,
            baseURL,
            endpoint,
            responseSummary:
              error instanceof AIImageGenerationError
                ? error.message
                : t("ai.workbench.videoTaskFailed"),
            responseDetails: createErrorResponseDetails(error),
          }),
        );
        removeVideoTask(task.taskId);
        syncPendingVideoTasks();
        setErrorMessage(
          error instanceof AIImageGenerationError
            ? error.message
            : t("ai.workbench.videoTaskFailed"),
        );
        setStatusMessage("");
        setRunStatus("failed");
      } finally {
        videoPollControllersRef.current.delete(task.taskId);
      }
    },
    [excalidrawAPI, syncPendingVideoTasks],
  );

  const startVideoPolling = useCallback(
    (task: PendingVideoTask) => {
      if (videoPollControllersRef.current.has(task.taskId)) {
        return;
      }

      const controller = new AbortController();
      videoPollControllersRef.current.set(task.taskId, controller);
      void runVideoPollLoop(task, controller);
    },
    [runVideoPollLoop],
  );

  const cancelVideoTask = useCallback(
    (taskId: string) => {
      videoPollControllersRef.current.get(taskId)?.abort();
      videoPollControllersRef.current.delete(taskId);
      removeVideoTask(taskId);
      syncPendingVideoTasks();
      setStatusMessage("");
      setRunStatus("idle");
    },
    [syncPendingVideoTasks],
  );

  const generateVideo = useCallback(async () => {
    if (!excalidrawAPI) {
      return;
    }

    const { config } = generationStateRef.current;
    const videoDraft = activeDraftStateRef.current.video;
    const trimmedPrompt = videoDraft.prompt.trim();
    // Normalize framing so the request reflects what the dropdowns display even
    // when the stored value is still "auto" (untouched) or an inherited image
    // pixel size. Video frames via aspect_ratio + resolution, never pixel size.
    const videoParams: AIImageGenerationParams = {
      ...videoDraft.params,
      size: "",
      aspectRatio:
        videoDraft.params.aspectRatio &&
        videoDraft.params.aspectRatio !== "auto"
          ? videoDraft.params.aspectRatio
          : "16:9",
      resolution:
        videoDraft.params.resolution && videoDraft.params.resolution !== "auto"
          ? videoDraft.params.resolution
          : "720P",
    };
    const modelCard =
      config.models.find((model) => model.id === videoDraft.selectedModelId) ||
      config.models.find((model) => model.model === videoDraft.selectedModelId);

    if (!trimmedPrompt) {
      setErrorMessage(t("ai.workbench.promptRequired"));
      setStatusMessage("");
      setRunStatus("failed");
      return;
    }

    if (!modelCard) {
      setErrorMessage(t("ai.workbench.noMediaModels", { mediaType: "video" }));
      setStatusMessage("");
      setRunStatus("failed");
      return;
    }

    const baseURL = modelCard.baseURL || config.baseURL;

    if (!baseURL) {
      setErrorMessage(t("ai.workbench.videoTaskFailed"));
      setStatusMessage("");
      setRunStatus("failed");
      return;
    }

    // Reference sources drive image-to-video when the model supports it.
    const videoSources = selectedSources.filter(
      (source) => !source.missingElement,
    );
    const mode: AIVideoGenerationMode =
      videoSources.length > 0 &&
      supportsAIImageMode(modelCard, "image-to-video")
        ? "image-to-video"
        : "text-to-video";
    const submittedAt = new Date().toISOString();

    setRunStatus("generating");
    setStatusMessage(t("ai.workbench.generatingVideo"));
    setErrorMessage("");

    try {
      const { taskId, model } = await submitVideoTask({
        config: {
          ...config,
          baseURL: modelCard.baseURL,
          apiKey: modelCard.apiKey,
          models: [
            modelCard,
            ...config.models.filter((model) => model.id !== modelCard.id),
          ],
        },
        mode,
        model: modelCard.model,
        prompt: trimmedPrompt,
        params: videoParams,
        sources: mode === "image-to-video" ? videoSources : undefined,
      });

      const task: PendingVideoTask = {
        taskId,
        baseURL,
        modelId: modelCard.id,
        model,
        siteName: modelCard.siteName || modelCard.label || "Unknown site",
        mode,
        prompt: trimmedPrompt,
        params: videoParams,
        status: "queued",
        submittedAt,
      };

      upsertVideoTask(task);
      syncPendingVideoTasks();
      setStatusMessage(t("ai.workbench.videoTaskQueued"));
      startVideoPolling(task);
    } catch (error: any) {
      if (error?.name === "AbortError") {
        setStatusMessage(t("ai.workbench.generationCanceled"));
        setRunStatus("idle");
        return;
      }

      console.error("AI video submission failed", error);
      appendGenerationLogEntry(
        createAIGenerationLogEntry({
          submittedAt,
          mediaType: "video",
          mode: "text-to-video",
          status: "failed",
          model: {
            id: modelCard.id,
            name: modelCard.model,
            siteName: modelCard.siteName || modelCard.label || "Unknown site",
          },
          prompt: trimmedPrompt,
          params: videoParams,
          baseURL,
          endpoint: buildVideoSubmitEndpoint(baseURL),
          responseSummary:
            error instanceof AIImageGenerationError
              ? error.message
              : getUnknownErrorMessage(error, t),
          responseDetails: createErrorResponseDetails(error),
        }),
      );
      setErrorMessage(
        error instanceof AIImageGenerationError
          ? error.message
          : getUnknownErrorMessage(error, t),
      );
      setStatusMessage("");
      setRunStatus("failed");
    }
  }, [
    excalidrawAPI,
    selectedSources,
    startVideoPolling,
    syncPendingVideoTasks,
  ]);

  // Resume-on-mount: pick up any unfinished video tasks persisted in a previous
  // session (e.g. before a page refresh) and continue polling them. Runs once.
  useEffect(() => {
    if (didResumeVideoTasksRef.current) {
      return;
    }
    didResumeVideoTasksRef.current = true;

    const persisted = loadPendingVideoTasks();

    if (!persisted.length) {
      return;
    }

    setPendingVideoTasks(persisted);
    setStatusMessage(t("ai.workbench.videoTaskResumed"));
    for (const task of persisted) {
      startVideoPolling(task);
    }
  }, [startVideoPolling]);

  const loadMetadataIntoWorkbench = useCallback(
    (metadata: AIImageGenerationMetadata, message: string) => {
      const selectedMode = metadata.mode;
      const selectedModelId =
        config.models.find((model) => model.model === metadata.model)?.id ||
        metadata.model;

      setActiveDraftState((current) => ({
        ...current,
        mediaType: "image",
        mode: selectedMode,
        imageModes: {
          ...current.imageModes,
          [selectedMode]: {
            ...current.imageModes[selectedMode],
            selectedModelId,
            prompt: metadata.prompt,
            negativePrompt: metadata.negativePrompt || "",
            params: {
              ...current.imageModes[selectedMode].params,
              ...metadata.params,
            },
          },
        },
      }));
      setStatusMessage(message);
      setErrorMessage("");
    },
    [config.models, setActiveDraftState],
  );

  const copySelectedPrompt = useCallback(async () => {
    if (!selectedAIMetadata) {
      return;
    }

    await copyTextToSystemClipboard(selectedAIMetadata.prompt);
    excalidrawAPI?.setToast({ message: t("ai.common.promptCopied") });
  }, [excalidrawAPI, selectedAIMetadata]);

  const downloadSelectedImage = useCallback(() => {
    const source = currentSelectedImageSources[0];

    if (!source) {
      return;
    }

    downloadImageFromURL(
      source.dataURL,
      getImageDownloadFileName(source.file?.type, Date.now()),
    );
  }, [currentSelectedImageSources]);

  const copyCurrentPrompt = useCallback(async () => {
    if (!copyPromptActionState.canCopy) {
      return;
    }

    await copyTextToSystemClipboard(copyPromptActionState.prompt);
    excalidrawAPI?.setToast({ message: t("ai.common.promptCopied") });
    setStatusMessage(t("ai.common.promptCopied"));
    setErrorMessage("");
  }, [copyPromptActionState, excalidrawAPI]);
  const sendCurrentPromptToAssistant = useCallback(() => {
    if (!onSendPromptToAssistant || !sendPromptToAssistantActionState.canSend) {
      return;
    }

    onSendPromptToAssistant(sendPromptToAssistantActionState.prompt);
    setStatusMessage(t("ai.workbench.promptSentToAssistant"));
    setErrorMessage("");
  }, [onSendPromptToAssistant, sendPromptToAssistantActionState]);

  const loadSelectedMetadata = useCallback(() => {
    if (!selectedAIMetadata) {
      return;
    }

    loadMetadataIntoWorkbench(
      selectedAIMetadata,
      t("ai.workbench.selectedImageParamsLoaded"),
    );
  }, [loadMetadataIntoWorkbench, selectedAIMetadata]);

  const regenerateSelectedImage = useCallback(() => {
    if (!selectedAIMetadata) {
      return;
    }

    generate({
      mode: selectedAIMetadata.mode,
      model: selectedAIMetadata.model,
      prompt: selectedAIMetadata.prompt,
      negativePrompt: selectedAIMetadata.negativePrompt || "",
      params: {
        ...generationStateRef.current.params,
        ...selectedAIMetadata.params,
      },
    });
  }, [generate, selectedAIMetadata]);

  const copyGeneratedAssetPrompt = useCallback(
    async (asset: GeneratedAsset) => {
      await copyTextToSystemClipboard(asset.metadata.prompt);
      excalidrawAPI?.setToast({ message: t("ai.common.promptCopied") });
    },
    [excalidrawAPI],
  );

  const loadGeneratedAssetMetadata = useCallback(
    (asset: GeneratedAsset) => {
      loadMetadataIntoWorkbench(
        asset.metadata,
        t("ai.sidebar.generationSettingsLoaded"),
      );
    },
    [loadMetadataIntoWorkbench],
  );

  const insertGeneratedAssetCopy = useCallback(
    async (asset: GeneratedAsset) => {
      if (!excalidrawAPI) {
        return;
      }

      try {
        await insertGeneratedImageIntoCanvas({
          excalidrawAPI,
          output: asset.output,
          metadata: {
            ...asset.metadata,
            createdAt: new Date().toISOString(),
          },
          index: asset.index,
        });
        setStatusMessage(t("ai.workbench.copyInserted"));
        setErrorMessage("");
        setRunStatus("inserted");
      } catch (error: any) {
        console.error("Could not insert generated asset", error);
        setErrorMessage(error?.message || "Could not insert generated asset.");
        setStatusMessage("");
        setRunStatus("failed");
      }
    },
    [excalidrawAPI],
  );

  const addGeneratedAssetAsReference = useCallback((asset: GeneratedAsset) => {
    const createdAt = createAIReferenceId();
    const sourceBase = createGeneratedAssetReferenceSource(asset, createdAt);

    if (!sourceBase) {
      setErrorMessage(t("ai.workbench.remoteImageUrl"));
      setStatusMessage("");
      return;
    }

    setIsReferenceLocked(true);
    setSelectedSources((current) =>
      reindexReferenceImages([
        ...current,
        {
          ...sourceBase,
          index: current.length + 1,
        },
      ]),
    );
    setStatusMessage(t("ai.workbench.assetAddedToReferences"));
    setErrorMessage("");
  }, []);

  const clearGeneratedAssets = useCallback(() => {
    setGeneratedAssets([]);
  }, []);

  const insertPromptText = useCallback(
    (text: string, replaceRange?: { start: number; end: number }) => {
      const input = promptInputRef.current;
      const selectionStart = replaceRange?.start ?? input?.selectionStart ?? 0;
      const selectionEnd = replaceRange?.end ?? input?.selectionEnd ?? 0;
      const nextPrompt = `${prompt.slice(
        0,
        selectionStart,
      )}${text}${prompt.slice(selectionEnd)}`;
      const placeholderMatch = text.match(/\[[^\]]+]/);
      const nextCaret = selectionStart + text.length;

      setPrompt(nextPrompt);
      setReferencePickerState((current) => ({ ...current, isOpen: false }));

      window.requestAnimationFrame(() => {
        if (!input) {
          return;
        }

        if (placeholderMatch?.index != null) {
          const start = selectionStart + placeholderMatch.index;
          input.setSelectionRange(start, start + placeholderMatch[0].length);
        } else {
          input.setSelectionRange(nextCaret, nextCaret);
        }
        input.focus();
      });
    },
    [prompt, setPrompt],
  );

  const insertPromptTemplate = useCallback(
    (template: PromptTemplate) => {
      insertPromptText(template.template);
      setIsTemplateMenuOpen(false);
    },
    [insertPromptText],
  );

  const updateReferencePicker = useCallback(
    (input: PromptEditorHandle) => {
      if (!selectedSources.length) {
        setReferencePickerState((current) => ({ ...current, isOpen: false }));
        return;
      }

      const beforeCaret = input.value.slice(0, input.selectionStart);
      const match = beforeCaret.match(/(?:#|图|image\s*)(\d*)$/i);

      if (!match) {
        setReferencePickerState((current) => ({ ...current, isOpen: false }));
        return;
      }

      const query = match[1] || "";
      const requestedIndex = query ? Number(query) - 1 : 0;

      setReferencePickerState({
        isOpen: true,
        replaceStart: beforeCaret.length - match[0].length,
        replaceEnd: input.selectionStart,
        activeIndex: clampNumber(
          requestedIndex,
          0,
          Math.max(0, selectedSources.length - 1),
        ),
      });
    },
    [selectedSources.length],
  );

  const insertActiveReferenceToken = useCallback(() => {
    if (!referencePickerState.isOpen || !selectedSources.length) {
      return;
    }

    const source = selectedSources[referencePickerState.activeIndex];

    if (!source) {
      return;
    }

    insertPromptText(`#${source.index}`, {
      start: referencePickerState.replaceStart,
      end: referencePickerState.replaceEnd,
    });
  }, [insertPromptText, referencePickerState, selectedSources]);

  const jumpToNextPromptPlaceholder = useCallback(
    (input: PromptEditorHandle) => {
      const startIndex = Math.max(input.selectionEnd, 0);
      const afterCaret = prompt.slice(startIndex);
      const match = afterCaret.match(/\[[^\]]+]/);

      if (match?.index == null) {
        return false;
      }

      const start = startIndex + match.index;
      input.setSelectionRange(start, start + match[0].length);
      return true;
    },
    [prompt],
  );

  const handlePromptKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (referencePickerState.isOpen) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setReferencePickerState((current) => ({
            ...current,
            activeIndex: clampNumber(
              current.activeIndex + (event.key === "ArrowDown" ? 1 : -1),
              0,
              Math.max(0, selectedSources.length - 1),
            ),
          }));
          return;
        }

        if (event.key === "Enter") {
          event.preventDefault();
          insertActiveReferenceToken();
          return;
        }

        if (event.key === "Escape") {
          event.preventDefault();
          setReferencePickerState((current) => ({
            ...current,
            isOpen: false,
          }));
          return;
        }
      }

      if (event.key === "Tab") {
        const input = promptInputRef.current;

        if (input && jumpToNextPromptPlaceholder(input)) {
          event.preventDefault();
        }
      }
    },
    [
      insertActiveReferenceToken,
      jumpToNextPromptPlaceholder,
      referencePickerState.isOpen,
      selectedSources.length,
    ],
  );

  const openTemplateSettings = useCallback(() => {
    window.dispatchEvent(createAIOpenSettingsEvent({ tab: "templates" }));
    setIsTemplateMenuOpen(false);
  }, []);

  const openModelSettings = useCallback(() => {
    window.dispatchEvent(createAIOpenSettingsEvent({ tab: "models" }));
  }, []);

  const renderCopyPromptButton = () => (
    <button
      type="button"
      className="AIImageWorkbench__textButton"
      disabled={!copyPromptActionState.canCopy}
      onClick={copyCurrentPrompt}
    >
      {t("ai.common.copyPrompt")}
    </button>
  );

  const renderSendPromptToAssistantButton = () => (
    <button
      type="button"
      className="AIImageWorkbench__textButton"
      disabled={
        !onSendPromptToAssistant || !sendPromptToAssistantActionState.canSend
      }
      onClick={sendCurrentPromptToAssistant}
    >
      {t("ai.workbench.sendToAssistant")}
    </button>
  );

  const renderConfigurationNotice = () => {
    if (!configurationNotice) {
      return null;
    }

    return renderNotice(configurationNotice.message, {
      label: configurationNotice.actionLabel,
      onClick: openModelSettings,
    });
  };

  const renderPromptEditor = () => (
    <div className="AIImageWorkbench__promptBlock">
      <label className="AIImageWorkbench__field">
        <span>{t("ai.common.prompt")}</span>
        <div
          className={
            promptReferenceWarnings.length
              ? "AIImageWorkbench__promptShell has-warning"
              : "AIImageWorkbench__promptShell"
          }
        >
          <PromptEditor
            ref={promptInputRef}
            className="AIImageWorkbench__promptInput"
            value={prompt}
            referenceCount={promptReferenceCount}
            ariaLabel={t("ai.common.prompt")}
            placeholder={t("ai.workbench.describeImage")}
            onChange={setPrompt}
            onCaretChange={() => {
              const input = promptInputRef.current;
              if (input) {
                updateReferencePicker(input);
              }
            }}
            onClick={() => {
              const input = promptInputRef.current;
              if (input) {
                updateReferencePicker(input);
              }
            }}
            onKeyDown={handlePromptKeyDown}
          />
        </div>
      </label>

      <div className="AIImageWorkbench__templateRow">
        <button
          type="button"
          className="AIImageWorkbench__secondaryButton"
          onClick={() => setIsTemplateMenuOpen((current) => !current)}
        >
          {t("ai.workbench.templates")}
        </button>
        <div className="AIImageWorkbench__promptActions">
          {renderSendPromptToAssistantButton()}
          {renderCopyPromptButton()}
          <button
            type="button"
            className="AIImageWorkbench__textButton"
            onClick={openTemplateSettings}
          >
            {t("ai.common.manage")}
          </button>
        </div>
      </div>

      {isTemplateMenuOpen && (
        <div className="AIImageWorkbench__templateMenu">
          {promptTemplates.length === 0 && (
            <div className="AIImageWorkbench__emptyState">
              {t("ai.workbench.noTemplates")}
            </div>
          )}
          {groupPromptTemplates(promptTemplates, t).map((group) => (
            <div className="AIImageWorkbench__templateGroup" key={group.label}>
              <div className="AIImageWorkbench__templateGroupLabel">
                {group.label}
              </div>
              {group.templates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className="AIImageWorkbench__templateItem"
                  onClick={() => insertPromptTemplate(template)}
                >
                  <span>{template.label}</span>
                  <small>
                    {template.category
                      ? getPromptTemplateCategoryLabel(template.category, t)
                      : t("ai.common.custom")}
                  </small>
                </button>
              ))}
            </div>
          ))}
          <button
            type="button"
            className="AIImageWorkbench__templateItem"
            onClick={openTemplateSettings}
          >
            <span>{t("ai.workbench.manageTemplates")}</span>
          </button>
        </div>
      )}

      {referencePickerState.isOpen && (
        <div className="AIImageWorkbench__referencePicker">
          <div className="AIImageWorkbench__templateGroupLabel">
            {t("ai.workbench.insertReference")}
          </div>
          {selectedSources.map((source, index) => (
            <button
              key={source.createdAt}
              type="button"
              className={
                index === referencePickerState.activeIndex
                  ? "AIImageWorkbench__referencePickerItem is-active"
                  : "AIImageWorkbench__referencePickerItem"
              }
              onMouseDown={(event) => event.preventDefault()}
              onClick={() =>
                insertPromptText(`#${source.index}`, {
                  start: referencePickerState.replaceStart,
                  end: referencePickerState.replaceEnd,
                })
              }
            >
              <strong>#{source.index}</strong>
              <img src={source.dataURL} alt="" />
              <span>{getSourceTypeLabel(source.sourceType, t)}</span>
            </button>
          ))}
        </div>
      )}

      {promptReferenceWarnings.map((warning) => (
        <div className="AIImageWorkbench__warning" key={warning}>
          {warning}
        </div>
      ))}
    </div>
  );

  const renderReferenceImagesPanel = useCallback(() => {
    const weightEditorSource =
      weightEditorId == null
        ? null
        : selectedSources.find((source) => source.createdAt === weightEditorId);
    const hasCustomWeights = selectedSources.some(
      (source) => source.weight != null,
    );

    return (
      <div className="AIImageWorkbench__referencePanel">
        <div className="AIImageWorkbench__referenceHeader">
          <span>
            {t("ai.workbench.referenceImages", {
              count: selectedSources.length,
            })}
          </span>
          <div className="AIImageWorkbench__referenceToolbar">
            <button type="button" onClick={toggleReferenceLock}>
              {isReferenceLocked
                ? t("ai.workbench.locked")
                : t("ai.workbench.unlocked")}
            </button>
            {isReferenceLocked && (
              <button type="button" onClick={syncReferenceImagesFromSelection}>
                {t("ai.workbench.sync")}
              </button>
            )}
            <button
              type="button"
              aria-label={t("ai.workbench.addCurrentSelection")}
              title={t("ai.workbench.addCurrentSelection")}
              disabled={!selectedElementCount}
              onClick={addSelectionAsReference}
            >
              {t("ai.sidebar.addSelection")}
            </button>
            <button
              type="button"
              aria-label={t("ai.workbench.clearReferences")}
              title={t("ai.workbench.clearReferences")}
              disabled={!selectedSources.length}
              onClick={clearReferenceImages}
            >
              {t("ai.workbench.clearRefs")}
            </button>
            {selectedSources.length >= 3 && (
              <button
                type="button"
                onClick={() => {
                  setBatchMode((current) => !current);
                  setSelectedBatchIds(new Set());
                }}
              >
                {batchMode ? t("ai.workbench.done") : t("ai.workbench.batch")}
              </button>
            )}
          </div>
        </div>

        {!selectedElementCount && selectedSources.length === 0 && (
          <div className="AIImageWorkbench__referenceHint">
            {t("ai.workbench.selectElementsFirst")}
          </div>
        )}

        <div className="AIImageWorkbench__referenceGrid">
          {selectedSources.map((source) => (
            <div
              key={source.createdAt}
              role="button"
              tabIndex={0}
              draggable={selectedSources.length > 1}
              title={
                source.missingElement
                  ? t("ai.workbench.originalNotFound")
                  : t("ai.workbench.selectOriginalElements")
              }
              className={[
                "AIImageWorkbench__referenceCard",
                source.missingElement ? "is-missing" : "",
                draggedReferenceId === source.createdAt ? "is-dragging" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => highlightReferenceSource(source)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  highlightReferenceSource(source);
                  return;
                }
                // Clicking a card selects the original element on the canvas
                // (to highlight it), so a bare Backspace/Delete would otherwise
                // bubble to Excalidraw's document keydown listener and delete
                // that canvas element. Treat these keys as "remove this
                // reference from the list" (local + reversible) and stop them
                // from reaching the canvas.
                if (event.key === "Backspace" || event.key === "Delete") {
                  event.preventDefault();
                  event.stopPropagation();
                  removeReferenceImage(source.createdAt);
                }
              }}
              onDragStart={(event) => {
                setDraggedReferenceId(source.createdAt);
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData(
                  "text/plain",
                  String(source.createdAt),
                );
              }}
              onDragEnd={() => setDraggedReferenceId(null)}
              onDragOver={(event) => {
                if (draggedReferenceId != null) {
                  event.preventDefault();
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                const fromId = Number(event.dataTransfer.getData("text/plain"));
                moveReferenceImage(fromId, source.createdAt);
                setDraggedReferenceId(null);
              }}
            >
              {batchMode ? (
                <label
                  className="AIImageWorkbench__referenceCheckbox"
                  onClick={(event) => event.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={selectedBatchIds.has(source.createdAt)}
                    onChange={() => toggleBatchSelection(source.createdAt)}
                  />
                  <span>#{source.index}</span>
                </label>
              ) : source.missingElement ? (
                <span className="AIImageWorkbench__referenceBadge is-warning">
                  !
                </span>
              ) : (
                <span className="AIImageWorkbench__referenceBadge">
                  #{source.index}
                </span>
              )}

              <button
                type="button"
                className="AIImageWorkbench__referenceRemoveButton"
                aria-label={`${t("ai.workbench.removeReference")} #${
                  source.index
                }`}
                title={`${t("ai.workbench.removeReference")} #${source.index}`}
                onClick={(event) => {
                  event.stopPropagation();
                  removeReferenceImage(source.createdAt);
                }}
              >
                x
              </button>

              {source.weight != null && (
                <span
                  className="AIImageWorkbench__referenceWeightBadge"
                  title={t("ai.workbench.customWeight")}
                >
                  W
                </span>
              )}

              <img
                className="AIImageWorkbench__referenceThumb"
                src={source.dataURL}
                alt={t("ai.workbench.referenceAlt", {
                  index: source.index,
                })}
              />

              <div className="AIImageWorkbench__referenceMeta">
                <span>{getSourceTypeLabel(source.sourceType, t)}</span>
                <span>
                  {(source.weight ?? params.referenceStrength ?? 0.6).toFixed(
                    2,
                  )}
                </span>
              </div>

              <div className="AIImageWorkbench__referenceCardActions">
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    openWeightEditor(source);
                  }}
                >
                  {t("ai.workbench.weight")}
                </button>
              </div>
            </div>
          ))}
        </div>

        {selectedSources.length > 0 && (
          <div className="AIImageWorkbench__referenceHint">
            {t("ai.workbench.referencePromptHint")}
          </div>
        )}

        {batchMode && (
          <div className="AIImageWorkbench__batchPanel">
            <div className="AIImageWorkbench__referenceToolbar">
              <button type="button" onClick={selectAllBatchReferences}>
                {t("ai.workbench.selectAll")}
              </button>
              <button
                type="button"
                disabled={!selectedBatchIds.size}
                onClick={deleteSelectedBatchReferences}
              >
                {t("ai.workbench.deleteSelected")}
              </button>
            </div>
            <label className="AIImageWorkbench__field">
              <span>
                {t("ai.workbench.batchWeight", {
                  count: selectedBatchIds.size,
                })}
              </span>
              <input
                min={0}
                max={1}
                step={0.05}
                type="range"
                value={batchWeightDraft}
                onChange={(event) =>
                  setBatchWeightDraft(Number(event.target.value))
                }
              />
            </label>
            <button
              type="button"
              className="AIImageWorkbench__secondaryButton"
              disabled={!selectedBatchIds.size}
              onClick={applyBatchWeight}
            >
              {t("ai.workbench.applyToSelected")}
            </button>
          </div>
        )}

        {weightEditorSource && (
          <div className="AIImageWorkbench__weightPanel">
            <div className="AIImageWorkbench__referenceHeader">
              <span>
                {t("ai.workbench.referenceWeight", {
                  index: weightEditorSource.index,
                })}
              </span>
              <button
                type="button"
                className="AIImageWorkbench__textButton"
                onClick={() => setWeightEditorId(null)}
              >
                {t("ai.common.close")}
              </button>
            </div>
            <label className="AIImageWorkbench__field">
              <span>{weightDraft.toFixed(2)}</span>
              <input
                min={0}
                max={1}
                step={0.05}
                type="range"
                value={weightDraft}
                onChange={(event) => setWeightDraft(Number(event.target.value))}
              />
            </label>
            <div className="AIImageWorkbench__referenceToolbar">
              <button type="button" onClick={applyWeightEditor}>
                {t("ai.common.apply")}
              </button>
              <button
                type="button"
                onClick={() => {
                  resetReferenceWeight(weightEditorSource.createdAt);
                  setWeightEditorId(null);
                }}
              >
                {t("ai.workbench.useGlobal")}
              </button>
            </div>
          </div>
        )}

        {hasCustomWeights && (
          <button
            type="button"
            className="AIImageWorkbench__textButton"
            onClick={resetAllReferenceWeights}
          >
            {t("ai.workbench.resetAllWeights")}
          </button>
        )}

        <details className="AIImageWorkbench__advanced">
          <summary>{t("ai.workbench.exportOptions")}</summary>
          <div className="AIImageWorkbench__grid">
            <label className="AIImageWorkbench__field">
              <span>{t("ai.workbench.background")}</span>
              <select
                value={referenceExportOptions.background}
                onChange={(event) =>
                  setReferenceExportOptions((current) => ({
                    ...current,
                    background: event.target
                      .value as AIReferenceExportOptions["background"],
                  }))
                }
              >
                <option value="transparent">
                  {t("ai.workbench.transparent")}
                </option>
                <option value="white">{t("ai.workbench.white")}</option>
                <option value="canvas">{t("ai.workbench.canvas")}</option>
              </select>
            </label>

            <label className="AIImageWorkbench__field">
              <span>{t("ai.workbench.padding")}</span>
              <select
                value={referenceExportOptions.padding}
                onChange={(event) =>
                  setReferenceExportOptions((current) => ({
                    ...current,
                    padding: event.target
                      .value as AIReferenceExportOptions["padding"],
                  }))
                }
              >
                <option value="padded">16px</option>
                <option value="tight">{t("ai.workbench.tight")}</option>
              </select>
            </label>
          </div>

          <label className="AIImageWorkbench__field">
            <span>{t("ai.workbench.maxSize")}</span>
            <select
              value={referenceExportOptions.maxSize}
              onChange={(event) =>
                setReferenceExportOptions((current) => ({
                  ...current,
                  maxSize: event.target
                    .value as AIReferenceExportOptions["maxSize"],
                }))
              }
            >
              <option value="auto">{t("ai.workbench.auto")}</option>
              <option value="1024">1024px</option>
              <option value="2048">2048px</option>
            </select>
          </label>
        </details>
      </div>
    );
  }, [
    addSelectionAsReference,
    applyBatchWeight,
    applyWeightEditor,
    batchMode,
    batchWeightDraft,
    clearReferenceImages,
    deleteSelectedBatchReferences,
    draggedReferenceId,
    highlightReferenceSource,
    isReferenceLocked,
    moveReferenceImage,
    openWeightEditor,
    params.referenceStrength,
    referenceExportOptions.background,
    referenceExportOptions.maxSize,
    referenceExportOptions.padding,
    removeReferenceImage,
    resetAllReferenceWeights,
    resetReferenceWeight,
    selectedBatchIds,
    selectedElementCount,
    selectedSources,
    selectAllBatchReferences,
    syncReferenceImagesFromSelection,
    toggleBatchSelection,
    toggleReferenceLock,
    weightDraft,
    weightEditorId,
  ]);

  const renderGeneratedAssetsPanel = useCallback(() => {
    if (!generatedAssets.length) {
      return null;
    }

    return (
      <div className="AIImageWorkbench__section">
        <div className="AIImageWorkbench__sectionHeader">
          <h3>{t("ai.workbench.generatedAssets")}</h3>
          <button
            type="button"
            className="AIImageWorkbench__textButton"
            aria-label={t("ai.workbench.clearGeneratedAssets")}
            title={t("ai.workbench.clearGeneratedAssets")}
            onClick={clearGeneratedAssets}
          >
            {t("ai.common.clear")}
          </button>
        </div>

        <div className="AIImageWorkbench__assetGrid">
          {generatedAssets.map((asset) => {
            const canUseAsReference = isLocalImageDataURL(asset.output.dataURL);
            const actionLabels = getGeneratedAssetActionLabels(asset);

            return (
              <article className="AIImageWorkbench__assetCard" key={asset.id}>
                <div className="AIImageWorkbench__assetPreview">
                  <img
                    src={asset.output.dataURL}
                    alt={t("ai.workbench.assetActions.assetLabel", {
                      index: asset.index + 1,
                    })}
                  />
                  <span className="AIImageWorkbench__assetBadge">
                    #{asset.index + 1}
                  </span>
                </div>

                <div className="AIImageWorkbench__assetMeta">
                  <strong title={asset.metadata.mode}>
                    {getGeneratedAssetModeLabel(asset.metadata.mode)}
                  </strong>
                  <span title={asset.modelLabel}>{asset.siteName}</span>
                  <span>{formatGeneratedAssetTime(asset.createdAt)}</span>
                </div>

                {asset.output.revisedPrompt && (
                  <div
                    className="AIImageWorkbench__assetRevision"
                    title={asset.output.revisedPrompt}
                  >
                    {t("ai.workbench.revised")} {asset.output.revisedPrompt}
                  </div>
                )}

                <div className="AIImageWorkbench__assetActions">
                  <button
                    type="button"
                    aria-label={actionLabels.insert}
                    title={actionLabels.insert}
                    onClick={() => insertGeneratedAssetCopy(asset)}
                  >
                    {t("ai.workbench.insert")}
                  </button>
                  <button
                    type="button"
                    aria-label={actionLabels.download}
                    title={actionLabels.download}
                    onClick={() => downloadGeneratedAsset(asset)}
                  >
                    {t("ai.workbench.download")}
                  </button>
                  <button
                    type="button"
                    aria-label={actionLabels.useAsReference}
                    disabled={!canUseAsReference}
                    title={
                      canUseAsReference
                        ? actionLabels.useAsReference
                        : t("ai.workbench.remoteUrlCannotReference")
                    }
                    onClick={() => addGeneratedAssetAsReference(asset)}
                  >
                    {t("ai.workbench.useRef")}
                  </button>
                  <button
                    type="button"
                    aria-label={actionLabels.reuseSettings}
                    title={actionLabels.reuseSettings}
                    onClick={() => loadGeneratedAssetMetadata(asset)}
                  >
                    {t("ai.workbench.reuseSettings")}
                  </button>
                  <button
                    type="button"
                    aria-label={actionLabels.copyPrompt}
                    title={actionLabels.copyPrompt}
                    onClick={() => copyGeneratedAssetPrompt(asset)}
                  >
                    {t("ai.common.copyPrompt")}
                  </button>
                </div>

                <details className="AIImageWorkbench__assetDetails">
                  <summary>{t("ai.workbench.details")}</summary>
                  <dl>
                    <div>
                      <dt>{t("ai.common.model")}</dt>
                      <dd>{asset.metadata.model}</dd>
                    </div>
                    <div>
                      <dt>{t("ai.workbench.size")}</dt>
                      <dd>{asset.metadata.params.size}</dd>
                    </div>
                    <div>
                      <dt>{t("ai.common.prompt")}</dt>
                      <dd>{asset.metadata.prompt}</dd>
                    </div>
                  </dl>
                </details>
              </article>
            );
          })}
        </div>
      </div>
    );
  }, [
    addGeneratedAssetAsReference,
    clearGeneratedAssets,
    copyGeneratedAssetPrompt,
    generatedAssets,
    insertGeneratedAssetCopy,
    loadGeneratedAssetMetadata,
  ]);

  const referenceImagesPanel = useMemo(
    () => renderReferenceImagesPanel(),
    [renderReferenceImagesPanel],
  );
  const generatedAssetsPanel = useMemo(
    () => renderGeneratedAssetsPanel(),
    [renderGeneratedAssetsPanel],
  );

  const renderModelSelect = (disabled = false) => (
    <label className="AIImageWorkbench__field">
      <span>{t("ai.workbench.modelId")}</span>
      <select
        value={selectedModelId}
        disabled={disabled}
        onChange={(event) => setSelectedModelId(event.target.value)}
      >
        <option value="">
          {modelsForMediaType.length
            ? t("ai.workbench.selectModel")
            : t("ai.workbench.noMediaModels", {
                mediaType: getMediaTypeLabel(mediaType, t),
              })}
        </option>
        {modelsForMediaType.map((model) => (
          <option key={model.id} value={model.id}>
            {model.model} / {model.siteName}
          </option>
        ))}
      </select>
    </label>
  );

  const renderImageParameters = () => (
    <>
      <div className="AIImageWorkbench__segmentedControl">
        {MODE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={
              mode === option.value
                ? "AIImageWorkbench__segment is-selected"
                : "AIImageWorkbench__segment"
            }
            disabled={
              !config.models.some(
                (model) =>
                  model.mediaType === "image" &&
                  supportsAIImageMode(model, option.value),
              )
            }
            onClick={() => setMode(option.value)}
          >
            {t(option.labelKey)}
          </button>
        ))}
      </div>

      {renderPromptEditor()}

      <label className="AIImageWorkbench__field">
        <span>{t("ai.common.negativePrompt")}</span>
        <textarea
          value={negativePrompt}
          rows={2}
          disabled={
            !!selectedModel &&
            !supportsAIImageMode(selectedModel, "negative-prompt")
          }
          onChange={(event) => setNegativePrompt(event.target.value)}
        />
      </label>

      {renderModelSelect()}

      <div className="AIImageWorkbench__grid AIImageWorkbench__grid--three">
        <label className="AIImageWorkbench__field">
          <span>{t("ai.workbench.aspectRatio")}</span>
          <select
            value={params.aspectRatio || "auto"}
            onChange={(event) =>
              updateParams({ aspectRatio: event.target.value })
            }
          >
            {aspectRatioOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="AIImageWorkbench__field">
          <span>{t("ai.workbench.resolution")}</span>
          <select
            value={params.resolution || "auto"}
            onChange={(event) =>
              updateParams({ resolution: event.target.value })
            }
          >
            {resolutionOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="AIImageWorkbench__field">
          <span>{t("ai.workbench.count")}</span>
          <input
            min={1}
            max={MAX_IMAGE_COUNT}
            type="number"
            value={params.n}
            onChange={(event) =>
              updateParams({
                n: clampNumber(Number(event.target.value), 1, MAX_IMAGE_COUNT),
              })
            }
          />
        </label>
      </div>

      <div className="AIImageWorkbench__grid AIImageWorkbench__grid--three">
        <label className="AIImageWorkbench__field">
          <span>{t("ai.workbench.quality")}</span>
          <select
            value={params.quality || ""}
            disabled={
              !!selectedModel && !supportsAIImageMode(selectedModel, "quality")
            }
            onChange={(event) => updateParams({ quality: event.target.value })}
          >
            <option value="auto">AUTO</option>
            <option value="standard">{t("ai.workbench.standard")}</option>
            <option value="hd">HD</option>
            <option value="low">{t("ai.workbench.low")}</option>
            <option value="medium">{t("ai.workbench.medium")}</option>
            <option value="high">{t("ai.workbench.high")}</option>
          </select>
        </label>

        <label className="AIImageWorkbench__field">
          <span>{t("ai.workbench.style")}</span>
          <input
            type="text"
            disabled={
              !!selectedModel && !supportsAIImageMode(selectedModel, "style")
            }
            value={params.style || ""}
            onChange={(event) => updateParams({ style: event.target.value })}
          />
        </label>

        <label className="AIImageWorkbench__field">
          <span>{t("ai.workbench.seed")}</span>
          <div className="AIImageWorkbench__seedField">
            <input
              type="number"
              disabled={seedDisabled}
              value={params.seed ?? ""}
              placeholder={t("ai.workbench.seedRandom")}
              onChange={(event) =>
                updateParams({
                  seed: event.target.value ? Number(event.target.value) : null,
                })
              }
            />
            <button
              type="button"
              className="AIImageWorkbench__seedDice"
              disabled={seedDisabled}
              aria-label={t("ai.workbench.randomizeSeed")}
              title={t("ai.workbench.randomizeSeed")}
              onClick={() => updateParams({ seed: createRandomSeed() })}
            >
              {diceIcon}
            </button>
          </div>
        </label>
      </div>

      {requiresReference && referenceImagesPanel}

      {requiresReference &&
        selectedSources.length === 0 &&
        renderNotice(t("ai.workbench.addReferenceImage"))}

      {requiresMask &&
        inpaintSourceCandidates.length > 1 &&
        renderNotice(t("ai.workbench.selectOneImageBeforeMask"))}

      {requiresMask && (
        <div className="AIImageWorkbench__maskControls">
          {currentMask && (
            <div className="AIImageWorkbench__maskStatus">
              <span>
                {t("ai.workbench.mask", { name: currentMask.file.name })}
              </span>
              <button
                type="button"
                onClick={() => {
                  if (selectedMaskImageId) {
                    clearMaskForImage(selectedMaskImageId);
                  }
                }}
              >
                {t("ai.workbench.clearMask")}
              </button>
            </div>
          )}
          {maskEditableSource && onEnterMaskEditing && (
            <button
              type="button"
              className="AIImageWorkbench__secondaryButton"
              aria-label={editMaskLabel}
              title={editMaskLabel}
              onClick={() => {
                onEnterMaskEditing(
                  maskEditableSource.elementId,
                  currentMask?.elements,
                );
              }}
            >
              {editMaskLabel}
            </button>
          )}
        </div>
      )}

      {requiresReference && (
        <label className="AIImageWorkbench__field">
          <span>{t("ai.workbench.referenceStrength")}</span>
          <input
            min={0}
            max={1}
            step={0.05}
            type="range"
            disabled={
              !!selectedModel &&
              !supportsAIImageMode(selectedModel, "reference-strength")
            }
            value={params.referenceStrength ?? 0.6}
            onChange={(event) =>
              updateParams({
                referenceStrength: Number(event.target.value),
              })
            }
          />
        </label>
      )}

      {renderConfigurationNotice()}

      {isGenerating && (
        <div className="AIImageWorkbench__videoTasks">
          <div className="AIImageWorkbench__videoTask">
            <span className="AIImageWorkbench__videoTaskLabel">
              {t("ai.workbench.generatingImage")}
            </span>
            <button
              type="button"
              className="AIImageWorkbench__textButton"
              onClick={cancelGeneration}
            >
              {t("ai.common.cancel")}
            </button>
          </div>
        </div>
      )}

      <Button
        className="AIImageWorkbench__primaryButton"
        disabled={!canGenerate}
        onSelect={() => generate()}
      >
        {isGenerating
          ? t("ai.workbench.generating")
          : t("ai.workbench.generateImage")}
      </Button>
    </>
  );

  const renderVideoParameters = () => (
    <>
      <label className="AIImageWorkbench__field">
        <span>{t("ai.common.prompt")}</span>
        <textarea
          value={prompt}
          rows={4}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={t("ai.workbench.videoPromptPlaceholder")}
        />
      </label>

      <div className="AIImageWorkbench__promptActions AIImageWorkbench__promptActions--end">
        {renderSendPromptToAssistantButton()}
        {renderCopyPromptButton()}
      </div>

      <div className="AIImageWorkbench__grid">
        {renderModelSelect()}

        <label className="AIImageWorkbench__field">
          <span>{t("ai.workbench.aspectRatio")}</span>
          <select
            value={
              params.aspectRatio && params.aspectRatio !== "auto"
                ? params.aspectRatio
                : "16:9"
            }
            onChange={(event) =>
              updateParams({ aspectRatio: event.target.value })
            }
          >
            <option value="16:9">16:9</option>
            <option value="9:16">9:16</option>
            <option value="1:1">1:1</option>
            <option value="4:3">4:3</option>
          </select>
        </label>

        <label className="AIImageWorkbench__field">
          <span>{t("ai.workbench.duration")}</span>
          <input
            min={1}
            max={30}
            type="number"
            value={params.duration ?? 5}
            onChange={(event) =>
              updateParams({
                duration: clampNumber(Number(event.target.value), 1, 30),
              })
            }
          />
        </label>

        <label className="AIImageWorkbench__field">
          <span>{t("ai.workbench.resolution")}</span>
          <select
            value={
              params.resolution && params.resolution !== "auto"
                ? params.resolution
                : "720P"
            }
            onChange={(event) =>
              updateParams({ resolution: event.target.value })
            }
          >
            <option value="720P">720P</option>
            <option value="1080P">1080P</option>
          </select>
        </label>
      </div>

      {selectedSources.length > 0 &&
        selectedModel &&
        supportsAIImageMode(selectedModel, "image-to-video") &&
        renderNotice(
          t("ai.workbench.videoImageToVideoNotice", {
            count: selectedSources.length,
          }),
        )}

      {renderConfigurationNotice()}

      {pendingVideoTasks.length > 0 && (
        <div className="AIImageWorkbench__videoTasks">
          {pendingVideoTasks.map((task) => (
            <div key={task.taskId} className="AIImageWorkbench__videoTask">
              <span className="AIImageWorkbench__videoTaskLabel">
                {task.status === "queued"
                  ? t("ai.workbench.videoTaskQueued")
                  : t("ai.workbench.videoTaskPolling")}
              </span>
              <button
                type="button"
                className="AIImageWorkbench__textButton"
                onClick={() => cancelVideoTask(task.taskId)}
              >
                {t("ai.common.cancel")}
              </button>
            </div>
          ))}
        </div>
      )}

      <Button
        className="AIImageWorkbench__primaryButton"
        disabled={!canGenerateVideo}
        onSelect={() => generateVideo()}
      >
        {t("ai.workbench.generateVideo")}
      </Button>
    </>
  );

  const renderAudioParameters = () => (
    <>
      <label className="AIImageWorkbench__field">
        <span>{t("ai.common.prompt")}</span>
        <textarea
          value={prompt}
          rows={4}
          disabled
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={t("ai.workbench.audioPreviewOnly")}
        />
      </label>

      <div className="AIImageWorkbench__promptActions AIImageWorkbench__promptActions--end">
        {renderSendPromptToAssistantButton()}
        {renderCopyPromptButton()}
      </div>

      <div className="AIImageWorkbench__grid">
        {renderModelSelect(true)}

        <label className="AIImageWorkbench__field">
          <span>{t("ai.workbench.duration")}</span>
          <input
            min={1}
            max={300}
            type="number"
            disabled
            value={params.duration ?? 30}
            onChange={(event) =>
              updateParams({
                duration: clampNumber(Number(event.target.value), 1, 300),
              })
            }
          />
        </label>

        <label className="AIImageWorkbench__field">
          <span>{t("ai.workbench.format")}</span>
          <select
            value={params.audioFormat || "mp3"}
            disabled
            onChange={(event) =>
              updateParams({ audioFormat: event.target.value })
            }
          >
            <option value="mp3">MP3</option>
            <option value="wav">WAV</option>
            <option value="aac">AAC</option>
          </select>
        </label>

        <label className="AIImageWorkbench__field">
          <span>{t("ai.workbench.voice")}</span>
          <input
            type="text"
            disabled
            value={params.voice || ""}
            onChange={(event) => updateParams({ voice: event.target.value })}
          />
        </label>
      </div>

      {renderConfigurationNotice()}
      {renderNotice(t("ai.workbench.audioControlsPreviewOnly"))}

      <Button
        className="AIImageWorkbench__primaryButton"
        disabled
        onSelect={() => null}
      >
        {t("ai.workbench.audioPreviewOnly")}
      </Button>
    </>
  );

  return (
    <div className="AIImageWorkbench" ref={rootRef}>
      <div className="AIImageWorkbench__section">
        {isGenerating && (
          <div className="AIImageWorkbench__sectionHeader">
            <button
              className="AIImageWorkbench__textButton"
              type="button"
              onClick={cancelGeneration}
            >
              {t("ai.common.cancel")}
            </button>
          </div>
        )}
        <div className="AIImageWorkbench__statusStrip" aria-live="polite">
          {statusStripItems.map((item) => (
            <span
              key={item.label}
              className={`AIImageWorkbench__statusPill is-${item.tone}`}
              title={`${item.label}: ${item.value}`}
            >
              <strong>{item.label}</strong> {item.value}
            </span>
          ))}
        </div>

        <div className="AIImageWorkbench__segmentedControl">
          {MEDIA_TYPE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={
                mediaType === option.value
                  ? "AIImageWorkbench__segment is-selected"
                  : "AIImageWorkbench__segment"
              }
              onClick={() => setMediaType(option.value)}
            >
              {t(option.labelKey)}
            </button>
          ))}
        </div>

        {mediaType === "image" && renderImageParameters()}
        {mediaType === "video" && renderVideoParameters()}
        {mediaType === "audio" && renderAudioParameters()}
      </div>

      {generatedAssetsPanel}

      {selectedAIMetadata && (
        <div className="AIImageWorkbench__section">
          <div className="AIImageWorkbench__sectionHeader">
            <h3>{t("ai.workbench.selectedAIImage")}</h3>
          </div>
          <dl className="AIImageWorkbench__metadata">
            <div>
              <dt>{t("ai.common.mode")}</dt>
              <dd>{selectedAIMetadata.mode}</dd>
            </div>
            <div>
              <dt>{t("ai.workbench.modelId")}</dt>
              <dd>{selectedAIMetadata.model}</dd>
            </div>
            <div>
              <dt>{t("ai.common.prompt")}</dt>
              <dd>{selectedAIMetadata.prompt}</dd>
            </div>
          </dl>
          <div className="AIImageWorkbench__actions">
            <button type="button" onClick={copySelectedPrompt}>
              {t("ai.common.copyPrompt")}
            </button>
            <button
              type="button"
              onClick={downloadSelectedImage}
              disabled={!currentSelectedImageSources.length}
            >
              {t("ai.workbench.download")}
            </button>
            <button type="button" onClick={loadSelectedMetadata}>
              {t("ai.workbench.loadParams")}
            </button>
            <button
              type="button"
              onClick={regenerateSelectedImage}
              disabled={isGenerating}
            >
              {t("ai.workbench.regenerate")}
            </button>
          </div>
        </div>
      )}

      {(statusMessage || errorMessage) && (
        <div
          className={
            errorMessage
              ? "AIImageWorkbench__message is-error"
              : "AIImageWorkbench__message"
          }
        >
          {errorMessage || statusMessage}
        </div>
      )}
    </div>
  );
};

const getAIImageElementMetadata = (
  element: InitializedExcalidrawImageElement,
): AIImageGenerationMetadata | null => {
  return element.customData?.aiGeneration?.kind === "image"
    ? element.customData.aiGeneration
    : null;
};

const getDefaultModelIdForImageMode = (
  config: AIImageProviderConfig,
  mode: AIImageGenerationMode,
) => {
  const defaultModel = config.models.find(
    (model) =>
      model.id === config.defaultModel &&
      model.mediaType === "image" &&
      supportsAIImageMode(model, mode),
  );
  const firstSupportedModel = config.models.find(
    (model) => model.mediaType === "image" && supportsAIImageMode(model, mode),
  );

  return (
    defaultModel?.id ||
    firstSupportedModel?.id ||
    getDefaultModelIdForMediaType(config, "image")
  );
};

const getDefaultModelIdForMediaType = (
  config: AIImageProviderConfig,
  mediaType: AIModelMediaType,
) => {
  const defaultModel = config.models.find(
    (model) =>
      model.id === config.defaultModel && model.mediaType === mediaType,
  );
  const firstMediaModel = config.models.find(
    (model) => model.mediaType === mediaType,
  );

  return defaultModel?.id || firstMediaModel?.id || "";
};

const cloneMaskElements = (
  elements: readonly ExcalidrawFreeDrawElement[],
): ExcalidrawFreeDrawElement[] => {
  return elements.map((element) => ({
    ...element,
    groupIds: [...element.groupIds],
    boundElements: element.boundElements ? [...element.boundElements] : null,
    points: element.points.map((point) =>
      pointFrom<LocalPoint>(point[0], point[1]),
    ),
    pressures: [...element.pressures],
    customData: element.customData ? { ...element.customData } : undefined,
  }));
};

const clampNumber = (value: number, min: number, max: number) => {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
};

const renderNotice = (
  message: string,
  action?: { label: string; onClick: () => void },
) => {
  return (
    <div className="AIImageWorkbench__notice">
      <span>{message}</span>
      {action && (
        <button type="button" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
};

const getSourceTypeLabel = (
  sourceType: AIImageSourceEnhanced["sourceType"],
  t: AIWorkbenchT,
) => {
  if (sourceType === "canvas") {
    return t("ai.workbench.sourceType.canvas");
  }
  if (sourceType === "mixed") {
    return t("ai.workbench.sourceType.mixed");
  }
  return t("ai.workbench.sourceType.imported");
};

const getGeneratedImageReferencePlacement = (
  sources: readonly AIImageSourceEnhanced[],
): GeneratedImagePlacement | undefined => {
  const referenceSource = sources[0];

  if (!referenceSource) {
    return undefined;
  }

  const elementIds = referenceSource.elementIds?.length
    ? referenceSource.elementIds
    : [referenceSource.elementId];

  return {
    kind: "reference",
    elementIds,
  };
};

const getPromptTemplateCategoryLabel = (
  category: PromptTemplateCategory,
  t: AIWorkbenchT,
) => {
  if (category === "composition") {
    return t("ai.settings.options.composition");
  }
  if (category === "style") {
    return t("ai.settings.options.style");
  }
  if (category === "editing") {
    return t("ai.settings.options.editing");
  }
  return t("ai.settings.options.custom");
};

const getMediaTypeLabel = (mediaType: AIModelMediaType, t: AIWorkbenchT) => {
  if (mediaType === "video") {
    return t("ai.common.video");
  }
  if (mediaType === "audio") {
    return t("ai.common.audio");
  }
  return t("ai.common.image");
};

const createGeneratedAssetId = (index: number) => {
  return `generated-asset-${Date.now()}-${index}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
};

const formatGeneratedAssetTime = (createdAt: string) => {
  const date = new Date(createdAt);

  if (Number.isNaN(date.getTime())) {
    return "Now";
  }

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
};

const groupPromptTemplates = (
  templates: readonly PromptTemplate[],
  t: AIWorkbenchT,
) => {
  const groups: Array<{ label: string; templates: PromptTemplate[] }> = [];
  const labels: Record<NonNullable<PromptTemplate["language"]>, string> = {
    en: t("ai.common.english"),
    zh: t("ai.common.chinese"),
    multi: t("ai.common.multilingual"),
  };

  for (const language of ["en", "zh", "multi"] as const) {
    const languageTemplates = templates.filter(
      (template) =>
        template.isBuiltIn && (template.language || "multi") === language,
    );

    if (languageTemplates.length) {
      groups.push({
        label: labels[language],
        templates: languageTemplates,
      });
    }
  }

  const customTemplates = templates.filter((template) => !template.isBuiltIn);

  if (customTemplates.length) {
    groups.push({
      label: t("ai.workbench.templateGroups.custom"),
      templates: customTemplates,
    });
  }

  return groups;
};

const getReferencePersistenceKey = (excalidrawAPI: ExcalidrawImperativeAPI) => {
  // getName() fabricates a timestamped Untitled name when appState.name is
  // null, which made every persistence read/write use a different key.
  const sceneName = excalidrawAPI.getAppState().name?.trim() || "default";

  return `ai-reference-images-${encodeURIComponent(
    `${window.location.pathname}${window.location.search}:${sceneName}`,
  )}`;
};

const appendGenerationLogEntry = (
  entry: Parameters<typeof appendAIGenerationLog>[0],
) => {
  try {
    appendAIGenerationLog(entry);
  } catch (error: any) {
    console.error("Could not save AI generation log", error);
  }
};

const isValidGenerationOutputs = (
  outputs: unknown,
): outputs is AIImageGenerationOutput[] => {
  return (
    Array.isArray(outputs) &&
    outputs.length > 0 &&
    outputs.every(
      (output) =>
        !!output &&
        typeof output === "object" &&
        typeof (output as AIImageGenerationOutput).dataURL === "string" &&
        !!(output as AIImageGenerationOutput).dataURL,
    )
  );
};

const getUnknownErrorMessage = (error: any, t: AIWorkbenchT) => {
  if (error?.message) {
    return error.message;
  }

  if (error?.type) {
    return t("ai.workbench.unknownErrorWithType", { type: error.type });
  }

  const errorText = String(error);

  return errorText && errorText !== "[object Object]"
    ? t("ai.workbench.unknownErrorWithText", { message: errorText })
    : t("ai.workbench.unknownBrowserError");
};
