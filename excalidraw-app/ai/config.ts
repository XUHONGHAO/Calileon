import { STORAGE_KEYS } from "../app_constants";

import {
  cloneAIImageEndpoints,
  OPENAI_STANDARD_ENDPOINTS,
} from "./endpointPresets";
import { normalizeAIImageNativeModel } from "./imageDimensions";

import type { EndpointPresetId } from "./endpointPresets";
import type {
  AIImageEndpointConfig,
  AIImageEndpoints,
  AIImageFieldMapping,
  AIModelMediaType,
  AIImageModel,
  AIImageModelCapability,
  AIImageProviderConfig,
} from "./types";

export const AI_IMAGE_CONFIG_UPDATED_EVENT = "excalidraw-ai-image-config";

export const DEFAULT_AI_IMAGE_REQUEST_TIMEOUT_SECONDS = 600;

export const AI_MODEL_MEDIA_TYPES: AIModelMediaType[] = [
  "image",
  "video",
  "audio",
];

const ALL_MODEL_CAPABILITIES: AIImageModelCapability[] = [
  "text-to-image",
  "image-to-image",
  "inpaint",
  "text-to-video",
  "image-to-video",
  "text-to-audio",
  "negative-prompt",
  "seed",
  "style",
  "quality",
  "reference-strength",
  "duration",
  "resolution",
  "aspect-ratio",
  "audio-format",
  "voice",
];

export const DEFAULT_IMAGE_MODEL_CAPABILITIES: AIImageModelCapability[] = [
  "text-to-image",
  "negative-prompt",
  "seed",
  "quality",
  "style",
];

export const DEFAULT_VIDEO_MODEL_CAPABILITIES: AIImageModelCapability[] = [
  "text-to-video",
  "image-to-video",
  "duration",
  "resolution",
  "aspect-ratio",
];

export const DEFAULT_AUDIO_MODEL_CAPABILITIES: AIImageModelCapability[] = [
  "text-to-audio",
  "duration",
  "audio-format",
  "voice",
];

export const MODEL_CAPABILITY_OPTIONS: Record<
  AIModelMediaType,
  Array<{ value: AIImageModelCapability; label: string }>
> = {
  image: [
    { value: "text-to-image", label: "Text to image" },
    { value: "image-to-image", label: "Reference image" },
    { value: "inpaint", label: "Inpaint" },
    { value: "negative-prompt", label: "Negative prompt" },
    { value: "seed", label: "Seed" },
    { value: "quality", label: "Quality" },
    { value: "style", label: "Style" },
    { value: "reference-strength", label: "Reference strength" },
  ],
  video: [
    { value: "text-to-video", label: "Text to video" },
    { value: "image-to-video", label: "Image to video" },
    { value: "duration", label: "Duration" },
    { value: "resolution", label: "Resolution" },
    { value: "aspect-ratio", label: "Aspect ratio" },
  ],
  audio: [
    { value: "text-to-audio", label: "Text to audio" },
    { value: "duration", label: "Duration" },
    { value: "audio-format", label: "Format" },
    { value: "voice", label: "Voice" },
  ],
};

export const DEFAULT_AI_IMAGE_CONFIG: AIImageProviderConfig = {
  baseURL: "",
  apiKey: "",
  defaultModel: "",
  models: [],
};

export type AIModelProviderPreset = Omit<
  AIImageModel,
  "id" | "apiKey" | "requestTimeoutSeconds"
> & {
  id: string;
  name: string;
  description: string;
  endpointPresetId: EndpointPresetId;
};

export const DEFAULT_AI_MODEL_PROVIDER_PRESETS: AIModelProviderPreset[] = [
  {
    id: "zhichuang-aggregation",
    name: "智创聚合",
    description:
      "OpenAI-compatible image API via n.lconai.com. Add your API key to use gpt-image-2.",
    siteName: "智创聚合",
    baseURL: "https://n.lconai.com/v1",
    model: "gpt-image-2",
    label: "gpt-image-2",
    mediaType: "image",
    nativeModel: "other",
    capabilities: ["text-to-image", "image-to-image", "inpaint"],
    endpoints: OPENAI_STANDARD_ENDPOINTS,
    endpointPresetId: "openai-standard",
  },
  {
    id: "pic2api",
    name: "pic2api API",
    description:
      "OpenAI-compatible pic2api image API. Add your API key to use gemini-3.0-pro-image.",
    siteName: "pic2api API",
    baseURL: "https://www.pic2api.com/v1",
    model: "gemini-3.0-pro-image",
    label: "gemini-3.0-pro-image",
    mediaType: "image",
    nativeModel: "nano-banana-pro",
    capabilities: ["text-to-image"],
    endpoints: OPENAI_STANDARD_ENDPOINTS,
    endpointPresetId: "openai-standard",
  },
];

export const createAIModelConfigId = () => {
  return `ai-model-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

export const parseModelIdListInput = (value: string): string[] => {
  const seenModelIds = new Set<string>();

  return value
    .split(/[\n,;]/)
    .map((modelId) => modelId.trim())
    .filter(Boolean)
    .filter((modelId) => {
      if (seenModelIds.has(modelId)) {
        return false;
      }

      seenModelIds.add(modelId);
      return true;
    });
};

export const isAIModelMediaType = (
  value: string,
): value is AIModelMediaType => {
  return AI_MODEL_MEDIA_TYPES.includes(value as AIModelMediaType);
};

const isModelCapability = (value: string): value is AIImageModelCapability => {
  return ALL_MODEL_CAPABILITIES.includes(value as AIImageModelCapability);
};

const dedupeCapabilities = (
  capabilities: AIImageModelCapability[],
): AIImageModelCapability[] => {
  return Array.from(new Set(capabilities));
};

export const getDefaultCapabilitiesForMediaType = (
  mediaType: AIModelMediaType,
): AIImageModelCapability[] => {
  if (mediaType === "video") {
    return DEFAULT_VIDEO_MODEL_CAPABILITIES;
  }
  if (mediaType === "audio") {
    return DEFAULT_AUDIO_MODEL_CAPABILITIES;
  }
  return DEFAULT_IMAGE_MODEL_CAPABILITIES;
};

const hasSameCapabilities = (
  capabilities: AIImageModelCapability[],
  targetCapabilities: AIImageModelCapability[],
) => {
  return (
    capabilities.length === targetCapabilities.length &&
    capabilities.every((capability) => targetCapabilities.includes(capability))
  );
};

const inferMediaTypeFromCapabilities = (
  capabilities: AIImageModelCapability[],
): AIModelMediaType => {
  if (
    capabilities.some(
      (capability) =>
        capability === "text-to-video" || capability === "image-to-video",
    )
  ) {
    return "video";
  }
  if (capabilities.some((capability) => capability === "text-to-audio")) {
    return "audio";
  }
  return "image";
};

const readStringField = (value: unknown) => {
  return typeof value === "string" ? value.trim() : "";
};

const isEndpointFormat = (
  value: unknown,
): value is AIImageEndpointConfig["format"] => {
  return value === "json" || value === "form" || value === "gemini";
};

const normalizeEndpointConfig = (
  value: unknown,
  fallback: AIImageEndpointConfig,
): AIImageEndpointConfig => {
  const endpoint = value && typeof value === "object" ? value : {};
  const path = readStringField((endpoint as any).path) || fallback.path;
  const format = isEndpointFormat((endpoint as any).format)
    ? (endpoint as AIImageEndpointConfig).format
    : fallback.format;

  return { path, format };
};

export const normalizeAIImageEndpoints = (value: unknown): AIImageEndpoints => {
  const endpoints = value && typeof value === "object" ? value : {};

  return {
    textToImage: normalizeEndpointConfig(
      (endpoints as any).textToImage,
      OPENAI_STANDARD_ENDPOINTS.textToImage,
    ),
    imageToImage: normalizeEndpointConfig(
      (endpoints as any).imageToImage,
      OPENAI_STANDARD_ENDPOINTS.imageToImage,
    ),
    inpaint: normalizeEndpointConfig(
      (endpoints as any).inpaint,
      OPENAI_STANDARD_ENDPOINTS.inpaint,
    ),
  };
};

const FIELD_MAPPING_KEYS: Array<keyof AIImageFieldMapping> = [
  "prompt",
  "negativePrompt",
  "model",
  "image",
  "mask",
  "size",
  "n",
];

export const normalizeAIImageFieldMapping = (
  value: unknown,
): AIImageFieldMapping | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const mapping: AIImageFieldMapping = {};

  for (const key of FIELD_MAPPING_KEYS) {
    const mappedField = readStringField((value as any)[key]);

    if (mappedField) {
      mapping[key] = mappedField;
    }
  }

  return Object.keys(mapping).length ? mapping : undefined;
};

export const migrateModelConfig = (
  model: AIImageModel | (Partial<AIImageModel> & Record<string, unknown>),
): AIImageModel => {
  const migratedModel: AIImageModel = {
    ...(model as AIImageModel),
    endpoints: normalizeAIImageEndpoints((model as any).endpoints),
  };
  const fieldMapping = normalizeAIImageFieldMapping(
    (model as any).fieldMapping,
  );

  if (fieldMapping) {
    migratedModel.fieldMapping = fieldMapping;
  } else {
    delete (migratedModel as Partial<AIImageModel>).fieldMapping;
  }

  return migratedModel;
};

const normalizeRequestTimeoutSeconds = (value: unknown) => {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string"
      ? Number(value.trim())
      : NaN;

  return Number.isFinite(numericValue) && numericValue > 0
    ? Math.round(numericValue)
    : DEFAULT_AI_IMAGE_REQUEST_TIMEOUT_SECONDS;
};

const createFallbackModelConfigId = (modelName: string, index: number) => {
  return `${modelName}-${index + 1}`;
};

export const normalizeAIImageConfig = (
  config: Partial<AIImageProviderConfig> | null | undefined,
): AIImageProviderConfig => {
  const legacyBaseURL = readStringField(config?.baseURL);
  const legacyApiKey = typeof config?.apiKey === "string" ? config.apiKey : "";
  const models = Array.isArray(config?.models)
    ? config.models
        .map((model, index): AIImageModel | null => {
          if (!model) {
            return null;
          }

          const modelId = readStringField((model as any).id);
          const modelName = readStringField((model as any).model) || modelId;

          if (!modelName) {
            return null;
          }

          const modelCapabilities = Array.isArray(model.capabilities)
            ? model.capabilities.filter(isModelCapability)
            : [];
          const mediaType = isAIModelMediaType((model as any).mediaType)
            ? (model as any).mediaType
            : inferMediaTypeFromCapabilities(modelCapabilities);
          const defaultCapabilities =
            getDefaultCapabilitiesForMediaType(mediaType);
          const capabilities = modelCapabilities.length
            ? modelCapabilities
            : defaultCapabilities;

          return migrateModelConfig({
            id: modelId || createFallbackModelConfigId(modelName, index),
            siteName:
              readStringField((model as any).siteName) ||
              readStringField(model.label) ||
              "Default site",
            baseURL: readStringField((model as any).baseURL) || legacyBaseURL,
            apiKey:
              typeof (model as any).apiKey === "string" &&
              (model as any).apiKey.trim()
                ? (model as any).apiKey
                : legacyApiKey,
            model: modelName,
            label:
              typeof model.label === "string" && model.label.trim()
                ? model.label.trim()
                : modelName,
            mediaType,
            nativeModel:
              mediaType === "image"
                ? normalizeAIImageNativeModel((model as any).nativeModel)
                : undefined,
            capabilities: dedupeCapabilities(
              capabilities.length ? capabilities : defaultCapabilities,
            ),
            endpoints: (model as any).endpoints,
            fieldMapping: (model as any).fieldMapping,
            requestTimeoutSeconds: normalizeRequestTimeoutSeconds(
              (model as any).requestTimeoutSeconds,
            ),
          });
        })
        .filter((model): model is AIImageModel => !!model)
    : [];

  const defaultModel =
    typeof config?.defaultModel === "string" ? config.defaultModel.trim() : "";

  return {
    baseURL: legacyBaseURL,
    apiKey: legacyApiKey,
    defaultModel:
      defaultModel && models.some((model) => model.id === defaultModel)
        ? defaultModel
        : models[0]?.id || "",
    models,
  };
};

export const loadAIImageConfig = (): AIImageProviderConfig => {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_AI_IMAGE);
    if (!raw) {
      return DEFAULT_AI_IMAGE_CONFIG;
    }

    return normalizeAIImageConfig(JSON.parse(raw));
  } catch (error: any) {
    console.error(error);
    return DEFAULT_AI_IMAGE_CONFIG;
  }
};

export const saveAIImageConfig = (config: AIImageProviderConfig) => {
  const normalizedConfig = normalizeAIImageConfig(config);

  localStorage.setItem(
    STORAGE_KEYS.LOCAL_STORAGE_AI_IMAGE,
    JSON.stringify(normalizedConfig),
  );

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(AI_IMAGE_CONFIG_UPDATED_EVENT, {
        detail: normalizedConfig,
      }),
    );
  }

  return normalizedConfig;
};

export const parseModelListInput = (value: string): AIImageModel[] => {
  return value
    .split(/[\n;]/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line): AIImageModel | null => {
      const [idPart = "", secondPart = "", thirdPart = "", fourthPart = ""] =
        line.split("|").map((part) => part.trim());

      if (!idPart) {
        return null;
      }

      const mediaType = isAIModelMediaType(secondPart)
        ? secondPart
        : isAIModelMediaType(thirdPart)
        ? thirdPart
        : "image";
      const labelPart = isAIModelMediaType(secondPart) ? "" : secondPart;
      const capabilitiesPart =
        fourthPart ||
        (thirdPart && !isAIModelMediaType(thirdPart) ? thirdPart : "");
      const capabilityCandidates = (
        capabilitiesPart ||
        (labelPart && labelPart.includes(",") ? labelPart : "") ||
        ""
      )
        .split(",")
        .map((capability) => capability.trim())
        .filter(Boolean);
      const maybeCapabilities =
        capabilityCandidates.length &&
        capabilityCandidates.every(isModelCapability)
          ? capabilityCandidates
          : [];
      const parsedCapabilities = maybeCapabilities.filter(isModelCapability);
      const defaultCapabilities = getDefaultCapabilitiesForMediaType(mediaType);

      const label = labelPart && !labelPart.includes(",") ? labelPart : idPart;

      return {
        id: idPart,
        siteName: label,
        baseURL: "",
        apiKey: "",
        model: idPart,
        label,
        mediaType,
        nativeModel: mediaType === "image" ? "other" : undefined,
        capabilities: dedupeCapabilities(
          parsedCapabilities.length ? parsedCapabilities : defaultCapabilities,
        ),
        endpoints: cloneAIImageEndpoints(OPENAI_STANDARD_ENDPOINTS),
        requestTimeoutSeconds: DEFAULT_AI_IMAGE_REQUEST_TIMEOUT_SECONDS,
      };
    })
    .filter((model): model is AIImageModel => !!model);
};

export const serializeModelListInput = (models: AIImageModel[]) => {
  return models
    .map((model) => {
      const capabilities = dedupeCapabilities(model.capabilities);
      const hasDefaultCapabilities = hasSameCapabilities(
        capabilities,
        getDefaultCapabilitiesForMediaType(model.mediaType),
      );
      const modelName = model.model || model.id;
      const hasCustomLabel = model.label !== modelName;
      const mediaType = model.mediaType === "image" ? "" : model.mediaType;

      if (hasDefaultCapabilities) {
        if (mediaType) {
          return hasCustomLabel
            ? `${modelName} | ${model.label} | ${mediaType}`
            : `${modelName} | ${mediaType}`;
        }
        return hasCustomLabel ? `${modelName} | ${model.label}` : modelName;
      }

      const capabilityText = capabilities.join(",");

      if (mediaType) {
        return hasCustomLabel
          ? `${modelName} | ${model.label} | ${mediaType} | ${capabilityText}`
          : `${modelName} | ${mediaType} | ${capabilityText}`;
      }

      return hasCustomLabel
        ? `${modelName} | ${model.label} | ${capabilityText}`
        : `${modelName} | ${capabilityText}`;
    })
    .join("; ");
};

export const supportsAIImageMode = (
  model: AIImageModel | undefined,
  mode: AIImageModelCapability,
) => {
  return !!model?.capabilities.includes(mode);
};
