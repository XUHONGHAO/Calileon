import type { AIImageEndpoints, AIImageFieldMapping } from "./types";

export type EndpointPresetId =
  | "openai-standard"
  | "newapi-style"
  | "unified-json"
  | "gemini-native"
  | "right-code"
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

// Right Code draw API. Async: every image call submits with `async: true` and
// returns a task id; the adapter then polls `taskPollURL` until completion.
// Text-to-image and reference-image both use the OpenAI-compatible generations
// path (reference images ride along as the standard `image` field). Right Code
// exposes no dedicated inpaint route, so inpaint reuses the same async path.
// The poll URL is site-level (no `/draw` prefix), so it is an absolute URL.
export const RIGHT_CODE_ENDPOINTS: AIImageEndpoints = {
  textToImage: {
    path: "/v1/images/generations",
    format: "json",
    async: true,
  },
  imageToImage: {
    path: "/v1/images/generations",
    format: "json",
    async: true,
  },
  inpaint: {
    path: "/v1/images/generations",
    format: "json",
    async: true,
  },
  taskPollURL: "https://www.right.codes/v1/tasks/{task_id}",
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
    id: "right-code",
    name: "Right Code",
    description:
      "Right Code async draw API: submits with async=true, then polls the site-level task query for the result.",
    endpoints: RIGHT_CODE_ENDPOINTS,
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
  ...(endpoints.taskPollURL ? { taskPollURL: endpoints.taskPollURL } : {}),
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

const endpointConfigEqual = (
  left: AIImageEndpoints[keyof Omit<AIImageEndpoints, "taskPollURL">],
  right: AIImageEndpoints[keyof Omit<AIImageEndpoints, "taskPollURL">],
) => {
  return (
    left.path === right.path &&
    left.format === right.format &&
    !!left.async === !!right.async
  );
};

const endpointConfigsEqual = (
  left: AIImageEndpoints,
  right: AIImageEndpoints,
) => {
  return (
    endpointConfigEqual(left.textToImage, right.textToImage) &&
    endpointConfigEqual(left.imageToImage, right.imageToImage) &&
    endpointConfigEqual(left.inpaint, right.inpaint) &&
    (left.taskPollURL || "") === (right.taskPollURL || "")
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
