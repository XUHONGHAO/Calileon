import type { AIImageEndpoints, AIImageFieldMapping } from "./types";

export type EndpointPresetId =
  | "openai-standard"
  | "newapi-style"
  | "unified-json"
  | "gemini-native"
  | "custom";

export type EndpointPreset = {
  id: EndpointPresetId;
  name: string;
  description: string;
  endpoints: AIImageEndpoints;
  fieldMapping?: AIImageFieldMapping;
};

export const OPENAI_STANDARD_ENDPOINTS: AIImageEndpoints = {
  textToImage: {
    path: "/images/generations",
    format: "json",
  },
  imageToImage: {
    path: "/images/edits",
    format: "form",
  },
  inpaint: {
    path: "/images/edits",
    format: "form",
  },
};

export const NEWAPI_STYLE_ENDPOINTS: AIImageEndpoints = {
  textToImage: {
    path: "/images/generations",
    format: "json",
  },
  imageToImage: {
    path: "/images/generations",
    format: "json",
  },
  inpaint: {
    path: "/images/inpaint",
    format: "form",
  },
};

export const UNIFIED_JSON_ENDPOINTS: AIImageEndpoints = {
  textToImage: {
    path: "/images/create",
    format: "json",
  },
  imageToImage: {
    path: "/images/create",
    format: "json",
  },
  inpaint: {
    path: "/images/create",
    format: "json",
  },
};

export const UNIFIED_JSON_FIELD_MAPPING: AIImageFieldMapping = {
  prompt: "text",
  image: "init_image",
  mask: "mask_image",
};

export const GEMINI_NATIVE_ENDPOINTS: AIImageEndpoints = {
  textToImage: {
    path: "/models/{model}:generateContent",
    format: "gemini",
  },
  imageToImage: {
    path: "/models/{model}:generateContent",
    format: "gemini",
  },
  inpaint: {
    path: "/models/{model}:generateContent",
    format: "gemini",
  },
};

export const ENDPOINT_PRESETS: EndpointPreset[] = [
  {
    id: "openai-standard",
    name: "OpenAI Standard",
    description: "Official OpenAI image API format.",
    endpoints: OPENAI_STANDARD_ENDPOINTS,
  },
  {
    id: "newapi-style",
    name: "NewAPI Style",
    description: "Reference image requests use JSON on the generation path.",
    endpoints: NEWAPI_STYLE_ENDPOINTS,
  },
  {
    id: "unified-json",
    name: "Unified JSON",
    description: "All image modes use one JSON endpoint with base64 images.",
    endpoints: UNIFIED_JSON_ENDPOINTS,
    fieldMapping: UNIFIED_JSON_FIELD_MAPPING,
  },
  {
    id: "gemini-native",
    name: "Gemini Native",
    description:
      "Gemini v1beta generateContent format with contents/parts and inline_data images.",
    endpoints: GEMINI_NATIVE_ENDPOINTS,
  },
  {
    id: "custom",
    name: "Custom",
    description: "Manually configure paths, formats, and request fields.",
    endpoints: OPENAI_STANDARD_ENDPOINTS,
  },
];

export const cloneAIImageEndpoints = (
  endpoints: AIImageEndpoints,
): AIImageEndpoints => ({
  textToImage: { ...endpoints.textToImage },
  imageToImage: { ...endpoints.imageToImage },
  inpaint: { ...endpoints.inpaint },
});

export const cloneAIImageFieldMapping = (
  fieldMapping: AIImageFieldMapping | undefined,
): AIImageFieldMapping | undefined =>
  fieldMapping ? { ...fieldMapping } : undefined;

export const getPresetById = (
  id: string | undefined,
): EndpointPreset | undefined => {
  return ENDPOINT_PRESETS.find((preset) => preset.id === id);
};

const endpointConfigsEqual = (
  left: AIImageEndpoints,
  right: AIImageEndpoints,
) => {
  return (
    left.textToImage.path === right.textToImage.path &&
    left.textToImage.format === right.textToImage.format &&
    left.imageToImage.path === right.imageToImage.path &&
    left.imageToImage.format === right.imageToImage.format &&
    left.inpaint.path === right.inpaint.path &&
    left.inpaint.format === right.inpaint.format
  );
};

const fieldMappingsEqual = (
  left: AIImageFieldMapping | undefined,
  right: AIImageFieldMapping | undefined,
) => {
  const leftEntries = Object.entries(left || {}).filter(([, value]) => value);
  const rightEntries = Object.entries(right || {}).filter(([, value]) => value);
  const rightMapping = right || {};

  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([key, value]) =>
        rightMapping[key as keyof AIImageFieldMapping] === value,
    )
  );
};

export const getPresetIdForConfig = (
  endpoints: AIImageEndpoints,
  fieldMapping?: AIImageFieldMapping,
): EndpointPresetId => {
  const matchedPreset = ENDPOINT_PRESETS.find((preset) => {
    if (preset.id === "custom") {
      return false;
    }

    return (
      endpointConfigsEqual(endpoints, preset.endpoints) &&
      fieldMappingsEqual(fieldMapping, preset.fieldMapping)
    );
  });

  return matchedPreset?.id || "custom";
};
