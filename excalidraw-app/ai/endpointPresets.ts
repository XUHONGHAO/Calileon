import type { AIImageEndpoints, AIImageFieldMapping } from "./types";

export type EndpointPresetId =
  | "openai-standard"
  | "newapi-style"
  | "unified-json"
  | "gemini-native"
  | "right-code"
  | "right-code-gemini"
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

// Right Code draw API (https://rightapi.ai, docs: rcdoc src/docs/rc_draw).
// Async: every image call submits with `async: true` and returns a task id; the
// adapter then polls `taskPollURL` until completion. The poll path is relative,
// so it follows whichever Right Code host the model's Base URL points at.
// OpenAI protocol (gpt-image-2 family): reference images go to the dedicated
// edits route as JSON data URLs. There is no working mask, so inpaint shares
// the edits route and the preset leaves the inpaint capability off.
export const RIGHT_CODE_ENDPOINTS: AIImageEndpoints = {
  textToImage: {
    path: "/v1/images/generations",
    format: "json",
    async: true,
  },
  imageToImage: {
    path: "/v1/images/edits",
    format: "json",
    async: true,
  },
  inpaint: {
    path: "/v1/images/edits",
    format: "json",
    async: true,
  },
  taskPollURL: "/v1/tasks/{task_id}",
};

// Right Code Gemini protocol (Nano Banana family): one async generateContent
// route for text-to-image and reference images, polled like the OpenAI one.
export const RIGHT_CODE_GEMINI_ENDPOINTS: AIImageEndpoints = {
  textToImage: {
    path: "/v1beta/models/{model}:generateContent",
    format: "gemini",
    async: true,
  },
  imageToImage: {
    path: "/v1beta/models/{model}:generateContent",
    format: "gemini",
    async: true,
  },
  inpaint: {
    path: "/v1beta/models/{model}:generateContent",
    format: "gemini",
    async: true,
  },
  taskPollURL: "/v1/tasks/{task_id}",
};

// Shapes saved by the earlier Right Code preset (draw host, site-level poll
// URL, reference images on the generations route). Saved models matching it
// are moved to RIGHT_CODE_ENDPOINTS on load; their Base URL is left alone.
export const LEGACY_RIGHT_CODE_ENDPOINTS: AIImageEndpoints = {
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
    name: "Right Code (OpenAI)",
    description:
      "Right Code async draw API, OpenAI protocol (gpt-image-2 family): submits with async=true to /v1/images/generations or /v1/images/edits, then polls /v1/tasks/{task_id}.",
    endpoints: RIGHT_CODE_ENDPOINTS,
  },
  {
    id: "right-code-gemini",
    name: "Right Code (Gemini)",
    description:
      "Right Code async draw API, Gemini protocol (Nano Banana family): submits with async=true to /v1beta/models/{model}:generateContent, then polls /v1/tasks/{task_id}.",
    endpoints: RIGHT_CODE_GEMINI_ENDPOINTS,
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

export const isLegacyRightCodeEndpoints = (endpoints: AIImageEndpoints) =>
  endpointConfigsEqual(endpoints, LEGACY_RIGHT_CODE_ENDPOINTS);

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
