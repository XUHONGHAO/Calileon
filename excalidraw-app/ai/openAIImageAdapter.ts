import { getDataURL } from "@excalidraw/excalidraw/data/blob";

import type { DataURL } from "@excalidraw/excalidraw/types";

import { OPENAI_STANDARD_ENDPOINTS } from "./endpointPresets";
import {
  AIProxyTransportError,
  fetchAIRequest,
  getManagedRouteForCapability,
  MANAGED_GATEWAY_TARGET,
} from "./requestTransport";
import { loadAIProxyConfig } from "./proxyConfig";
import {
  createAIRequestTimer,
  describeNetworkFailure,
  readDiagnosticResponseHeaders,
  readProviderResponseBody,
  summarizeRequestBody,
} from "./requestDiagnostics";

import type { AIRequestDiagnostics } from "./requestDiagnostics";
import type {
  AIImageEndpointConfig,
  AIImageFieldMapping,
  AIImageGenerationOutput,
  AIImageGenerationRequest,
  AIImageModel,
} from "./types";

import type { AiGatewayCatalogEntry } from "../data/cloud/types";

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
  // OpenAI-style `{ error: { message } }`; some relays (Right Code) send the
  // reason as a bare string, e.g. `{ error: "无效的API Key" }`.
  error?:
    | string
    | {
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
  | "right-code"
  | "right-code-gemini";

export class AIImageGenerationError extends Error {
  constructor(
    message: string,
    public code:
      | "cors-or-network"
      | "auth"
      | "unsupported"
      | "invalid-response"
      | "request-failed"
      | "proxy-network"
      | "proxy-error"
      | "proxy-config",
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
  // A path that carries its own API version (Right Code: `/v1/...`,
  // `/v1beta/...`) owns the version, so a version segment the user also put
  // at the end of the Base URL is dropped instead of doubled.
  const API_VERSION_SEGMENT = /^\/v\d+(?:beta|alpha)?\//i;
  const baseURLWithoutVersion = API_VERSION_SEGMENT.test(normalizedPath)
    ? normalizedBaseURL.replace(/\/v\d+(?:beta|alpha)?$/i, "")
    : normalizedBaseURL;

  return `${baseURLWithoutVersion}${normalizedPath}`;
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
    const hostname = new URL(trimTrailingSlashes((baseURL || "").trim()))
      .hostname;

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

// Right Code's OpenAI protocol takes `size` as `auto` or `WxH` pixels where
// both sides are multiples of 16, each side <= 3840, long:short <= 3:1 and
// 655,360 <= W*H <= 8,294,400. Snap the workbench size onto that grid keeping
// its aspect ratio (1920x1080 -> 1920x1088) so a valid request never 400s.
const RIGHT_CODE_SIZE_STEP = 16;
const RIGHT_CODE_MAX_SIDE = 3840;
const RIGHT_CODE_MAX_RATIO = 3;
const RIGHT_CODE_MIN_PIXELS = 655_360;
const RIGHT_CODE_MAX_PIXELS = 8_294_400;

export const snapRightCodeImageSize = (size: string | undefined): string => {
  const match = /^\s*(\d+)\s*[x×*]\s*(\d+)\s*$/i.exec(size || "");

  if (!match) {
    return "auto";
  }

  let width = Number(match[1]);
  let height = Number(match[2]);

  if (!width || !height) {
    return "auto";
  }

  const ratio = Math.min(
    Math.max(width / height, 1 / RIGHT_CODE_MAX_RATIO),
    RIGHT_CODE_MAX_RATIO,
  );
  const pixels = Math.min(
    Math.max(width * height, RIGHT_CODE_MIN_PIXELS),
    RIGHT_CODE_MAX_PIXELS,
  );
  width = Math.sqrt(pixels * ratio);
  height = width / ratio;

  const scale = Math.min(
    1,
    RIGHT_CODE_MAX_SIDE / width,
    RIGHT_CODE_MAX_SIDE / height,
  );
  const snap = (value: number) =>
    Math.max(
      RIGHT_CODE_SIZE_STEP,
      Math.round((value * scale) / RIGHT_CODE_SIZE_STEP) * RIGHT_CODE_SIZE_STEP,
    );
  let snappedWidth = snap(width);
  let snappedHeight = snap(height);

  // Snapping each side separately can push a 3:1 size just past 3:1.
  while (
    Math.max(snappedWidth, snappedHeight) >
    RIGHT_CODE_MAX_RATIO * Math.min(snappedWidth, snappedHeight)
  ) {
    if (snappedWidth >= snappedHeight) {
      snappedWidth -= RIGHT_CODE_SIZE_STEP;
    } else {
      snappedHeight -= RIGHT_CODE_SIZE_STEP;
    }
  }

  // Rounding can step just outside the pixel window. Grow the short side or
  // shrink the long side, which both move the ratio back toward 1:1.
  while (snappedWidth * snappedHeight < RIGHT_CODE_MIN_PIXELS) {
    if (snappedWidth >= snappedHeight) {
      snappedHeight += RIGHT_CODE_SIZE_STEP;
    } else {
      snappedWidth += RIGHT_CODE_SIZE_STEP;
    }
  }
  while (snappedWidth * snappedHeight > RIGHT_CODE_MAX_PIXELS) {
    if (snappedWidth >= snappedHeight) {
      snappedWidth -= RIGHT_CODE_SIZE_STEP;
    } else {
      snappedHeight -= RIGHT_CODE_SIZE_STEP;
    }
  }

  return `${snappedWidth}x${snappedHeight}`;
};

// Right Code's Gemini protocol sizes with `imageConfig.aspectRatio` plus an
// `imageSize` tier; `K` must be upper-case and auto / 512 are left out.
const RIGHT_CODE_IMAGE_SIZE_TIERS: Record<string, string> = {
  "1k": "1K",
  "2k": "2K",
  "4k": "4K",
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
  baseURL?: string,
): Record<string, unknown> => {
  const { model, prompt, negativePrompt, params, sources, mask } = request;
  const isRightCode = providerFlavor === "right-code";
  // Right Code documents a closed parameter list (model, prompt, n, size,
  // quality, async, image); seed / style / negative prompt / reference
  // strength are not part of it, so they stay off like on lconai.
  const includeAdvancedParameters = providerFlavor !== "lconai" && !isRightCode;
  const body = stripUndefinedValues({
    [getMappedFieldName(fieldMapping, "model", "model")]: model,
    [getMappedFieldName(fieldMapping, "prompt", "prompt")]: prompt,
    [getMappedFieldName(fieldMapping, "negativePrompt", "negative_prompt")]:
      includeAdvancedParameters && negativePrompt ? negativePrompt : undefined,
    [getMappedFieldName(fieldMapping, "n", "n")]: params.n,
    [getMappedFieldName(fieldMapping, "size", "size")]: isRightCode
      ? snapRightCodeImageSize(params.size)
      : params.size,
    // Async endpoints submit the task and return a task id; the adapter polls
    // taskPollURL for the result. Right Code requires this flag on every call.
    async: isRightCode ? true : undefined,
    response_format: shouldOmitResponseFormat(model, providerFlavor, baseURL)
      ? undefined
      : "b64_json",
    seed: includeAdvancedParameters ? params.seed ?? undefined : undefined,
    quality:
      includeAdvancedParameters || isRightCode
        ? params.quality || undefined
        : undefined,
    style: includeAdvancedParameters ? params.style || undefined : undefined,
    reference_strength:
      includeAdvancedParameters && params.referenceStrength != null
        ? params.referenceStrength
        : undefined,
  });

  assertImageModeInputs(request);

  // Right Code edits take `image` as an array of full data URLs (or public
  // URLs). Its mask is accepted but ignored, so none is sent.
  if (isRightCode) {
    if (sources?.length) {
      body[getMappedFieldName(fieldMapping, "image", "image")] = sources.map(
        (source) => source.dataURL,
      );
    }

    return body;
  }

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
  providerFlavor: AIImageProviderFlavor = "gemini-native",
): Record<string, unknown> => {
  const { prompt, params, sources, mask } = request;
  const parts: Array<Record<string, unknown>> = [{ text: prompt }];

  assertImageModeInputs(request);

  // Right Code: `async: true`, sizing under generationConfig.imageConfig, no
  // mask (not supported). The result comes back as a URL in parts[].text.
  if (providerFlavor === "right-code-gemini") {
    for (const source of sources || []) {
      parts.push({
        inline_data: {
          mime_type: source.file.type || getMimeTypeFromDataURL(source.dataURL),
          data: dataURLToBase64Payload(source.dataURL),
        },
      });
    }

    const aspectRatio = params.aspectRatio?.trim();
    const imageSize =
      RIGHT_CODE_IMAGE_SIZE_TIERS[
        params.resolution?.trim().toLowerCase() || ""
      ];
    const imageConfig = stripUndefinedValues({
      aspectRatio:
        aspectRatio && aspectRatio !== "auto" ? aspectRatio : undefined,
      imageSize,
    });

    return stripUndefinedValues({
      async: true,
      contents: [{ role: "user", parts }],
      generationConfig: Object.keys(imageConfig).length
        ? { imageConfig }
        : undefined,
    });
  }

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
  baseURL?: string,
): Record<string, unknown> => {
  return buildJSONRequestBody(request, undefined, providerFlavor, baseURL);
};

export const buildFormDataRequestBody = (
  request: AIImageGenerationRequest,
  fieldMapping?: AIImageFieldMapping,
  providerFlavor: AIImageProviderFlavor = "openai-compatible",
  baseURL?: string,
) => {
  const { model, prompt, negativePrompt, params, sources, mask } = request;
  const isRightCode = providerFlavor === "right-code";
  const includeAdvancedParameters = providerFlavor !== "lconai" && !isRightCode;

  assertImageModeInputs(request);

  const formData = new FormData();
  formData.append(getMappedFieldName(fieldMapping, "model", "model"), model);
  formData.append(getMappedFieldName(fieldMapping, "prompt", "prompt"), prompt);
  formData.append(getMappedFieldName(fieldMapping, "n", "n"), String(params.n));
  formData.append(
    getMappedFieldName(fieldMapping, "size", "size"),
    isRightCode ? snapRightCodeImageSize(params.size) : params.size,
  );
  if (isRightCode) {
    formData.append("async", "true");
    if (params.quality) {
      formData.append("quality", params.quality);
    }
  }
  if (!shouldOmitResponseFormat(model, providerFlavor, baseURL)) {
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
  baseURL?: string,
) => {
  return buildFormDataRequestBody(request, undefined, providerFlavor, baseURL);
};

// Async task polling (Right Code). The submit response carries a task id; poll
// the task query endpoint on a fixed cadence until the status resolves. Cadence
// and lifetime are bounded by the caller's AbortSignal (the workbench arms it
// with the model's requestTimeoutSeconds), so no separate timeout is needed.
// Right Code recommends polling every 3–5 s.
const ASYNC_TASK_POLL_INTERVAL_MS = 3000;

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

// Right Code statuses: queued / in_progress / processing keep polling; failed /
// expired / canceled are terminal failures (completion drops `status`, see
// hasAsyncTaskResult). Unknown values keep polling so a new status spelling
// does not abort a task that is still making progress.
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
    value === "cancelled" ||
    value === "expired"
  ) {
    return "failed";
  }

  return "pending";
};

// Right Code drops `status` once a task completes and returns the protocol's
// own result shape instead: OpenAI `data[]` or Gemini `candidates[]`.
const hasAsyncTaskResult = (response: OpenAIImageResponse) => {
  return (
    (Array.isArray(response.data) && response.data.length > 0) ||
    (Array.isArray(response.candidates) && response.candidates.length > 0)
  );
};

// Resolve the task query URL. An absolute template is used verbatim; a
// "/"-prefixed one (the Right Code presets ship `/v1/tasks/{task_id}`)
// resolves against the provider base URL's origin. `{task_id}` is substituted last.
export const buildTaskPollURL = (
  taskPollURL: string | undefined,
  baseURL: string,
  taskId: string,
): string => {
  return resolveTaskPollURLTemplate(taskPollURL, baseURL).replaceAll(
    "{task_id}",
    encodeURIComponent(taskId),
  );
};

// The absolute task query URL with `{task_id}` left in place.
const resolveTaskPollURLTemplate = (
  taskPollURL: string | undefined,
  baseURL: string,
): string => {
  const template = (taskPollURL || "").trim();

  if (!template) {
    throw new AIImageGenerationError(
      "Async image endpoint returned a task id but no task poll URL is configured.",
      "invalid-response",
    );
  }

  if (/^https?:\/\//i.test(template)) {
    return template;
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

  return `${origin}${path}`;
};

// The URLs a local (non-managed) image request actually hits, for the
// generation log. Resolves the model's endpoint preset the same way
// fetchImageGenerationResponse does, so the log never drifts from the request.
export const describeImageRequestEndpoints = (
  baseURL: string,
  modelConfig: Pick<AIImageModel, "endpoints" | "model"> | undefined,
  mode: AIImageGenerationRequest["mode"],
): { endpoint?: string; pollEndpoint?: string } => {
  if (!baseURL.trim()) {
    return {};
  }

  const endpointConfig = getEndpointConfigForMode(modelConfig, mode);
  const endpoint = buildEndpointURL(
    baseURL,
    endpointConfig,
    modelConfig?.model,
  );

  if (!endpointConfig.async) {
    return { endpoint };
  }

  try {
    return {
      endpoint,
      pollEndpoint: resolveTaskPollURLTemplate(
        modelConfig?.endpoints.taskPollURL,
        baseURL,
      ),
    };
  } catch {
    return { endpoint };
  }
};

const pollAsyncImageTask = async ({
  submitJSON,
  baseURL,
  apiKey,
  taskPollURL,
  signal,
  managedRoute,
  transportConfig,
}: {
  submitJSON: OpenAIImageResponse;
  baseURL: string;
  apiKey: string;
  taskPollURL: string | undefined;
  signal: AbortSignal | undefined;
  managedRoute?: AiGatewayCatalogEntry;
  transportConfig?: ReturnType<typeof loadAIProxyConfig>;
}): Promise<OpenAIImageResponse> => {
  const taskId = readAsyncTaskId(submitJSON);

  if (!taskId) {
    throw new AIImageGenerationError(
      "Async image submission failed: provider did not return a task id.",
      "invalid-response",
      { providerResponse: submitJSON },
    );
  }

  // Managed routes keep the provider poll path and credentials on the server;
  // the browser only sends the opaque task id as a declared gateway query
  // parameter. BYOK/direct routes retain the legacy provider URL template.
  const pollURL = managedRoute
    ? MANAGED_GATEWAY_TARGET
    : buildTaskPollURL(taskPollURL, baseURL, taskId);
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
    const elapsed = createAIRequestTimer();
    const getDiagnostics = (): AIRequestDiagnostics => ({
      stage: "poll",
      method: "GET",
      endpoint: managedRoute ? `managed:${managedRoute.id}` : pollURL,
      transport: transportConfig?.mode || loadAIProxyConfig().mode,
      elapsedMs: elapsed(),
      request: { taskId },
    });

    try {
      response = await fetchAIRequest(
        pollURL,
        { method: "GET", headers, signal },
        {
          kind: "image-generation",
          signal,
          managedOperation: "poll",
          managedParams: { taskId },
          ...(managedRoute ? { managedRoute } : {}),
          ...(transportConfig ? { config: transportConfig } : {}),
        },
      );
    } catch (error: any) {
      if (error?.name === "AbortError") {
        throw error;
      }

      if (error instanceof AIProxyTransportError) {
        throw new AIImageGenerationError(error.message, error.code, {
          ...(error.details as object | undefined),
          ...getDiagnostics(),
        });
      }

      throw new AIImageGenerationError(
        "AI image status request failed. Check that the provider allows CORS for the task query endpoint.",
        "cors-or-network",
        describeNetworkFailure(error, getDiagnostics()),
      );
    }

    const { json: pollJSON, context: pollContext } = await parseResponseJSON(
      response,
      getDiagnostics(),
    );

    if (!response.ok) {
      throw normalizeProviderError(response.status, pollJSON, pollContext);
    }

    const rawStatus = readTrimmedString(pollJSON.status);
    const status = rawStatus
      ? normalizeAsyncStatus(rawStatus)
      : pollJSON.error
      ? "failed"
      : hasAsyncTaskResult(pollJSON)
      ? "completed"
      : "pending";

    if (status === "failed") {
      throw new AIImageGenerationError(
        readProviderErrorMessage(pollJSON) ||
          "AI image generation task failed.",
        "request-failed",
        { providerResponse: pollJSON, ...pollContext },
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
  const transportConfig = loadAIProxyConfig();
  const managed = transportConfig.mode === "managed-gateway";
  const managedRoute = managed
    ? await getManagedRouteForCapability("image-generation", {
        config: transportConfig,
      })
    : undefined;
  const providerConfig = getProviderConfigForRequest(
    request,
    managed,
    managedRoute,
  );

  if (!managed && !providerConfig.baseURL) {
    throw new AIImageGenerationError(
      "AI image provider base URL is not configured.",
      "request-failed",
    );
  }
  if (!managed && !request.model) {
    throw new AIImageGenerationError(
      "AI image model is not configured.",
      "request-failed",
    );
  }

  const responseInfo = await fetchImageGenerationResponse(
    request,
    transportConfig,
    managedRoute,
  );
  const {
    response,
    managedRoute: responseManagedRoute,
    endpointConfig,
    diagnostics,
  } = responseInfo;
  const { json: submitJSON, context: submitContext } = await parseResponseJSON(
    response,
    diagnostics,
  );

  if (!response.ok || submitJSON.error) {
    throw normalizeProviderError(response.status, submitJSON, submitContext);
  }

  // Right Code reports submit-stage failures (bad params, balance, upstream
  // refusal) as HTTP 200 with `status: "failed"` and a string `error`.
  if (
    endpointConfig.async &&
    normalizeAsyncStatus(readTrimmedString(submitJSON.status)) === "failed"
  ) {
    throw new AIImageGenerationError(
      readProviderErrorMessage(submitJSON) ||
        "AI image generation task failed.",
      "request-failed",
      { providerResponse: submitJSON, ...submitContext },
    );
  }

  // Async (Right Code) endpoints return a task id rather than the image itself;
  // poll the task query until it completes, then extract from the final body.
  // Synchronous endpoints, or an async submit that already carries the result,
  // keep the submit response as the result body.
  const responseJSON =
    endpointConfig.async && !hasAsyncTaskResult(submitJSON)
      ? await pollAsyncImageTask({
          submitJSON,
          baseURL: providerConfig.baseURL,
          apiKey: providerConfig.apiKey,
          taskPollURL: providerConfig.modelConfig?.endpoints.taskPollURL,
          signal: request.signal,
          ...(responseManagedRoute
            ? { managedRoute: responseManagedRoute }
            : {}),
          ...(managed ? { transportConfig } : {}),
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
    // Right Code's Gemini protocol returns the image URL as a text part. Only
    // a bare URL counts, so ordinary Gemini prose parts are never mistaken.
    normalizeImageString(
      readImageURLText(value.text),
      revisedPrompt,
      mimeType,
    ) ||
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

const readImageURLText = (value: unknown) => {
  const text = readString(value).trim();

  return /^(?:https?:\/\/|data:image\/)\S+$/i.test(text) ? text : "";
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
  managedWireProtocol?: string,
): AIImageProviderFlavor => {
  const wireProtocol = (managedWireProtocol || "").toLowerCase();
  if (
    wireProtocol.includes("right-code") ||
    wireProtocol.includes("right_code")
  ) {
    return "right-code";
  }
  if (wireProtocol.includes("lconai")) {
    return "lconai";
  }
  if (wireProtocol.includes("gemini")) {
    return "gemini-native";
  }
  const isGeminiEndpoint =
    endpointConfig.format === "gemini" ||
    /:generateContent\b/i.test(endpointConfig.path);

  // Right Code's async generateContent: Gemini-shaped body plus `async: true`
  // and `imageConfig`, Bearer auth, and the same task polling as its OpenAI side.
  if (isGeminiEndpoint && endpointConfig.async) {
    return "right-code-gemini";
  }
  if (isGeminiEndpoint) {
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

const getManagedImageEndpointConfig = (
  route: AiGatewayCatalogEntry,
  mode: AIImageGenerationRequest["mode"],
): AIImageEndpointConfig => {
  const wireProtocol = route.wireProtocol.toLowerCase();
  const isGemini = wireProtocol.includes("gemini");
  const isForm =
    wireProtocol.includes("multipart") ||
    wireProtocol.includes("form-data") ||
    wireProtocol.includes("form");
  const operation = getManagedImageOperation(route, mode);
  if (!operation) {
    throw new AIImageGenerationError(
      "The managed image route does not allow this operation.",
      "unsupported",
      { routeId: route.id, mode },
    );
  }
  // Managed multipart requests are intentionally kept opaque by the gateway.
  // Without a reviewed multipart model-field contract, accepting an edit
  // route here would let a browser override the catalog model.
  if (isForm && mode !== "text-to-image") {
    throw new AIImageGenerationError(
      "Managed image edit routes must use a JSON wire protocol.",
      "unsupported",
      { routeId: route.id, wireProtocol: route.wireProtocol },
    );
  }
  const asyncRoute =
    route.operations.includes("poll") &&
    (operation === "generate" || operation === "submit");
  return {
    path: isGemini
      ? "/models/{model}:generateContent"
      : mode === "text-to-image" || !isForm
      ? "/images/generations"
      : "/images/edits",
    format: isGemini ? "gemini" : isForm ? "form" : "json",
    ...(asyncRoute ? { async: true } : {}),
  };
};

const getManagedImageOperation = (
  route: AiGatewayCatalogEntry,
  mode: AIImageGenerationRequest["mode"],
) => {
  const operation =
    mode === "text-to-image"
      ? route.operations.includes("generate")
        ? "generate"
        : route.operations.includes("submit")
        ? "submit"
        : undefined
      : route.operations.includes("edit")
      ? "edit"
      : route.operations.includes("generate")
      ? "generate"
      : route.operations.includes("submit")
      ? "submit"
      : undefined;
  if (!operation) {
    throw new AIImageGenerationError(
      "The managed image route does not allow this operation.",
      "unsupported",
      { routeId: route.id, mode },
    );
  }
  return operation;
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
  transportConfig = loadAIProxyConfig(),
  resolvedManagedRoute?: AiGatewayCatalogEntry,
) => {
  const managed = transportConfig.mode === "managed-gateway";
  const managedRoute = managed
    ? resolvedManagedRoute ||
      (await getManagedRouteForCapability("image-generation", {
        config: transportConfig,
      }))
    : undefined;
  const providerConfig = getProviderConfigForRequest(
    request,
    managed,
    managedRoute,
  );
  const endpointConfig = managedRoute
    ? getManagedImageEndpointConfig(managedRoute, request.mode)
    : getEndpointConfigForMode(providerConfig.modelConfig, request.mode);
  const endpoint = buildEndpointURL(
    providerConfig.baseURL,
    endpointConfig,
    providerConfig.modelName,
  );
  const providerFlavor = getAIImageProviderFlavor(
    providerConfig.baseURL,
    endpointConfig,
    managedRoute?.wireProtocol,
  );
  const managedOperation = managedRoute
    ? getManagedImageOperation(managedRoute, request.mode)
    : undefined;
  const headers = new Headers({ Accept: "application/json" });
  const authorizationHeader = getAuthorizationHeaderValue(
    providerConfig.apiKey,
    providerFlavor,
  );

  if (
    !managed &&
    providerFlavor === "gemini-native" &&
    providerConfig.apiKey.trim()
  ) {
    headers.set("x-goog-api-key", getRawAPIKey(providerConfig.apiKey));
  } else if (!managed && authorizationHeader) {
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
              ? buildGeminiNativeRequestBody(providerRequest, providerFlavor)
              : buildJSONRequestBody(
                  providerRequest,
                  providerConfig.fieldMapping,
                  providerFlavor,
                  providerConfig.baseURL,
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
            providerConfig.baseURL,
          ),
          signal: request.signal,
        };

  const elapsed = createAIRequestTimer();
  const getDiagnostics = (): AIRequestDiagnostics => ({
    stage: "submit",
    method: "POST",
    endpoint: managedRoute ? `managed:${managedRoute.id}` : endpoint,
    transport: transportConfig.mode,
    elapsedMs: elapsed(),
    request: {
      mode: request.mode,
      model: providerConfig.modelName,
      providerFlavor,
      body: summarizeRequestBody(init.body),
    },
  });

  try {
    const response = await fetchAIRequest(endpoint, init, {
      kind: "image-generation",
      signal: request.signal,
      managedOperation:
        managedOperation ||
        (init.body instanceof FormData ? "edit" : "generate"),
      auditPrompt: request.prompt,
      ...(managedRoute ? { managedRoute } : {}),
      ...(managed ? { config: transportConfig } : {}),
    });
    return {
      response,
      managedRoute,
      endpointConfig,
      diagnostics: getDiagnostics(),
    };
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw error;
    }

    if (error instanceof AIProxyTransportError) {
      throw new AIImageGenerationError(error.message, error.code, {
        ...(error.details as object | undefined),
        ...getDiagnostics(),
      });
    }

    throw new AIImageGenerationError(
      "AI image request failed before reaching the provider. Check that the model Base URL is reachable from this browser, uses HTTPS, and allows CORS for image requests.",
      "cors-or-network",
      describeNetworkFailure(error, getDiagnostics()),
    );
  }
};

const getProviderConfigForRequest = (
  request: AIImageGenerationRequest,
  managed = false,
  managedRoute?: AiGatewayCatalogEntry,
) => {
  const modelConfig = request.config.models.find(
    (model) => model.id === request.model || model.model === request.model,
  );

  return {
    baseURL: managed
      ? MANAGED_GATEWAY_TARGET
      : request.config.baseURL || modelConfig?.baseURL || "",
    apiKey: managed ? "" : request.config.apiKey || modelConfig?.apiKey || "",
    fieldMapping: modelConfig?.fieldMapping,
    modelConfig,
    modelName: managedRoute?.model || modelConfig?.model || request.model,
  };
};

const parseResponseJSON = async (
  response: Response,
  diagnostics: AIRequestDiagnostics,
) => {
  const { json, rawBody } = await readProviderResponseBody(response);
  const context: ProviderErrorContext = {
    ...diagnostics,
    statusText: response.statusText || undefined,
    headers: readDiagnosticResponseHeaders(response),
    rawBody,
  };

  if (rawBody !== undefined && response.ok) {
    throw new AIImageGenerationError(
      "Generation failed: provider returned a non-JSON response.",
      "invalid-response",
      { status: response.status, ...context },
    );
  }

  return { json: json as OpenAIImageResponse, context };
};

export const readProviderErrorMessage = (
  responseJSON: Pick<OpenAIImageResponse, "error">,
) => {
  const { error } = responseJSON;
  const message = typeof error === "string" ? error : error?.message;

  return typeof message === "string" ? message.trim() : "";
};

// Debug context merged into the error details for the generation log.
export type ProviderErrorContext = Partial<AIRequestDiagnostics> & {
  statusText?: string;
  headers?: Record<string, string>;
  rawBody?: string;
};

// Non-OpenAI error bodies such as `{ "message": ... }` or FastAPI's
// `{ "detail": ... }`; only consulted when `error` carries no message.
const readTopLevelErrorMessage = (responseJSON: Record<string, unknown>) => {
  for (const key of ["message", "detail", "msg"]) {
    const value = responseJSON[key];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
};

export const normalizeProviderError = (
  status: number,
  responseJSON: Pick<OpenAIImageResponse, "error">,
  context?: ProviderErrorContext,
) => {
  const body = responseJSON as Record<string, unknown>;
  const message =
    readProviderErrorMessage(responseJSON) ||
    readTopLevelErrorMessage(body) ||
    `AI image provider returned HTTP ${status}.`;
  const details = {
    status,
    providerError: responseJSON.error,
    // Keep the whole body when it has no `error` field to read from.
    providerResponse:
      responseJSON.error === undefined && Object.keys(body).length
        ? body
        : undefined,
    ...context,
  };

  if (status === 401 || status === 403) {
    return new AIImageGenerationError(
      "AI image request was rejected by the provider. Check the configured API key and model permissions.",
      "auth",
      details,
    );
  }

  if (status === 400 || status === 404 || status === 422) {
    return new AIImageGenerationError(message, "unsupported", details);
  }

  return new AIImageGenerationError(message, "request-failed", details);
};

export const fetchRemoteImageAsDataURL = async (
  url: string,
  signal: AbortSignal | undefined,
  timeoutMs: number = DEFAULT_REMOTE_IMAGE_DOWNLOAD_TIMEOUT_MS,
) => {
  const downloadController = new AbortController();
  let didTimeout = false;
  const abortDownload = () => downloadController.abort(signal?.reason);
  const timeoutId = window.setTimeout(() => {
    didTimeout = true;
    downloadController.abort();
  }, timeoutMs);

  if (signal?.aborted) {
    abortDownload();
  } else {
    signal?.addEventListener("abort", abortDownload, { once: true });
  }

  try {
    const imageResponse = await fetchAIRequest(
      url,
      { signal: downloadController.signal },
      {
        kind: "remote-image",
        signal: downloadController.signal,
        managedOperation: "download",
        managedParams: {
          assetId: new URL(url).pathname.split("/").filter(Boolean).pop() || "",
        },
      },
    );

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
  } catch (error: any) {
    if (didTimeout) {
      throw new AIImageGenerationError(
        "Provider returned an image URL, but downloading it timed out. Referencing the URL directly instead.",
        "cors-or-network",
        { remoteURL: url, timeoutMs },
      );
    }

    if (signal?.aborted || error?.name === "AbortError") {
      throw error;
    }

    if (error instanceof AIProxyTransportError) {
      throw new AIImageGenerationError(
        error.message,
        error.code,
        error.details,
      );
    }

    if (error instanceof AIImageGenerationError) {
      throw error;
    }

    throw new AIImageGenerationError(
      "Provider returned an image URL, but the browser could not download it. This is usually a CORS or network issue.",
      "cors-or-network",
      { remoteURL: url, errorMessage: error?.message },
    );
  } finally {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortDownload);
  }
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
