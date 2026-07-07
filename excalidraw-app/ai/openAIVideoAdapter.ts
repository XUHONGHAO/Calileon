import type { DataURL } from "@excalidraw/excalidraw/types";

import {
  AIImageGenerationError,
  fetchRemoteImageAsDataURL,
  getAuthorizationHeaderValue,
  normalizeProviderError,
} from "./openAIImageAdapter";

import type {
  AIVideoGenerationOutput,
  AIVideoGenerationRequest,
  AIVideoPollResult,
  AIVideoTaskStatus,
} from "./types";

/**
 * Video adapter for the "OpenAI-compatible" video paradigm shared by the
 * duoyuanx.com gateway across Grok / Veo / Omni / Kling / 即梦 / Vidu:
 *
 *   POST {baseURL}/videos            -> submit an async task, returns a task id
 *   GET  {baseURL}/videos/{task_id}  -> poll status until completed / failed
 *
 * Unlike the image adapter (a single synchronous POST that returns the pixels),
 * video generation is asynchronous. This module only owns the two HTTP calls and
 * their response parsing; polling cadence + persistence live in videoTaskStore /
 * the workbench. Auth, error normalization and the CORS hint are reused from the
 * image adapter so both share one behavior.
 */

type OpenAIVideoResponse = {
  id?: unknown;
  task_id?: unknown;
  taskId?: unknown;
  status?: unknown;
  state?: unknown;
  progress?: unknown;
  video_url?: unknown;
  videoUrl?: unknown;
  url?: unknown;
  thumbnail_url?: unknown;
  thumbnailUrl?: unknown;
  duration?: unknown;
  seconds?: unknown;
  revised_prompt?: unknown;
  revisedPrompt?: unknown;
  output?: unknown;
  data?: unknown;
  detail?: unknown;
  metadata?: unknown;
  error?: {
    message?: string;
    type?: string;
    code?: string | number;
  };
};

const trimTrailingSlashes = (value: string) => value.replace(/\/+$/, "");
const VIDEO_SUBMIT_ENDPOINT = "/videos";
const VIDEO_ENDPOINT_SUFFIX = /\/videos(?:\/[^/]+)?$/i;

export const buildVideoSubmitEndpoint = (baseURL: string): string => {
  const normalizedBaseURL = trimTrailingSlashes(baseURL.trim()).replace(
    VIDEO_ENDPOINT_SUFFIX,
    "",
  );

  return `${normalizedBaseURL}${VIDEO_SUBMIT_ENDPOINT}`;
};

export const buildVideoPollEndpoint = (
  baseURL: string,
  taskId: string,
): string => {
  return `${buildVideoSubmitEndpoint(baseURL)}/${encodeURIComponent(taskId)}`;
};

const getProviderConfigForRequest = (request: AIVideoGenerationRequest) => {
  const modelConfig = request.config.models.find(
    (model) => model.id === request.model || model.model === request.model,
  );

  return {
    baseURL: request.config.baseURL || modelConfig?.baseURL || "",
    apiKey: request.config.apiKey || modelConfig?.apiKey || "",
    modelName: modelConfig?.model || request.model,
  };
};

/**
 * OpenAI-format video body. Text-to-video sends prompt + sizing; image-to-video
 * additionally attaches the first-frame reference as `image` (data URI, matching
 * the Grok imagine / AIGC JSON convention documented in videos.md §4.1.2 / §4.5).
 */
export const buildVideoRequestBody = (
  request: AIVideoGenerationRequest,
  modelName?: string,
): Record<string, unknown> => {
  const { model, prompt, params, mode, sources } = request;
  const body: Record<string, unknown> = {
    model: modelName || model,
    prompt,
  };

  if (params.duration != null) {
    // OpenAI-format video uses `seconds`; gateways coerce it per family.
    body.seconds = String(params.duration);
  }
  if (params.size) {
    body.size = params.size;
  }
  if (params.aspectRatio && params.aspectRatio !== "auto") {
    body.aspect_ratio = params.aspectRatio;
  }
  if (params.resolution && params.resolution !== "auto") {
    body.resolution = params.resolution;
  }

  if (mode === "image-to-video") {
    if (!sources?.length) {
      throw new AIImageGenerationError(
        "Image-to-video mode requires a first-frame reference image.",
        "unsupported",
      );
    }

    const imagePayloads = sources.map((source) => source.dataURL);

    body.image =
      imagePayloads.length === 1 ? imagePayloads[0] : imagePayloads[0];

    if (imagePayloads.length > 1) {
      body.images = imagePayloads;
    }
  }

  return body;
};

const readString = (value: unknown): string => {
  return typeof value === "string" ? value.trim() : "";
};

const readTaskId = (response: OpenAIVideoResponse): string => {
  return (
    readString(response.id) ||
    readString(response.task_id) ||
    readString(response.taskId)
  );
};

/**
 * Map the many upstream status spellings onto our four-state machine.
 * Grok/Veo use `queued`/`processing`; Omni uses `in_progress`; some gateways
 * emit `pending`/`succeeded`/`success`/`failure`.
 */
export const normalizeVideoStatus = (raw: string): AIVideoTaskStatus => {
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
  if (value === "queued" || value === "pending" || value === "submitted") {
    return "queued";
  }

  // processing / in_progress / running / anything unknown -> keep polling
  return "processing";
};

const readProgress = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace("%", ""));

    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return !!value && typeof value === "object";
};

/**
 * Resolve the result address with the fallback order documented in videos.md:
 * `video_url` -> `output.url` -> `url` -> `data[].url` (plus `metadata.url`
 * used by Kling). Never returns the polling endpoint itself.
 */
const extractVideoURL = (response: OpenAIVideoResponse): string => {
  const direct =
    readString(response.video_url) ||
    readString(response.videoUrl) ||
    (isRecord(response.output) &&
      (readString(response.output.url) ||
        readString((response.output as OpenAIVideoResponse).video_url))) ||
    readString(response.url) ||
    (isRecord(response.metadata) && readString(response.metadata.url)) ||
    (isRecord(response.detail) && readString(response.detail.url));

  if (direct) {
    return direct;
  }

  const dataValue = response.data;

  if (Array.isArray(dataValue)) {
    for (const item of dataValue) {
      if (isRecord(item)) {
        const url =
          readString(item.video_url) ||
          readString(item.url) ||
          readString(item.videoUrl);

        if (url) {
          return url;
        }
      }
    }
  } else if (isRecord(dataValue)) {
    const url =
      readString(dataValue.video_url) ||
      readString(dataValue.url) ||
      readString(dataValue.videoUrl);

    if (url) {
      return url;
    }
  }

  return "";
};

const extractThumbnailURL = (response: OpenAIVideoResponse): string => {
  return (
    readString(response.thumbnail_url) || readString(response.thumbnailUrl)
  );
};

const parseResponseJSON = async (
  response: Response,
): Promise<OpenAIVideoResponse> => {
  try {
    return (await response.json()) as OpenAIVideoResponse;
  } catch (error: any) {
    if (response.ok) {
      throw new AIImageGenerationError(
        "Video request failed: provider returned a non-JSON response.",
        "invalid-response",
        { status: response.status },
      );
    }

    return {};
  }
};

const buildAuthHeaders = (apiKey: string, contentType?: string) => {
  const headers = new Headers({ Accept: "application/json" });
  const authorizationHeader = getAuthorizationHeaderValue(
    apiKey,
    "openai-compatible",
  );

  if (authorizationHeader) {
    headers.set("Authorization", authorizationHeader);
  }
  if (contentType) {
    headers.set("Content-Type", contentType);
  }

  return headers;
};

/**
 * Submit a video generation task. Returns the task id (accepting both `id` and
 * `task_id`) plus the resolved endpoint / model for persistence.
 */
export const submitVideoTask = async (
  request: AIVideoGenerationRequest,
): Promise<{ taskId: string; endpoint: string; model: string }> => {
  const providerConfig = getProviderConfigForRequest(request);

  if (!providerConfig.baseURL) {
    throw new AIImageGenerationError(
      "AI video provider base URL is not configured.",
      "request-failed",
    );
  }
  if (!request.model) {
    throw new AIImageGenerationError(
      "AI video model is not configured.",
      "request-failed",
    );
  }

  const endpoint = buildVideoSubmitEndpoint(providerConfig.baseURL);
  const body = buildVideoRequestBody(request, providerConfig.modelName);

  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: buildAuthHeaders(providerConfig.apiKey, "application/json"),
      body: JSON.stringify(body),
      signal: request.signal,
    });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw error;
    }

    throw new AIImageGenerationError(
      "AI video request failed before reaching the provider. Check that the model Base URL is reachable from this browser, uses HTTPS, and allows CORS for video requests.",
      "cors-or-network",
      { endpoint, errorMessage: error?.message },
    );
  }

  const responseJSON = await parseResponseJSON(response);

  if (!response.ok || responseJSON.error) {
    throw normalizeProviderError(response.status, responseJSON);
  }

  const taskId = readTaskId(responseJSON);

  if (!taskId) {
    throw new AIImageGenerationError(
      "Video submission failed: provider did not return a task id.",
      "invalid-response",
      { providerResponse: responseJSON },
    );
  }

  return {
    taskId,
    endpoint,
    model: providerConfig.modelName,
  };
};

/**
 * Poll a submitted task once. Returns the normalized status plus, when
 * completed, the result URL / thumbnail / duration.
 */
export const pollVideoTask = async ({
  baseURL,
  apiKey,
  taskId,
  signal,
}: {
  baseURL: string;
  apiKey: string;
  taskId: string;
  signal?: AbortSignal;
}): Promise<AIVideoPollResult> => {
  if (!baseURL) {
    throw new AIImageGenerationError(
      "AI video provider base URL is not configured.",
      "request-failed",
    );
  }

  const endpoint = buildVideoPollEndpoint(baseURL, taskId);

  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers: buildAuthHeaders(apiKey),
      signal,
    });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw error;
    }

    throw new AIImageGenerationError(
      "AI video status request failed. Check that the provider allows CORS for the video polling endpoint.",
      "cors-or-network",
      { endpoint, errorMessage: error?.message },
    );
  }

  const responseJSON = await parseResponseJSON(response);

  // Only HTTP-level failures throw here. A 200 body carrying `status: "failed"`
  // plus an `error` object is a *task* failure, handled by the status machine
  // below so the caller can surface the reason without a thrown error.
  if (!response.ok) {
    throw normalizeProviderError(response.status, responseJSON);
  }

  const rawStatus =
    readString(responseJSON.status) || readString(responseJSON.state);
  // An error field on a 200 body (with no/unknown status) is still a task
  // failure; treat it as failed rather than polling forever on "processing".
  const status =
    !rawStatus && responseJSON.error
      ? "failed"
      : normalizeVideoStatus(rawStatus);
  const progress = readProgress(responseJSON.progress);

  if (status === "failed") {
    return {
      status,
      progress,
      error:
        responseJSON.error?.message ||
        readString(
          isRecord(responseJSON.data)
            ? responseJSON.data.fail_reason
            : undefined,
        ) ||
        "Video generation failed.",
    };
  }

  if (status !== "completed") {
    return { status, progress };
  }

  const videoURL = extractVideoURL(responseJSON);

  if (!videoURL) {
    throw new AIImageGenerationError(
      "Video task completed but the provider returned no video URL.",
      "invalid-response",
      { providerResponse: responseJSON },
    );
  }

  const durationRaw =
    readProgress(responseJSON.duration) ?? readProgress(responseJSON.seconds);

  return {
    status,
    progress,
    videoURL,
    thumbnailURL: extractThumbnailURL(responseJSON) || undefined,
    durationSeconds: durationRaw,
    revisedPrompt:
      readString(responseJSON.revised_prompt) ||
      readString(responseJSON.revisedPrompt) ||
      undefined,
  };
};

/**
 * Best-effort fetch of the provider-supplied thumbnail as a data URL. Reuses the
 * image adapter's CORS-aware downloader. Returns null on any failure so the
 * caller can fall back to first-frame extraction or a placeholder cover.
 */
export const fetchVideoThumbnailAsDataURL = async (
  thumbnailURL: string,
  signal?: AbortSignal,
): Promise<{ dataURL: DataURL; mimeType: string } | null> => {
  try {
    return await fetchRemoteImageAsDataURL(thumbnailURL, signal);
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw error;
    }

    return null;
  }
};

export const buildVideoOutput = (
  poll: AIVideoPollResult,
): AIVideoGenerationOutput => {
  if (poll.status !== "completed" || !poll.videoURL) {
    throw new AIImageGenerationError(
      "Cannot build video output from an incomplete task.",
      "invalid-response",
    );
  }

  return {
    videoURL: poll.videoURL,
    mimeType: "video/mp4",
    durationSeconds: poll.durationSeconds,
    revisedPrompt: poll.revisedPrompt,
  };
};
