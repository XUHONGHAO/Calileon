import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { copyTextToSystemClipboard } from "@excalidraw/excalidraw/clipboard";
import { Button } from "@excalidraw/excalidraw/components/Button";
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
import { createAIImageGenerationMetadata } from "../ai/metadata";
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
  getGeneratedAssetActionLabels,
  getGeneratedAssetModeLabel,
  isLocalImageDataURL,
} from "./AIImageWorkbenchAssets";
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
  createAIImageWorkbenchStatus,
  getAIImageWorkbenchConfigurationNotice,
} from "./AIImageWorkbenchStatus";
import {
  createCopyPromptActionState,
  createSendPromptToAssistantActionState,
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
  PromptTemplate,
} from "../ai/types";
import type { AIImageWorkbenchRunStatus } from "./AIImageWorkbenchStatus";
import type { GeneratedAsset } from "./AIImageWorkbenchAssets";

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

const MODE_OPTIONS: Array<{
  value: AIImageGenerationMode;
  label: string;
}> = [
  { value: "text-to-image", label: "Text" },
  { value: "image-to-image", label: "Reference" },
  { value: "inpaint", label: "Inpaint" },
];

const MEDIA_TYPE_OPTIONS: Array<{ value: AIModelMediaType; label: string }> = [
  { value: "image", label: "Image" },
  { value: "video", label: "Video" },
  { value: "audio", label: "Audio" },
];

const MAX_IMAGE_COUNT = 10;

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
};

const loadInitialWorkbenchState = () => {
  const config = loadAIImageConfig();
  const defaultModel = config.models.find(
    (model) => model.id === config.defaultModel,
  );

  return {
    config,
    mediaType: defaultModel?.mediaType || ("image" as AIModelMediaType),
    selectedModelId: config.defaultModel,
  };
};

const createDefaultParams = (): AIImageGenerationParams => ({
  ...DEFAULT_PARAMS,
});

const createGenerationDraftState = (
  selectedModelId: string,
): AIWorkbenchGenerationDraftState => ({
  selectedModelId,
  prompt: "",
  negativePrompt: "",
  params: createDefaultParams(),
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
    const imageTextModelId = getDefaultModelIdForImageMode(
      initialState.config,
      "text-to-image",
    );
    const imageReferenceModelId = getDefaultModelIdForImageMode(
      initialState.config,
      "image-to-image",
    );
    const imageInpaintModelId = getDefaultModelIdForImageMode(
      initialState.config,
      "inpaint",
    );

    return {
      mediaType: initialState.mediaType,
      mode: "text-to-image",
      imageModes: {
        "text-to-image": createImageModeDraftState(imageTextModelId),
        "image-to-image": createImageModeDraftState(imageReferenceModelId),
        inpaint: createImageModeDraftState(imageInpaintModelId),
      },
      video: createGenerationDraftState(
        getDefaultModelIdForMediaType(initialState.config, "video"),
      ),
      audio: createGenerationDraftState(
        getDefaultModelIdForMediaType(initialState.config, "audio"),
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
  const activeGenerationDraft =
    mediaType === "image"
      ? activeDraftState.imageModes[mode]
      : activeDraftState[mediaType];
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
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeRunIdRef = useRef(0);
  const generationTimeoutRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const draftSignatureRef = useRef<string | null>(null);
  const lastReferenceAddRequestIdRef = useRef<number | null>(null);
  const promptInputRef = useRef<HTMLTextAreaElement | null>(null);
  const didRestoreReferenceImagesRef = useRef(false);
  const skipNextReferencePersistenceRef = useRef(false);
  const isReferenceLockedRef = useRef(isReferenceLocked);
  const selectionSignatureRef = useRef<string | null>(null);
  const persistReferenceTimeoutRef = useRef<number | null>(null);
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

    return () => {
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
  const selectedMaskImageId =
    currentSelectedImageSources.length === 1
      ? currentSelectedImageSources[0].elementId
      : null;
  const currentMask = selectedMaskImageId
    ? inpaintDraft.masksByImageId[selectedMaskImageId] || null
    : null;
  const availableSelectedSources = useMemo(
    () => selectedSources.filter((source) => !source.missingElement),
    [selectedSources],
  );
  const editMaskLabel = currentMask
    ? "Re-edit mask on canvas"
    : "Edit mask on canvas";
  const isInpaintMode = mode === "inpaint";
  const maskEditableSource =
    isInpaintMode &&
    currentSelectedImageSources.length === 1 &&
    currentSelectedImageSources[0]?.fileId
      ? currentSelectedImageSources[0]
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
      selectedImageCount: currentSelectedImageSources.length,
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
      setErrorMessage("Select elements on canvas first.");
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
      setStatusMessage(warning || `Reference #${source.index} added.`);
      setErrorMessage("");
      excalidrawAPI.setToast({
        message: warning || `Reference #${source.index} added.`,
      });
    } catch (error: any) {
      console.error("Could not export reference selection", error);
      setErrorMessage(error?.message || "Could not export selection.");
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
      !window.confirm("Clear all references?")
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
          message: "Original element not found.",
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

    if (!savedState?.locked || !savedState.images.length) {
      return;
    }

    setIsReferenceLocked(true);
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

    if (!isReferenceLocked) {
      localStorage.removeItem(key);
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
      const activeSources =
        activeMode === "text-to-image"
          ? []
          : activeMode === "inpaint"
          ? currentSelectedImageSources
          : selectedSources.filter((source) => !source.missingElement);
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
        setErrorMessage("Only image generation is wired in this phase.");
        setStatusMessage("");
        setRunStatus("failed");
        return;
      }

      if (!activePrompt.trim()) {
        setErrorMessage("Prompt is required.");
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
          setErrorMessage("Select exactly one image before generating.");
          setStatusMessage("");
          setRunStatus("failed");
          return;
        }

        if (!activeMaskRecord) {
          setErrorMessage("Draw a mask before generating.");
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
      setStatusMessage("Generating image...");
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
            "Generation failed: provider returned malformed image data.",
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
                ? "Generated image inserted."
                : `${insertedCount} generated images inserted.`,
            responseDetails: createSuccessResponseDetails(outputs),
          }),
        );
        setStatusMessage(
          insertedCount === 1
            ? "Generated image inserted."
            : `${insertedCount} generated images inserted.`,
        );
        setRunStatus("inserted");
        excalidrawAPI.setToast({
          message: "Generated image inserted.",
        });
      } catch (error: any) {
        if (!isActiveRun()) {
          return;
        }

        console.error("AI image generation failed", error);

        if (error?.name === "AbortError") {
          if (didTimeout) {
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
                responseSummary: `Generation timed out after ${timeoutSeconds} seconds.`,
                responseDetails: createErrorResponseDetails(error),
              }),
            );
            setErrorMessage(
              `Generation timed out after ${timeoutSeconds} seconds.`,
            );
            setStatusMessage("");
            setRunStatus("failed");
          } else {
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
                responseSummary: "Generation canceled.",
                responseDetails: createErrorResponseDetails(error),
              }),
            );
            setStatusMessage("Generation canceled.");
            setRunStatus("canceled");
          }
          return;
        }

        const errorMessage =
          error instanceof AIImageGenerationError
            ? error.message
            : getUnknownErrorMessage(error);
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
    [excalidrawAPI],
  );

  const cancelGeneration = useCallback(() => {
    abortControllerRef.current?.abort();
  }, []);

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
    excalidrawAPI?.setToast({ message: "Prompt copied." });
  }, [excalidrawAPI, selectedAIMetadata]);

  const copyCurrentPrompt = useCallback(async () => {
    if (!copyPromptActionState.canCopy) {
      return;
    }

    await copyTextToSystemClipboard(copyPromptActionState.prompt);
    excalidrawAPI?.setToast({ message: "Prompt copied." });
    setStatusMessage("Prompt copied.");
    setErrorMessage("");
  }, [copyPromptActionState, excalidrawAPI]);
  const sendCurrentPromptToAssistant = useCallback(() => {
    if (!onSendPromptToAssistant || !sendPromptToAssistantActionState.canSend) {
      return;
    }

    onSendPromptToAssistant(sendPromptToAssistantActionState.prompt);
    setStatusMessage("Prompt sent to AI Assistant.");
    setErrorMessage("");
  }, [onSendPromptToAssistant, sendPromptToAssistantActionState]);

  const loadSelectedMetadata = useCallback(() => {
    if (!selectedAIMetadata) {
      return;
    }

    loadMetadataIntoWorkbench(
      selectedAIMetadata,
      "Selected image parameters loaded.",
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
      excalidrawAPI?.setToast({ message: "Prompt copied." });
    },
    [excalidrawAPI],
  );

  const loadGeneratedAssetMetadata = useCallback(
    (asset: GeneratedAsset) => {
      loadMetadataIntoWorkbench(
        asset.metadata,
        "Generated asset parameters loaded.",
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
        setStatusMessage("Generated asset copy inserted.");
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
      setErrorMessage("This generated result is a remote image URL.");
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
    setStatusMessage("Generated asset added to references.");
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
    (input: HTMLTextAreaElement) => {
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
    (input: HTMLTextAreaElement) => {
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
    (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
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
        const input = event.currentTarget;

        if (jumpToNextPromptPlaceholder(input)) {
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
      Copy prompt
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
      Send to assistant
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
        <span>Prompt</span>
        <textarea
          ref={promptInputRef}
          className={
            promptReferenceWarnings.length
              ? "AIImageWorkbench__promptInput has-warning"
              : "AIImageWorkbench__promptInput"
          }
          value={prompt}
          rows={4}
          onChange={(event) => {
            setPrompt(event.target.value);
            updateReferencePicker(event.currentTarget);
          }}
          onClick={(event) => updateReferencePicker(event.currentTarget)}
          onKeyDown={handlePromptKeyDown}
          placeholder="Describe the image"
        />
      </label>

      <div className="AIImageWorkbench__templateRow">
        <button
          type="button"
          className="AIImageWorkbench__secondaryButton"
          onClick={() => setIsTemplateMenuOpen((current) => !current)}
        >
          Templates
        </button>
        <div className="AIImageWorkbench__promptActions">
          {renderSendPromptToAssistantButton()}
          {renderCopyPromptButton()}
          <button
            type="button"
            className="AIImageWorkbench__textButton"
            onClick={openTemplateSettings}
          >
            Manage
          </button>
        </div>
      </div>

      {isTemplateMenuOpen && (
        <div className="AIImageWorkbench__templateMenu">
          {promptTemplates.length === 0 && (
            <div className="AIImageWorkbench__emptyState">
              No templates for this mode.
            </div>
          )}
          {groupPromptTemplates(promptTemplates).map((group) => (
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
                  <small>{template.category || "custom"}</small>
                </button>
              ))}
            </div>
          ))}
          <button
            type="button"
            className="AIImageWorkbench__templateItem"
            onClick={openTemplateSettings}
          >
            <span>Manage templates...</span>
          </button>
        </div>
      )}

      {referencePickerState.isOpen && (
        <div className="AIImageWorkbench__referencePicker">
          <div className="AIImageWorkbench__templateGroupLabel">
            Insert reference
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
              <span>{SOURCE_TYPE_LABELS[source.sourceType]}</span>
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
          <span>Reference Images ({selectedSources.length})</span>
          <div className="AIImageWorkbench__referenceToolbar">
            <button type="button" onClick={toggleReferenceLock}>
              {isReferenceLocked ? "Locked" : "Unlocked"}
            </button>
            {isReferenceLocked && (
              <button type="button" onClick={syncReferenceImagesFromSelection}>
                Sync
              </button>
            )}
            <button
              type="button"
              aria-label="Add current selection to references"
              title="Add current selection to references"
              disabled={!selectedElementCount}
              onClick={addSelectionAsReference}
            >
              Add selection
            </button>
            <button
              type="button"
              aria-label="Clear references"
              title="Clear references"
              disabled={!selectedSources.length}
              onClick={clearReferenceImages}
            >
              Clear refs
            </button>
            {selectedSources.length >= 3 && (
              <button
                type="button"
                onClick={() => {
                  setBatchMode((current) => !current);
                  setSelectedBatchIds(new Set());
                }}
              >
                {batchMode ? "Done" : "Batch"}
              </button>
            )}
          </div>
        </div>

        {!selectedElementCount && selectedSources.length === 0 && (
          <div className="AIImageWorkbench__referenceHint">
            Select elements on canvas first.
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
                  ? "Original element not found"
                  : "Select original elements on canvas"
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
                aria-label={`Remove reference #${source.index}`}
                title="Remove reference"
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
                  title="Custom weight"
                >
                  W
                </span>
              )}

              <img
                className="AIImageWorkbench__referenceThumb"
                src={source.dataURL}
                alt={`Reference #${source.index}`}
              />

              <div className="AIImageWorkbench__referenceMeta">
                <span>{SOURCE_TYPE_LABELS[source.sourceType]}</span>
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
                  Weight
                </button>
              </div>
            </div>
          ))}
        </div>

        {selectedSources.length > 0 && (
          <div className="AIImageWorkbench__referenceHint">
            Use #1, #2, #3 in the prompt to refer to images.
          </div>
        )}

        {batchMode && (
          <div className="AIImageWorkbench__batchPanel">
            <div className="AIImageWorkbench__referenceToolbar">
              <button type="button" onClick={selectAllBatchReferences}>
                Select all
              </button>
              <button
                type="button"
                disabled={!selectedBatchIds.size}
                onClick={deleteSelectedBatchReferences}
              >
                Delete selected
              </button>
            </div>
            <label className="AIImageWorkbench__field">
              <span>Batch weight ({selectedBatchIds.size})</span>
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
              Apply to selected
            </button>
          </div>
        )}

        {weightEditorSource && (
          <div className="AIImageWorkbench__weightPanel">
            <div className="AIImageWorkbench__referenceHeader">
              <span>Reference #{weightEditorSource.index} weight</span>
              <button
                type="button"
                className="AIImageWorkbench__textButton"
                onClick={() => setWeightEditorId(null)}
              >
                Close
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
                Apply
              </button>
              <button
                type="button"
                onClick={() => {
                  resetReferenceWeight(weightEditorSource.createdAt);
                  setWeightEditorId(null);
                }}
              >
                Use global
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
            Reset all weights
          </button>
        )}

        <details className="AIImageWorkbench__advanced">
          <summary>Export options</summary>
          <div className="AIImageWorkbench__grid">
            <label className="AIImageWorkbench__field">
              <span>Background</span>
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
                <option value="transparent">Transparent</option>
                <option value="white">White</option>
                <option value="canvas">Canvas</option>
              </select>
            </label>

            <label className="AIImageWorkbench__field">
              <span>Padding</span>
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
                <option value="tight">Tight</option>
              </select>
            </label>
          </div>

          <label className="AIImageWorkbench__field">
            <span>Max size</span>
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
              <option value="auto">Auto</option>
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
          <h3>Generated assets</h3>
          <button
            type="button"
            className="AIImageWorkbench__textButton"
            aria-label="Clear generated assets"
            title="Clear generated assets"
            onClick={clearGeneratedAssets}
          >
            Clear
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
                    alt={`Generated asset #${asset.index + 1}`}
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
                    Revised: {asset.output.revisedPrompt}
                  </div>
                )}

                <div className="AIImageWorkbench__assetActions">
                  <button
                    type="button"
                    aria-label={actionLabels.insert}
                    title={actionLabels.insert}
                    onClick={() => insertGeneratedAssetCopy(asset)}
                  >
                    Insert
                  </button>
                  <button
                    type="button"
                    aria-label={actionLabels.useAsReference}
                    disabled={!canUseAsReference}
                    title={
                      canUseAsReference
                        ? actionLabels.useAsReference
                        : "Remote URL cannot be used as a reference"
                    }
                    onClick={() => addGeneratedAssetAsReference(asset)}
                  >
                    Use ref
                  </button>
                  <button
                    type="button"
                    aria-label={actionLabels.reuseSettings}
                    title={actionLabels.reuseSettings}
                    onClick={() => loadGeneratedAssetMetadata(asset)}
                  >
                    Reuse settings
                  </button>
                  <button
                    type="button"
                    aria-label={actionLabels.copyPrompt}
                    title={actionLabels.copyPrompt}
                    onClick={() => copyGeneratedAssetPrompt(asset)}
                  >
                    Copy prompt
                  </button>
                </div>

                <details className="AIImageWorkbench__assetDetails">
                  <summary>Details</summary>
                  <dl>
                    <div>
                      <dt>Model</dt>
                      <dd>{asset.metadata.model}</dd>
                    </div>
                    <div>
                      <dt>Size</dt>
                      <dd>{asset.metadata.params.size}</dd>
                    </div>
                    <div>
                      <dt>Prompt</dt>
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
      <span>Model ID</span>
      <select
        value={selectedModelId}
        disabled={disabled}
        onChange={(event) => setSelectedModelId(event.target.value)}
      >
        <option value="">
          {modelsForMediaType.length
            ? "Select model"
            : `No ${mediaType} models`}
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
            {option.label}
          </button>
        ))}
      </div>

      {renderPromptEditor()}

      <label className="AIImageWorkbench__field">
        <span>Negative prompt</span>
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

      <div className="AIImageWorkbench__grid">
        <label className="AIImageWorkbench__field">
          <span>Aspect ratio</span>
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
          <span>Resolution</span>
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
      </div>

      <div className="AIImageWorkbench__grid">
        <label className="AIImageWorkbench__field">
          <span>Count</span>
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

        <label className="AIImageWorkbench__field">
          <span>Seed</span>
          <input
            type="number"
            disabled={
              !!selectedModel && !supportsAIImageMode(selectedModel, "seed")
            }
            value={params.seed ?? ""}
            onChange={(event) =>
              updateParams({
                seed: event.target.value ? Number(event.target.value) : null,
              })
            }
          />
        </label>
      </div>

      <div className="AIImageWorkbench__grid">
        <label className="AIImageWorkbench__field">
          <span>Quality</span>
          <select
            value={params.quality || ""}
            disabled={
              !!selectedModel && !supportsAIImageMode(selectedModel, "quality")
            }
            onChange={(event) => updateParams({ quality: event.target.value })}
          >
            <option value="auto">AUTO</option>
            <option value="standard">Standard</option>
            <option value="hd">HD</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>

        <label className="AIImageWorkbench__field">
          <span>Style</span>
          <input
            type="text"
            disabled={
              !!selectedModel && !supportsAIImageMode(selectedModel, "style")
            }
            value={params.style || ""}
            onChange={(event) => updateParams({ style: event.target.value })}
          />
        </label>
      </div>

      {requiresReference && referenceImagesPanel}

      {requiresReference &&
        selectedSources.length === 0 &&
        renderNotice("Add at least one reference image.")}

      {requiresMask &&
        currentSelectedImageSources.length > 1 &&
        renderNotice("Select exactly one image before editing a mask.")}

      {requiresMask && (
        <div className="AIImageWorkbench__maskControls">
          {currentMask && (
            <div className="AIImageWorkbench__maskStatus">
              <span>Mask: {currentMask.file.name}</span>
              <button
                type="button"
                onClick={() => {
                  if (selectedMaskImageId) {
                    clearMaskForImage(selectedMaskImageId);
                  }
                }}
              >
                Clear mask
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
          <span>Reference strength</span>
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

      <Button
        className="AIImageWorkbench__primaryButton"
        disabled={!canGenerate}
        onSelect={() => generate()}
      >
        {isGenerating ? "Generating..." : "Generate image"}
      </Button>
    </>
  );

  const renderVideoParameters = () => (
    <>
      <label className="AIImageWorkbench__field">
        <span>Prompt</span>
        <textarea
          value={prompt}
          rows={4}
          disabled
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Video preview only"
        />
      </label>

      <div className="AIImageWorkbench__promptActions AIImageWorkbench__promptActions--end">
        {renderSendPromptToAssistantButton()}
        {renderCopyPromptButton()}
      </div>

      <div className="AIImageWorkbench__grid">
        {renderModelSelect(true)}

        <label className="AIImageWorkbench__field">
          <span>Aspect ratio</span>
          <select
            value={params.aspectRatio || "16:9"}
            disabled
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
          <span>Duration</span>
          <input
            min={1}
            max={30}
            type="number"
            disabled
            value={params.duration ?? 5}
            onChange={(event) =>
              updateParams({
                duration: clampNumber(Number(event.target.value), 1, 30),
              })
            }
          />
        </label>

        <label className="AIImageWorkbench__field">
          <span>Resolution</span>
          <select
            value={
              ["720p", "1080p", "4k"].includes(params.resolution || "")
                ? params.resolution
                : "1080p"
            }
            disabled
            onChange={(event) =>
              updateParams({ resolution: event.target.value })
            }
          >
            <option value="720p">720p</option>
            <option value="1080p">1080p</option>
            <option value="4k">4K</option>
          </select>
        </label>

        <label className="AIImageWorkbench__field">
          <span>FPS</span>
          <input
            min={12}
            max={60}
            type="number"
            disabled
            value={params.fps ?? 24}
            onChange={(event) =>
              updateParams({
                fps: clampNumber(Number(event.target.value), 12, 60),
              })
            }
          />
        </label>
      </div>

      {renderConfigurationNotice()}
      {renderNotice("Video controls are preview-only in this phase.")}

      <Button
        className="AIImageWorkbench__primaryButton"
        disabled
        onSelect={() => null}
      >
        Video preview only
      </Button>
    </>
  );

  const renderAudioParameters = () => (
    <>
      <label className="AIImageWorkbench__field">
        <span>Prompt</span>
        <textarea
          value={prompt}
          rows={4}
          disabled
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Audio preview only"
        />
      </label>

      <div className="AIImageWorkbench__promptActions AIImageWorkbench__promptActions--end">
        {renderSendPromptToAssistantButton()}
        {renderCopyPromptButton()}
      </div>

      <div className="AIImageWorkbench__grid">
        {renderModelSelect(true)}

        <label className="AIImageWorkbench__field">
          <span>Duration</span>
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
          <span>Format</span>
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
          <span>Voice</span>
          <input
            type="text"
            disabled
            value={params.voice || ""}
            onChange={(event) => updateParams({ voice: event.target.value })}
          />
        </label>
      </div>

      {renderConfigurationNotice()}
      {renderNotice("Audio controls are preview-only in this phase.")}

      <Button
        className="AIImageWorkbench__primaryButton"
        disabled
        onSelect={() => null}
      >
        Audio preview only
      </Button>
    </>
  );

  return (
    <div className="AIImageWorkbench">
      <div className="AIImageWorkbench__section">
        <div className="AIImageWorkbench__sectionHeader">
          <h3>Create</h3>
          {isGenerating && (
            <button
              className="AIImageWorkbench__textButton"
              type="button"
              onClick={cancelGeneration}
            >
              Cancel
            </button>
          )}
        </div>
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
              {option.label}
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
            <h3>Selected AI image</h3>
          </div>
          <dl className="AIImageWorkbench__metadata">
            <div>
              <dt>Mode</dt>
              <dd>{selectedAIMetadata.mode}</dd>
            </div>
            <div>
              <dt>Model ID</dt>
              <dd>{selectedAIMetadata.model}</dd>
            </div>
            <div>
              <dt>Prompt</dt>
              <dd>{selectedAIMetadata.prompt}</dd>
            </div>
          </dl>
          <div className="AIImageWorkbench__actions">
            <button type="button" onClick={copySelectedPrompt}>
              Copy prompt
            </button>
            <button type="button" onClick={loadSelectedMetadata}>
              Load params
            </button>
            <button
              type="button"
              onClick={regenerateSelectedImage}
              disabled={isGenerating}
            >
              Regenerate
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

const SOURCE_TYPE_LABELS: Record<AIImageSourceEnhanced["sourceType"], string> =
  {
    imported: "Imported",
    canvas: "Canvas",
    mixed: "Mixed",
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

const groupPromptTemplates = (templates: readonly PromptTemplate[]) => {
  const groups: Array<{ label: string; templates: PromptTemplate[] }> = [];
  const labels: Record<NonNullable<PromptTemplate["language"]>, string> = {
    en: "English",
    zh: "中文",
    multi: "Multilingual",
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
      label: "Custom",
      templates: customTemplates,
    });
  }

  return groups;
};

const getReferencePersistenceKey = (excalidrawAPI: ExcalidrawImperativeAPI) => {
  const sceneName =
    typeof excalidrawAPI.getName === "function"
      ? excalidrawAPI.getName()
      : "default";

  return `ai-reference-images-${encodeURIComponent(
    `${window.location.pathname}:${sceneName}`,
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

const getUnknownErrorMessage = (error: any) => {
  if (error?.message) {
    return error.message;
  }

  if (error?.type) {
    return `Image generation failed: ${error.type}.`;
  }

  const errorText = String(error);

  return errorText && errorText !== "[object Object]"
    ? `Image generation failed: ${errorText}.`
    : "Image generation failed with an unknown browser error.";
};
