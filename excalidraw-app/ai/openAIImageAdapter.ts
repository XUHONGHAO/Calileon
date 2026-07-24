import { getDataURL } from "@excalidraw/excalidraw/data/blob";

import type { DataURL } from "@excalidraw/excalidraw/types";

import { OPENAI_STANDARD_ENDPOINTS } from "./endpointPresets";

import type {
  AIImageEndpointConfig,
  AIImageFieldMapping,
  AIImageGenerationOutput,
  AIImageGenerationParams,
  AIImageGenerationRequest,
  AIImageModel,
} from "./types";

type OpenAIImageResponse = {
  candidates?: unknown;
  choices?: unknown;
  data?: unknown;
  image?: unknown;
  images?: unknown;
  output?: unknown;
  result?: unknown;
  b64_json?: unknown;
  url?: unknown;
  // Async (Right Code) submit/poll fields: submit returns a task id + status;
  // polling returns the same status until it resolves to completed/failed.
  task_id?: unknown;
  taskId?: unknown;
  id?: unknown;
  status?: unknown;
  progress?: unknown;
  error?: {
    message?: string;
    type?: string;
    code?: string | number;
  };
};

type NormalizedImageResponseItem = {
  b64JSON?: string;
  dataURL?: DataURL;
  mimeType?: string;
  remoteURL?: string;
  revisedPrompt?: string;
};

type AIImageProviderFlavor =
  | "openai-compatible"
  | "lconai"
  | "gemini-native"
  | "right-code";

export class AIImageGenerationError extends Error {
  constructor(
    message: string,
    public code:
      | "cors-or-network"
      | "auth"
      | "unsupported"
      | "invalid-response"
      | "request-failed",
    public details?: unknown,
  ) {
    super(message);
    this.name = "AIImageGenerationError";
  }
}

const trimTrailingSlashes = (value: string) => value.replace(/\/+$/, "");
const IMAGE_GENERATION_ENDPOINT = "/images/generations";
const IMAGE_EDIT_ENDPOINT = "/images/edits";
const IMAGE_ENDPOINT_SUFFIX = /\/images\/(?:generations|edits)$/i;

// A finished generation can still return an image URL rather than inline base64.
// Downloading that URL (and the liveness probe that follows a failed download)
// uses its own short timeout so a slow/hung image host falls back to referencing
// the URL directly, instead of stalling until the request's 600s cap.
const DEFAULT_REMOTE_IMAGE_DOWNLOAD_TIMEOUT_MS = 60_000;

export const buildEndpointURL = (
  baseURL: string,
  endpointConfig: AIImageEndpointConfig,
  model?: string,
): string => {
  const normalizedBaseURL = trimTrailingSlashes(baseURL.trim()).replace(
    IMAGE_ENDPOINT_SUFFIX,
    "",
  );
  const trimmedPath = endpointConfig.path
    .trim()
    .replaceAll("{model}", encodeURIComponent(model || ""));
  const normalizedPath = trimmedPath.startsWith("/")
    ? trimmedPath
    : `/${trimmedPath}`;

  return `${normalizedBaseURL}${normalizedPath}`;
};

export const getEndpointConfigForMode = (
  model: Pick<AIImageModel, "endpoints"> | undefined,
  mode: AIImageGenerationRequest["mode"],
): AIImageEndpointConfig => {
  const endpoints = model?.endpoints || OPENAI_STANDARD_ENDPOINTS;

  if (mode === "image-to-image") {
    return endpoints.imageToImage;
  }
  if (mode === "inpaint") {
    return endpoints.inpaint;
  }

  return endpoints.textToImage;
};

export const buildOpenAIImageEndpoint = (
  baseURL: string,
  mode: AIImageGenerationRequest["mode"],
) => {
  return buildEndpointURL(baseURL, {
    path:
      mode === "text-to-image"
        ? IMAGE_GENERATION_ENDPOINT
        : IMAGE_EDIT_ENDPOINT,
    format: mode === "text-to-image" ? "json" : "form",
  });
};

const getMappedFieldName = (
  fieldMapping: AIImageFieldMapping | undefined,
  key: keyof AIImageFieldMapping,
  fallback: string,
) => {
  return fieldMapping?.[key]?.trim() || fallback;
};

const dataURLToBase64Payload = (dataURL: DataURL) => {
  const [, base64Payload] = dataURL.split(",");

  return base64Payload || dataURL;
};

// Only OpenAI's *official* API rejects an explicit `response_format` on
// gpt-image-* with a 400 "Unknown parameter: 'response_format'". The many
// relays that proxy gpt-image-2 (duoyuanx, etc.) DO accept it, and asking for
// `b64_json` matters: without it they default to returning an image URL, which
// forces a second cross-origin download that can hang for minutes on a slow
// image host. So omit the parameter only for the official host; every relay
// keeps requesting inline base64 to skip that download entirely.
const isOpenAIOfficialBaseURL = (baseURL: string | undefined) => {
  try {
    const hostname = new URL(
      trimTrailingSlashes((baseURL || "").trim()),
    ).hostname;

    return hostname === "api.openai.com" || hostname.endsWith(".openai.com");
  } catch {
    return false;
  }
};

const shouldOmitResponseFormat = (
  model: string | undefined,
  providerFlavor: AIImageProviderFlavor,
  baseURL?: string,
) =>
  // Right Code's documented request body is minimal and its async task query
  // returns whichever shape the provider chose (b64/url), which the response
  // extractor already handles; sending response_format risks a 400.
  providerFlavor === "right-code" ||
  (providerFlavor === "openai-compatible" &&
    isOpenAIOfficialBaseURL(baseURL) &&
    /^gpt-image(-|$)/i.test((model || "").trim()));

// Right Code takes `size` as an aspect ratio (or pixel string) plus a separate
// `imageSize` tier (1K/2K/4K), unlike the OpenAI-compatible path that sends one
// merged pixel string. Reconstruct both from the workbench params: the aspect
// ratio drives `size` when set (else the already-merged pixel size is a valid
// fallback Right Code also accepts), and the resolution tier maps to `imageSize`
// (skipped for auto / the 512 tier, which Right Code does not expose).
const RIGHT_CODE_IMAGE_SIZE_TIERS: Record<string, string> = {
  "1k": "1K",
  "2k": "2K",
  "4k": "4K",
};

const buildRightCodeSizing = (params: AIImageGenerationParams) => {
  const aspectRatio = params.aspectRatio?.trim();
  const size =
    aspectRatio && aspectRatio !== "auto" ? aspectRatio : params.size;
  const resolution = params.resolution?.trim().toLowerCase();
  const imageSize = resolution
    ? RIGHT_CODE_IMAGE_SIZE_TIERS[resolution]
    : undefined;

  return { size, imageSize };
};

const assertImageModeInputs = (request: AIImageGenerationRequest) => {
  if (request.mode === "text-to-image") {
    return;
  }

  if (!request.sources?.length) {
    throw new AIImageGenerationError(
      "Reference image mode requires at least one selected image.",
      "unsupported",
    );
  }

  if (request.mode === "inpaint" && !request.mask) {
    throw new AIImageGenerationError(
      "Inpaint mode requires a mask image.",
      "unsupported",
    );
  }
};

export const buildJSONRequestBody = (
  request: AIImageGenerationRequest,
  fieldMapping?: AIImageFieldMapping,
  providerFlavor: AIImageProviderFlavor = "openai-compatible",
): Record<string, unknown> => {
  const { model, prompt, negativePrompt, params, sources, mask } = request;
  const includeAdvancedParameters = providerFlavor !== "lconai";
  const isRightCode = providerFlavor === "right-code";
  const rightCodeSizing = isRightCode ? buildRightCodeSizing(params) : null;
  const body = stripUndefinedValues({
    [getMappedFieldName(fieldMapping, "model", "model")]: model,
    [getMappedFieldName(fieldMapping, "prompt", "prompt")]: prompt,
    [getMappedFieldName(fieldMapping, "negativePrompt", "negative_prompt")]:
      includeAdvancedParameters && negativePrompt ? negativePrompt : undefined,
    [getMappedFieldName(fieldMapping, "n", "n")]: params.n,
    [getMappedFieldName(fieldMapping, "size", "size")]: rightCodeSizing
      ? rightCodeSizing.size
      : params.size,
    imageSize: rightCodeSizing?.imageSize,
    // Async endpoints submit the task and return a task id; the adapter polls
    // taskPollURL for the result. Right Code requires this flag on every call.
    async: isRightCode ? true : undefined,
    response_format: shouldOmitResponseFormat(model, providerFlavor)
      ? undefined
      : "b64_json",
    seed: includeAdvancedParameters ? params.seed ?? undefined : undefined,
    quality: includeAdvancedParameters
      ? params.quality || undefined
      : undefined,
    style: includeAdvancedParameters ? params.style || undefined : undefined,
    reference_strength:
      includeAdvancedParameters && params.referenceStrength != null
        ? params.referenceStrength
        : undefined,
  });

  assertImageModeInputs(request);

  if (sources?.length) {
    const imagePayloads = sources.map((source) =>
      dataURLToBase64Payload(source.dataURL),
    );
    body[getMappedFieldName(fieldMapping, "image", "image")] =
      imagePayloads.length === 1 ? imagePayloads[0] : imagePayloads;

    const referenceWeights = getReferenceWeights(request);

    if (referenceWeights) {
      body.reference_weights = referenceWeights;
    }
  }

  if (mask) {
    body[getMappedFieldName(fieldMapping, "mask", "mask")] =
      dataURLToBase64Payload(mask.dataURL);
  }

  return body;
};

export const buildGeminiNativeRequestBody = (
  request: AIImageGenerationRequest,
): Record<string, unknown> => {
  const { prompt, params, sources, mask } = request;
  const parts: Array<Record<string, unknown>> = [{ text: prompt }];

  assertImageModeInputs(request);

  for (const source of sources || []) {
    parts.push({
      inline_data: {
        mime_type: source.file.type || getMimeTypeFromDataURL(source.dataURL),
        data: dataURLToBase64Payload(source.dataURL),
      },
    });
  }

  if (mask) {
    parts.push({
      inline_data: {
        mime_type: mask.file.type || getMimeTypeFromDataURL(mask.dataURL),
        data: dataURLToBase64Payload(mask.dataURL),
      },
    });
  }

  return stripUndefinedValues({
    contents: [
      {
        role: "user",
        parts,
      },
    ],
    generationConfig: stripUndefinedValues({
      responseModalities: ["TEXT", "IMAGE"],
      aspectRatio: params.aspectRatio || undefined,
      resolution: params.resolution || undefined,
    }),
  });
};

export const buildTextToImageBody = (
  request: AIImageGenerationRequest,
  providerFlavor: AIImageProviderFlavor = "openai-compatible",
): Record<string, unknown> => {
  return buildJSONRequestBody(request, undefined, providerFlavor);
};

export const buildFormDataRequestBody = (
  request: AIImageGenerationRequest,
  fieldMapping?: AIImageFieldMapping,
  providerFlavor: AIImageProviderFlavor = "openai-compatible",
) => {
  const { model, prompt, negativePrompt, params, sources, mask } = request;
  const includeAdvancedParameters = providerFlavor !== "lconai";

  assertImageModeInputs(request);

  const formData = new FormData();
  formData.append(getMappedFieldName(fieldMapping, "model", "model"), model);
  formData.append(getMappedFieldName(fieldMapping, "prompt", "prompt"), prompt);
  formData.append(getMappedFieldName(fieldMapping, "n", "n"), String(params.n));
  formData.append(
    getMappedFieldName(fieldMapping, "size", "size"),
    params.size,
  );
  if (!shouldOmitResponseFormat(model, providerFlavor)) {
    formData.append("response_format", "b64_json");
  }

  if (includeAdvancedParameters && negativePrompt) {
    formData.append(
      getMappedFieldName(fieldMapping, "negativePrompt", "negative_prompt"),
      negativePrompt,
    );
  }
  if (includeAdvancedParameters && params.seed != null) {
    formData.append("seed", String(params.seed));
  }
  if (includeAdvancedParameters && params.quality) {
    formData.append("quality", params.quality);
  }
  if (includeAdvancedParameters && params.style) {
    formData.append("style", params.style);
  }
  if (includeAdvancedParameters && params.referenceStrength != null) {
    formData.append("reference_strength", String(params.referenceStrength));
  }

  for (const [index, source] of (sources || []).entries()) {
    const fieldName =
      fieldMapping?.image?.trim() ||
      getImageEditFieldName(providerFlavor, index, sources?.length || 0);

    formData.append(fieldName, source.file, source.file.name);
  }

  const referenceWeights = getReferenceWeights(request);

  if (referenceWeights) {
    formData.append("reference_weights", JSON.stringify(referenceWeights));
  }

  if (mask) {
    formData.append(
      getMappedFieldName(fieldMapping, "mask", "mask"),
      mask.file,
      mask.file.name,
    );
  }

  return formData;
};

export const buildImageEditBody = (
  request: AIImageGenerationRequest,
  providerFlavor: AIImageProviderFlavor = "openai-compatible",
) => {
  return buildFormDataRequestBody(request, undefined, providerFlavor);
};

// Async task polling (Right Code). The submit response carries a task id; poll
// the task query endpoint on a fixed cadence until the status resolves. Cadence
// and lifetime are bounded by the caller's AbortSignal (the workbench arms it
// with the model's requestTimeoutSeconds), so no separate timeout is needed.
const ASYNC_TASK_POLL_INTERVAL_MS = 2500;

const readAsyncTaskId = (response: OpenAIImageResponse): string => {
  return (
    readTrimmedString(response.task_id) ||
    readTrimmedString(response.taskId) ||
    readTrimmedString(response.id)
  );
};

const readTrimmedString = (value: unknown): string => {
  return typeof value === "string" ? value.trim() : "";
};

type AsyncTaskStatus = "pending" | "completed" | "failed";

// Right Code statuses: queued / in_progress keep polling; completed / failed
// are terminal. Unknown values keep polling so a new status spelling does not
// abort a task that is still making progress.
const normalizeAsyncStatus = (raw: string): AsyncTaskStatus => {
  const value = raw.trim().toLowerCase();

  if (
    value === "completed" ||
    value === "succeeded" ||
    value === "success" ||
    value === "done" ||
    value === "finished"
  ) {
    return "completed";
  }
  if (
    value === "failed" ||
    value === "failure" ||
    value === "error" ||
    value === "canceled" ||
    value === "cancelled"
  ) {
    return "failed";
  }

  return "pending";
};

// Resolve the task query URL. The Right Code preset ships an absolute,
// site-level template (no `/draw` prefix); a "/"-prefixed template resolves
// against the provider base URL's origin. `{task_id}` is substituted last.
export const buildTaskPollURL = (
  taskPollURL: string | undefined,
  baseURL: string,
  taskId: string,
): string => {
  const encodedTaskId = encodeURIComponent(taskId);
  const template = (taskPollURL || "").trim();

  if (!template) {
    throw new AIImageGenerationError(
      "Async image endpoint returned a task id but no task poll URL is configured.",
      "invalid-response",
    );
  }

  const substitute = (value: string) =>
    value.replaceAll("{task_id}", encodedTaskId);

  if (/^https?:\/\//i.test(template)) {
    return substitute(template);
  }

  let origin = "";

  try {
    origin = new URL(trimTrailingSlashes(baseURL.trim())).origin;
  } catch {
    throw new AIImageGenerationError(
      "Async image endpoint has a relative task poll URL but the provider base URL is not a valid absolute URL.",
      "request-failed",
      { baseURL, taskPollURL: template },
    );
  }

  const path = template.startsWith("/") ? template : `/${template}`;

  return substitute(`${origin}${path}`);
};

const pollAsyncImageTask = async ({
  submitJSON,
  baseURL,
  apiKey,
  taskPollURL,
  signal,
}: {
  submitJSON: OpenAIImageResponse;
  baseURL: string;
  apiKey: string;
  taskPollURL: string | undefined;
  signal: AbortSignal | undefined;
}): Promise<OpenAIImageResponse> => {
  const taskId = readAsyncTaskId(submitJSON);

  if (!taskId) {
    throw new AIImageGenerationError(
      "Async image submission failed: provider did not return a task id.",
      "invalid-response",
      { providerResponse: submitJSON },
    );
  }

  const pollURL = buildTaskPollURL(taskPollURL, baseURL, taskId);
  const authorizationHeader = getAuthorizationHeaderValue(apiKey, "right-code");
  const headers = new Headers({ Accept: "application/json" });

  if (authorizationHeader) {
    headers.set("Authorization", authorizationHeader);
  }

  // TODO(right-code-async-persistence): this loop lives only for the lifetime of
  // the request; a page refresh mid-generation loses the task. To survive
  // refreshes, persist { taskId, pollURL, modelId, prompt, params } the way
  // videoTaskStore does for video, hydrate on mount, and resume polling here.
  // Left out intentionally for now (Right Code image tasks finish in seconds).
  for (;;) {
    signal?.throwIfAborted();

    let response: Response;

    try {
      response = await fetch(pollURL, { method: "GET", headers, signal });
    } catch (error: any) {
      if (error?.name === "AbortError") {
        throw error;
      }

      throw new AIImageGenerationError(
        "AI image status request failed. Check that the provider allows CORS for the task query endpoint.",
        "cors-or-network",
        { endpoint: pollURL, errorMessage: error?.message },
      );
    }

    const pollJSON = (await parseResponseJSON(response)) as OpenAIImageResponse;

    if (!response.ok) {
      throw normalizeProviderError(response.status, pollJSON);
    }

    const rawStatus = readTrimmedString(pollJSON.status);
    const status =
      !rawStatus && pollJSON.error ? "failed" : normalizeAsyncStatus(rawStatus);

    if (status === "failed") {
      throw new AIImageGenerationError(
        pollJSON.error?.message || "AI image generation task failed.",
        "request-failed",
        { providerResponse: pollJSON },
      );
    }

    if (status === "completed") {
      return pollJSON;
    }

    await delayWithSignal(ASYNC_TASK_POLL_INTERVAL_MS, signal);
  }
};

const delayWithSignal = (ms: number, signal: AbortSignal | undefined) => {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }

    const onAbort = () => {
      window.clearTimeout(timeoutId);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timeoutId = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

export const generateImagesWithOpenAIAdapter = async (
  request: AIImageGenerationRequest,
): Promise<AIImageGenerationOutput[]> => {
  const providerConfig = getProviderConfigForRequest(request);

  if (!providerConfig.baseURL) {
    throw new AIImageGenerationError(
      "AI image provider base URL is not configured.",
      "request-failed",
    );
  }
  if (!request.model) {
    throw new AIImageGenerationError(
      "AI image model is not configured.",
      "request-failed",
    );
  }

  const response = await fetchImageGenerationResponse(request);
  const submitJSON = (await parseResponseJSON(response)) as OpenAIImageResponse;

  if (!response.ok) {
    throw normalizeProviderError(response.status, submitJSON);
  }
  if (submitJSON.error) {
    throw normalizeProviderError(response.status, submitJSON);
  }

  // Async (Right Code) endpoints return a task id rather than the image itself;
  // poll the task query until it completes, then extract from the final body.
  // Synchronous endpoints keep the submit response as the result body.
  const endpointConfig = getEndpointConfigForMode(
    providerConfig.modelConfig,
    request.mode,
  );
  const responseJSON = endpointConfig.async
    ? await pollAsyncImageTask({
        submitJSON,
        baseURL: providerConfig.baseURL,
        apiKey: providerConfig.apiKey,
        taskPollURL: providerConfig.modelConfig?.endpoints.taskPollURL,
        signal: request.signal,
      })
    : submitJSON;

  const imageItems = extractImageResponseItems(responseJSON);

  if (!imageItems.length) {
    throw new AIImageGenerationError(
      "Generation failed: provider returned no images.",
      "invalid-response",
      {
        providerResponse: responseJSON,
      },
    );
  }

  return Promise.all(
    imageItems.map(async (item) => {
      if (item.dataURL) {
        return {
          dataURL: item.dataURL,
          mimeType:
            item.mimeType ||
            getMimeTypeFromDataURL(item.dataURL) ||
            "image/png",
          revisedPrompt: item.revisedPrompt,
        };
      }

      if (item.b64JSON) {
        return {
          dataURL: `data:${item.mimeType || "image/png"};base64,${
            item.b64JSON
          }` as DataURL,
          mimeType: item.mimeType || "image/png",
          revisedPrompt: item.revisedPrompt,
        };
      }

      if (item.remoteURL) {
        if (isImageGenerationAPIEndpointURL(item.remoteURL)) {
          throw new AIImageGenerationError(
            "Generation failed: provider returned an image generation API endpoint instead of an image file URL.",
            "invalid-response",
            { remoteURL: item.remoteURL },
          );
        }

        const { dataURL, mimeType, storageType, remoteFetchError } =
          await resolveRemoteImageAsCanvasFile(item.remoteURL, request.signal);

        return {
          dataURL,
          mimeType,
          remoteURL: item.remoteURL,
          storageType,
          remoteFetchError,
          revisedPrompt: item.revisedPrompt,
        };
      }

      throw new AIImageGenerationError(
        "Generation failed: provider response does not contain image data.",
        "invalid-response",
      );
    }),
  );
};

const extractImageResponseItems = (
  responseJSON: OpenAIImageResponse,
): NormalizedImageResponseItem[] => {
  return [
    ...extractImageItemsFromValue(responseJSON.candidates),
    ...extractImageItemsFromValue(responseJSON.data),
    ...extractImageItemsFromValue(responseJSON.images),
    ...extractImageItemsFromValue(responseJSON.image),
    ...extractImageItemsFromValue(responseJSON.output),
    ...extractImageItemsFromValue(responseJSON.result),
    ...extractImageItemsFromValue(responseJSON.choices),
    ...normalizeImageObject(responseJSON, undefined, {
      includeNested: false,
      includeResult: false,
    }),
  ];
};

const extractImageItemsFromValue = (
  value: unknown,
  inheritedRevisedPrompt?: string,
): NormalizedImageResponseItem[] => {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    return extractImageItemsFromString(value, inheritedRevisedPrompt);
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      extractImageItemsFromValue(item, inheritedRevisedPrompt),
    );
  }

  if (typeof value === "object") {
    return normalizeImageObject(
      value as Record<string, unknown>,
      inheritedRevisedPrompt,
    );
  }

  return [];
};

const normalizeImageObject = (
  value: Record<string, unknown>,
  inheritedRevisedPrompt?: string,
  options: { includeNested?: boolean; includeResult?: boolean } = {},
): NormalizedImageResponseItem[] => {
  const { includeNested = true, includeResult = true } = options;
  const revisedPrompt =
    readString(value.revised_prompt) ||
    readString(value.revisedPrompt) ||
    inheritedRevisedPrompt;
  const mimeType =
    readString(value.mime_type) || readString(value.mimeType) || undefined;
  const directImage =
    normalizeInlineImageData(value.inline_data, revisedPrompt) ||
    normalizeInlineImageData(value.inlineData, revisedPrompt) ||
    normalizeBase64ImageString(
      readString(value.b64_json),
      revisedPrompt,
      mimeType,
    ) ||
    normalizeBase64ImageString(
      readString(value.b64),
      revisedPrompt,
      mimeType,
    ) ||
    normalizeBase64ImageString(
      readString(value.base64_json),
      revisedPrompt,
      mimeType,
    ) ||
    normalizeBase64ImageString(
      readString(value.base64),
      revisedPrompt,
      mimeType,
    ) ||
    normalizeBase64ImageString(
      readString(value.image_base64),
      revisedPrompt,
      mimeType,
    ) ||
    normalizeImageString(readString(value.url), revisedPrompt, mimeType) ||
    normalizeImageString(
      readImageURL(value.image_url),
      revisedPrompt,
      mimeType,
    ) ||
    normalizeImageString(readString(value.data_url), revisedPrompt, mimeType) ||
    normalizeImageString(readString(value.dataURL), revisedPrompt, mimeType) ||
    (includeResult
      ? normalizeImageString(readString(value.result), revisedPrompt, mimeType)
      : null);

  const nestedItems = includeNested
    ? [
        ...extractImageItemsFromValue(value.data, revisedPrompt),
        ...extractImageItemsFromValue(value.images, revisedPrompt),
        ...extractImageItemsFromValue(value.image, revisedPrompt),
        ...extractImageItemsFromValue(value.output, revisedPrompt),
        ...extractImageItemsFromValue(value.content, revisedPrompt),
        ...extractImageItemsFromValue(value.parts, revisedPrompt),
        ...extractImageItemsFromValue(value.candidates, revisedPrompt),
        ...extractImageItemsFromValue(value.message, revisedPrompt),
        ...extractImageItemsFromValue(value.choices, revisedPrompt),
      ]
    : [];

  return directImage ? [directImage, ...nestedItems] : nestedItems;
};

const extractImageItemsFromString = (
  value: string,
  revisedPrompt?: string,
): NormalizedImageResponseItem[] => {
  const directImage = normalizeImageString(value, revisedPrompt);
  const markdownImages = Array.from(
    value.matchAll(/!\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g),
  )
    .map((match) => normalizeImageString(match[1], revisedPrompt))
    .filter((item): item is NormalizedImageResponseItem => !!item);

  return directImage ? [directImage, ...markdownImages] : markdownImages;
};

const normalizeImageString = (
  value: string,
  revisedPrompt?: string,
  mimeType?: string,
): NormalizedImageResponseItem | null => {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return null;
  }

  if (trimmedValue.startsWith("data:image/")) {
    return {
      dataURL: trimmedValue as DataURL,
      mimeType: getMimeTypeFromDataURL(trimmedValue as DataURL) || mimeType,
      revisedPrompt,
    };
  }

  if (/^https?:\/\//i.test(trimmedValue)) {
    return {
      remoteURL: trimmedValue,
      mimeType,
      revisedPrompt,
    };
  }

  if (looksLikeBase64Image(trimmedValue)) {
    return {
      b64JSON: trimmedValue,
      mimeType,
      revisedPrompt,
    };
  }

  return null;
};

const normalizeBase64ImageString = (
  value: string,
  revisedPrompt?: string,
  mimeType?: string,
): NormalizedImageResponseItem | null => {
  const trimmedValue = value.trim();

  if (!trimmedValue) {
    return null;
  }

  if (trimmedValue.startsWith("data:image/")) {
    return {
      dataURL: trimmedValue as DataURL,
      mimeType: getMimeTypeFromDataURL(trimmedValue as DataURL) || mimeType,
      revisedPrompt,
    };
  }

  return {
    b64JSON: trimmedValue,
    mimeType,
    revisedPrompt,
  };
};

const normalizeInlineImageData = (
  value: unknown,
  revisedPrompt?: string,
): NormalizedImageResponseItem | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const inlineImage = value as Record<string, unknown>;
  const data = readString(inlineImage.data);

  if (!data) {
    return null;
  }

  return normalizeBase64ImageString(
    data,
    revisedPrompt,
    readString(inlineImage.mime_type) ||
      readString(inlineImage.mimeType) ||
      "image/png",
  );
};

const looksLikeBase64Image = (value: string) => {
  return value.length > 100 && /^[A-Za-z0-9+/=_-]+$/.test(value);
};

const readString = (value: unknown) => {
  return typeof value === "string" ? value : "";
};

const readImageURL = (value: unknown) => {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    return readString((value as Record<string, unknown>).url);
  }

  return "";
};

const getAIImageProviderFlavor = (
  baseURL: string,
  endpointConfig: AIImageEndpointConfig,
): AIImageProviderFlavor => {
  if (
    endpointConfig.format === "gemini" ||
    /:generateContent\b/i.test(endpointConfig.path)
  ) {
    return "gemini-native";
  }

  // Async endpoints (submit -> poll) are the Right Code draw paradigm. Sizing is
  // sent as a ratio `size` plus a discrete `imageSize` tier rather than a merged
  // pixel string, so it needs its own flavor even though the wire format is JSON.
  if (endpointConfig.async) {
    return "right-code";
  }

  try {
    const hostname = new URL(trimTrailingSlashes(baseURL.trim())).hostname;

    if (hostname === "lconai.com" || hostname.endsWith(".lconai.com")) {
      return "lconai";
    }
  } catch {
    // Malformed URLs are validated later by fetch so callers get the same error
    // path as any other unreachable provider.
  }

  return "openai-compatible";
};

export const getAuthorizationHeaderValue = (
  apiKey: string,
  providerFlavor: AIImageProviderFlavor = "openai-compatible",
) => {
  const trimmedApiKey = apiKey.trim();

  if (!trimmedApiKey) {
    return "";
  }

  if (/^(Bearer|Basic)\s+/i.test(trimmedApiKey)) {
    return trimmedApiKey;
  }

  return providerFlavor === "lconai"
    ? trimmedApiKey
    : `Bearer ${trimmedApiKey}`;
};

const getRawAPIKey = (apiKey: string) => {
  return apiKey.trim().replace(/^(Bearer|Basic)\s+/i, "");
};

const getImageEditFieldName = (
  providerFlavor: AIImageProviderFlavor,
  index: number,
  imageCount: number,
) => {
  if (providerFlavor === "lconai" && imageCount > 1) {
    return `image[${index}]`;
  }

  return "image";
};

const getReferenceWeights = (request: AIImageGenerationRequest) => {
  const sourcesWithOptionalWeights = request.sources as
    | Array<{ weight?: number }>
    | undefined;

  if (
    !sourcesWithOptionalWeights?.length ||
    !sourcesWithOptionalWeights.some((source) => source.weight != null)
  ) {
    return null;
  }

  return sourcesWithOptionalWeights.map(
    (source) => source.weight ?? request.params.referenceStrength ?? 0.6,
  );
};

const isImageGenerationAPIEndpointURL = (value: string) => {
  try {
    const url = new URL(value);

    return IMAGE_ENDPOINT_SUFFIX.test(trimTrailingSlashes(url.pathname));
  } catch {
    return false;
  }
};

const fetchImageGenerationResponse = async (
  request: AIImageGenerationRequest,
) => {
  const providerConfig = getProviderConfigForRequest(request);
  const endpointConfig = getEndpointConfigForMode(
    providerConfig.modelConfig,
    request.mode,
  );
  const endpoint = buildEndpointURL(
    providerConfig.baseURL,
    endpointConfig,
    providerConfig.modelName,
  );
  const providerFlavor = getAIImageProviderFlavor(
    providerConfig.baseURL,
    endpointConfig,
  );
  const headers = new Headers({ Accept: "application/json" });
  const authorizationHeader = getAuthorizationHeaderValue(
    providerConfig.apiKey,
    providerFlavor,
  );

  if (providerFlavor === "gemini-native" && providerConfig.apiKey.trim()) {
    headers.set("x-goog-api-key", getRawAPIKey(providerConfig.apiKey));
  } else if (authorizationHeader) {
    headers.set("Authorization", authorizationHeader);
  }

  const providerRequest = {
    ...request,
    model: providerConfig.modelName,
  };
  const init: RequestInit =
    endpointConfig.format === "json" || endpointConfig.format === "gemini"
      ? {
          method: "POST",
          headers: new Headers({
            ...Object.fromEntries(headers.entries()),
            "Content-Type": "application/json",
          }),
          body: JSON.stringify(
            endpointConfig.format === "gemini"
              ? buildGeminiNativeRequestBody(providerRequest)
              : buildJSONRequestBody(
                  providerRequest,
                  providerConfig.fieldMapping,
                  providerFlavor,
                ),
          ),
          signal: request.signal,
        }
      : {
          method: "POST",
          headers,
          body: buildFormDataRequestBody(
            providerRequest,
            providerConfig.fieldMapping,
            providerFlavor,
          ),
          signal: request.signal,
        };

  try {
    return await fetch(endpoint, init);
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw error;
    }

    throw new AIImageGenerationError(
      "AI image request failed before reaching the provider. Check that the model Base URL is reachable from this browser, uses HTTPS, and allows CORS for image requests.",
      "cors-or-network",
      { endpoint, errorMessage: error?.message },
    );
  }
};

const getProviderConfigForRequest = (request: AIImageGenerationRequest) => {
  const modelConfig = request.config.models.find(
    (model) => model.id === request.model || model.model === request.model,
  );

  return {
    baseURL: request.config.baseURL || modelConfig?.baseURL || "",
    apiKey: request.config.apiKey || modelConfig?.apiKey || "",
    fieldMapping: modelConfig?.fieldMapping,
    modelConfig,
    modelName: modelConfig?.model || request.model,
  };
};

const parseResponseJSON = async (response: Response) => {
  try {
    return await response.json();
  } catch (error: any) {
    if (response.ok) {
      throw new AIImageGenerationError(
        "Generation failed: provider returned a non-JSON response.",
        "invalid-response",
        { status: response.status },
      );
    }

    return {};
  }
};

export const normalizeProviderError = (
  status: number,
  responseJSON: Pick<OpenAIImageResponse, "error">,
) => {
  const message =
    responseJSON.error?.message || `AI image provider returned HTTP ${status}.`;

  if (status === 401 || status === 403) {
    return new AIImageGenerationError(
      "AI image request was rejected by the provider. Check the configured API key and model permissions.",
      "auth",
      {
        status,
        providerError: responseJSON.error,
      },
    );
  }

  if (status === 400 || status === 404 || status === 422) {
    return new AIImageGenerationError(message, "unsupported", {
      status,
      providerError: responseJSON.error,
    });
  }

  return new AIImageGenerationError(message, "request-failed", {
    status,
    providerError: responseJSON.error,
  });
};

export const fetchRemoteImageAsDataURL = async (
  url: string,
  signal: AbortSignal | undefined,
) => {
  let imageResponse: Response;

  try {
    imageResponse = await fetch(url, { signal });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw error;
    }

    throw new AIImageGenerationError(
      "Provider returned an image URL, but the browser could not download it. This is usually a CORS or network issue.",
      "cors-or-network",
      { remoteURL: url, errorMessage: error?.message },
    );
  }

  if (!imageResponse.ok) {
    throw new AIImageGenerationError(
      `Provider returned an image URL, but downloading it failed with HTTP ${imageResponse.status}.`,
      "request-failed",
      { remoteURL: url, status: imageResponse.status },
    );
  }

  const blob = await imageResponse.blob();
  const dataURL = await getDataURL(blob);

  return {
    dataURL,
    mimeType: blob.type || getMimeTypeFromDataURL(dataURL) || "image/png",
  };
};

const resolveRemoteImageAsCanvasFile = async (
  url: string,
  signal: AbortSignal | undefined,
) => {
  try {
    const { dataURL, mimeType } = await fetchRemoteImageAsDataURL(url, signal);

    return {
      dataURL,
      mimeType,
      storageType: "data-url" as const,
      remoteFetchError: undefined,
    };
  } catch (error: any) {
    if (error?.name === "AbortError" || error?.code !== "cors-or-network") {
      throw error;
    }

    await assertRemoteImageCanRender(url, signal, error);

    return {
      dataURL: url as DataURL,
      mimeType: getMimeTypeFromImageURL(url) || "image/png",
      storageType: "remote-url" as const,
      remoteFetchError: {
        message: error.message,
        code: error.code,
        details: error.details,
      },
    };
  }
};

const assertRemoteImageCanRender = (
  url: string,
  signal: AbortSignal | undefined,
  fetchError: AIImageGenerationError,
  timeoutMs: number = DEFAULT_REMOTE_IMAGE_DOWNLOAD_TIMEOUT_MS,
) => {
  return new Promise<void>((resolve, reject) => {
    const image = new Image();
    const createAbortError = () => {
      const error = new Error("Aborted");

      error.name = "AbortError";

      return error;
    };

    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      window.clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abort);
    };

    const abort = () => {
      cleanup();
      reject(createAbortError());
    };

    // The provider already produced this URL, so if the probe itself hangs on a
    // slow host we accept the URL rather than block until the parent 600s cap.
    // Referencing a valid-but-slow image beats discarding a successful result.
    const timeoutId = window.setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);

    image.onload = () => {
      cleanup();
      resolve();
    };
    image.onerror = () => {
      cleanup();
      reject(fetchError);
    };

    if (signal?.aborted) {
      abort();
      return;
    }

    signal?.addEventListener("abort", abort, { once: true });
    image.src = url;
  });
};

const getMimeTypeFromImageURL = (value: string) => {
  try {
    const pathname = new URL(value).pathname.toLowerCase();

    if (pathname.endsWith(".jpg") || pathname.endsWith(".jpeg")) {
      return "image/jpeg";
    }
    if (pathname.endsWith(".webp")) {
      return "image/webp";
    }
    if (pathname.endsWith(".gif")) {
      return "image/gif";
    }
    if (pathname.endsWith(".png")) {
      return "image/png";
    }
  } catch {
    // Ignore malformed URLs; the caller will use a safe image/png fallback.
  }

  return null;
};

export const getMimeTypeFromDataURL = (dataURL: DataURL) => {
  return dataURL.match(/^data:([^;,]+)[;,]/)?.[1] || null;
};

const stripUndefinedValues = (value: Record<string, unknown>) => {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
};
