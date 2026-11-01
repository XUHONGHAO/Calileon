import {
  AIImageGenerationError,
  getAuthorizationHeaderValue,
  normalizeProviderError,
} from "./openAIImageAdapter";
import { PROMPT_REFERENCE_PATTERN } from "./promptReferencePattern";
import { loadAIProxyConfig } from "./proxyConfig";
import { AIProxyTransportError, fetchAIRequest } from "./requestTransport";
import { getAIVideoModelSpec } from "./videoModelCatalog";

import type {
  AIImageGenerationParams,
  AIVideoGenerationMode,
  AIVideoPollResult,
  AIVideoReference,
  AIVideoTaskStatus,
} from "./types";
import type { AIVideoModelSpec } from "./videoModelCatalog";
import type { AIProxyConfigV2 } from "./proxyConfig";

/**
 * Adapter for the two RollDek Seedance protocols (ADR 0039):
 *
 *   rolldek-sd   POST /v1/videos                          GET /v1/videos/{id}
 *   volc-tasks   POST /api/v3/contents/generations/tasks  GET .../tasks/{id}
 *
 * Both download the result from `GET /v1/videos/{id}/content`, which needs the
 * API key. That URL is always built from the configured Base URL, never taken
 * from a response, so the key is only ever sent to the configured host.
 *
 * Every accepted submit may be billed, so this module never retries a submit.
 * Ambiguous submit failures carry `details.submitOutcome = "unknown"` so the
 * UI can tell the user to check the RollDek console before resubmitting.
 */

export type RollDekVideoProtocol = "rolldek-sd" | "volc-tasks";

export type RollDekVideoRequest = {
  protocol: RollDekVideoProtocol;
  baseURL: string;
  apiKey: string;
  model: string;
  mode: AIVideoGenerationMode;
  prompt: string;
  params: AIImageGenerationParams;
  /**
   * In tray order, which is what `#n` in the prompt counts. In
   * `first-last-frame` mode: exactly two images, first frame then last frame.
   */
  references?: AIVideoReference[];
  signal?: AbortSignal;
  config?: AIProxyConfigV2;
};

/** RollDek asks for 15 s between polls (both protocols). */
export const ROLLDEK_VIDEO_POLL_INTERVAL_MS = 15_000;

const trimTrailingSlashes = (value: string) => value.replace(/\/+$/, "");

// Users may paste the Base URL with an API prefix; the adapter owns paths.
const ROLLDEK_PATH_SUFFIX = /\/(?:v1|api\/v3)$/i;

export const normalizeRollDekBaseURL = (baseURL: string) =>
  trimTrailingSlashes(baseURL.trim()).replace(ROLLDEK_PATH_SUFFIX, "");

export const buildRollDekSubmitURL = (
  protocol: RollDekVideoProtocol,
  baseURL: string,
) =>
  `${normalizeRollDekBaseURL(baseURL)}${
    protocol === "volc-tasks"
      ? "/api/v3/contents/generations/tasks"
      : "/v1/videos"
  }`;

export const buildRollDekPollURL = (
  protocol: RollDekVideoProtocol,
  baseURL: string,
  taskId: string,
) =>
  `${buildRollDekSubmitURL(protocol, baseURL)}/${encodeURIComponent(taskId)}`;

/** Both protocols download from the sd content endpoint, with the API key. */
export const buildRollDekContentURL = (baseURL: string, taskId: string) =>
  `${normalizeRollDekBaseURL(baseURL)}/v1/videos/${encodeURIComponent(
    taskId,
  )}/content`;

const unsupported = (message: string, details?: unknown) =>
  new AIImageGenerationError(message, "unsupported", details);

/** `#n` / `图 n` / `image n` → the provider's own reference wording. */
export const rewriteRollDekPromptReferences = (
  prompt: string,
  protocol: RollDekVideoProtocol,
  references: readonly AIVideoReference[],
  mode: AIVideoGenerationMode,
) => {
  const ordinals: number[] = [];
  const counts = { image: 0, video: 0, audio: 0 };

  for (const reference of references) {
    counts[reference.kind] += 1;
    ordinals.push(counts[reference.kind]);
  }

  return prompt.replace(
    PROMPT_REFERENCE_PATTERN,
    (token, hash?: string, zh?: string, en?: string) => {
      const index = Number(hash || zh || en);
      const reference = references[index - 1];

      if (!reference) {
        return token;
      }

      if (mode === "first-last-frame") {
        return protocol === "rolldek-sd"
          ? index === 1
            ? "first frame"
            : "last frame"
          : index === 1
          ? "首帧"
          : "尾帧";
      }

      const ordinal = ordinals[index - 1];

      if (protocol === "rolldek-sd") {
        const name =
          reference.kind === "image"
            ? "Image"
            : reference.kind === "video"
            ? "Video"
            : "Audio";
        return `@${name}${ordinal}`;
      }

      // The Volcengine doc gives no reference syntax; plain words plus the
      // `content[]` order is the best available signal (ADR 0039 "待实测" #4).
      const word =
        reference.kind === "image"
          ? "图片"
          : reference.kind === "video"
          ? "视频"
          : "音频";
      return `${word}${ordinal}`;
    },
  );
};

const isHTTPSURL = (value: string) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

type NormalizedRollDekRequest = {
  spec?: AIVideoModelSpec;
  mode: "text-to-video" | "reference-to-video" | "first-last-frame";
  duration: number;
  aspectRatio: string;
  resolution: string;
  references: AIVideoReference[];
  seed?: number;
};

/**
 * Checks the request against the catalog limits before anything is sent, so
 * an out-of-range request fails here instead of after a billed submit or a
 * queued-then-failed task. Models missing from the catalog get URL and mode
 * checks only.
 */
export const validateRollDekVideoRequest = (
  request: RollDekVideoRequest,
): NormalizedRollDekRequest => {
  const spec = getAIVideoModelSpec(request.model);
  const prompt = request.prompt.trim();
  // `image-to-video` is the openai-videos name for the same thing.
  const mode =
    request.mode === "image-to-video" ? "reference-to-video" : request.mode;
  const references = mode === "text-to-video" ? [] : request.references || [];

  if (!prompt) {
    throw unsupported("Video prompt is empty.");
  }
  if (spec && spec.protocol !== request.protocol) {
    throw unsupported(
      `Model ${spec.model} uses the ${spec.protocol} protocol, not ${request.protocol}.`,
    );
  }
  if (spec?.maxPromptLength && prompt.length > spec.maxPromptLength) {
    throw unsupported(
      `Prompt is too long for ${spec.model} (max ${spec.maxPromptLength} characters).`,
    );
  }

  for (const reference of references) {
    if (!isHTTPSURL(reference.url)) {
      throw unsupported(
        "Video references must be public HTTPS URLs. RollDek rejects data and blob URLs.",
      );
    }
  }

  if (mode === "reference-to-video" && !references.length) {
    throw unsupported("Reference mode needs at least one reference.");
  }
  if (mode === "first-last-frame") {
    if (spec && !spec.firstLastFrame) {
      throw unsupported(`${spec.model} does not support first/last frames.`);
    }
    if (
      references.length !== 2 ||
      references.some((reference) => reference.kind !== "image")
    ) {
      throw unsupported("First/last-frame mode needs exactly two images.");
    }
  }

  if (spec && mode === "reference-to-video") {
    const counts = { image: 0, video: 0, audio: 0 };

    for (const reference of references) {
      counts[reference.kind] += 1;
    }

    const limits = spec.references;

    if (
      counts.image > limits.images ||
      counts.video > limits.videos ||
      counts.audio > limits.audios ||
      (limits.total != null && references.length > limits.total)
    ) {
      throw unsupported(
        `${spec.model} accepts at most ${limits.images} images, ${
          limits.videos
        } videos and ${limits.audios} audios${
          limits.total != null ? ` (${limits.total} in total)` : ""
        }.`,
        { counts },
      );
    }
  }

  const requestedDuration = Math.round(
    request.params.duration ?? spec?.durationSeconds.default ?? 5,
  );

  if (
    spec &&
    (requestedDuration < spec.durationSeconds.min ||
      requestedDuration > spec.durationSeconds.max)
  ) {
    throw unsupported(
      `${spec.model} supports ${spec.durationSeconds.min}–${spec.durationSeconds.max} s.`,
    );
  }

  const requestedRatio = request.params.aspectRatio?.trim();
  const aspectRatio =
    requestedRatio && requestedRatio !== "auto" ? requestedRatio : "16:9";

  if (spec && !spec.aspectRatios.includes(aspectRatio)) {
    throw unsupported(
      `${spec.model} does not support aspect ratio ${aspectRatio}.`,
    );
  }

  const requestedResolution = request.params.resolution?.trim().toLowerCase();
  const resolution =
    requestedResolution && requestedResolution !== "auto"
      ? requestedResolution
      : spec?.resolutions[0] || "720p";

  if (spec && !spec.resolutions.includes(resolution as never)) {
    throw unsupported(
      `${spec.model} does not support resolution ${resolution}.`,
    );
  }

  const seed =
    typeof request.params.seed === "number" &&
    Number.isFinite(request.params.seed) &&
    (!spec || spec.seed)
      ? Math.round(request.params.seed)
      : undefined;

  return {
    spec,
    mode,
    duration: requestedDuration,
    aspectRatio,
    resolution,
    references,
    ...(seed != null ? { seed } : {}),
  };
};

const urlsOf = (
  references: AIVideoReference[],
  kind: AIVideoReference["kind"],
) =>
  references
    .filter((reference) => reference.kind === kind)
    .map((reference) => reference.url);

/** sd-* body: top-level fields; 933 prefers its own field names. */
export const buildRollDekSdRequestBody = (
  request: RollDekVideoRequest,
): Record<string, unknown> => {
  const normalized = validateRollDekVideoRequest(request);
  const is933 = normalized.spec?.wire === "sd-933";
  const body: Record<string, unknown> = {
    model: request.model,
    prompt: rewriteRollDekPromptReferences(
      request.prompt.trim(),
      "rolldek-sd",
      normalized.references,
      normalized.mode,
    ),
    // Always explicit: ch5 defaults to 30 s server-side.
    [is933 ? "seconds" : "duration"]: normalized.duration,
    resolution: normalized.resolution,
    aspect_ratio: normalized.aspectRatio,
  };

  if (normalized.mode === "first-last-frame") {
    const [first, last] = normalized.references;
    body[is933 ? "first_frame_image" : "first_image"] = first.url;
    body[is933 ? "last_frame_image" : "last_image"] = last.url;
  } else if (normalized.mode === "reference-to-video") {
    const fields = is933
      ? (["images", "reference_videos", "reference_audios"] as const)
      : (["image_refs", "video_refs", "audio_refs"] as const);
    const kinds = ["image", "video", "audio"] as const;

    kinds.forEach((kind, index) => {
      const urls = urlsOf(normalized.references, kind);
      if (urls.length) {
        body[fields[index]] = urls;
      }
    });
  }

  if (normalized.seed != null) {
    body.seed = normalized.seed;
  }

  return body;
};

/** Volcengine body: prompt and references go in `content[]`, in tray order. */
export const buildRollDekVolcRequestBody = (
  request: RollDekVideoRequest,
): Record<string, unknown> => {
  const normalized = validateRollDekVideoRequest(request);

  if (
    normalized.mode === "first-last-frame" &&
    normalized.spec?.firstLastFrameExcludesVideo &&
    normalized.references.some((reference) => reference.kind === "video")
  ) {
    throw unsupported("First/last frames cannot be combined with a video.");
  }

  const content: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: rewriteRollDekPromptReferences(
        request.prompt.trim(),
        "volc-tasks",
        normalized.references,
        normalized.mode,
      ),
    },
  ];

  normalized.references.forEach((reference, index) => {
    if (reference.kind === "image") {
      content.push({
        type: "image_url",
        image_url: { url: reference.url },
        role:
          normalized.mode === "first-last-frame"
            ? index === 0
              ? "first_frame"
              : "last_frame"
            : "reference_image",
      });
    } else if (reference.kind === "video") {
      content.push({
        type: "video_url",
        video_url: { url: reference.url },
        role: "reference_video",
      });
    } else {
      content.push({
        type: "audio_url",
        audio_url: { url: reference.url },
        role: "reference_audio",
      });
    }
  });

  return {
    model: request.model,
    content,
    // The doc asks for an explicit resolution.
    resolution: normalized.resolution,
    duration: normalized.duration,
    ratio: normalized.aspectRatio,
    ...(normalized.seed != null ? { seed: normalized.seed } : {}),
  };
};

/**
 * sd: queued / in_progress / completed / failed.
 * Volcengine: queued / running / succeeded / failed / expired / cancelled.
 */
export const normalizeRollDekStatus = (raw: string): AIVideoTaskStatus => {
  const value = raw.trim().toLowerCase();

  if (value === "completed" || value === "succeeded") {
    return "completed";
  }
  if (
    value === "failed" ||
    value === "expired" ||
    value === "cancelled" ||
    value === "canceled"
  ) {
    return "failed";
  }
  if (value === "queued") {
    return "queued";
  }

  return "processing";
};

type RollDekResponse = Record<string, unknown> & {
  error?: { code?: string | number; message?: string };
};

const readString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const readNumber = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const readJSON = async (response: Response): Promise<RollDekResponse> => {
  try {
    const value = await response.json();
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
};

// sd puts `code` at the top level; Volcengine/new-api nest it in `error`.
const readErrorCode = (body: RollDekResponse) =>
  readString(body.error?.code) || readString(body.code);

const buildHeaders = (apiKey: string, json: boolean) => {
  const headers = new Headers({ Accept: "application/json" });
  const authorization = getAuthorizationHeaderValue(apiKey);

  if (authorization) {
    headers.set("Authorization", authorization);
  }
  if (json) {
    headers.set("Content-Type", "application/json");
  }

  return headers;
};

export const assertRollDekTransport = (
  baseURL: string,
  config: AIProxyConfigV2,
) => {
  // The managed gateway only knows routes declared at deploy time; never fall
  // back to a direct request on the user's behalf (ADR 0027 / 0039 §10).
  if (config.mode === "managed-gateway") {
    throw new AIImageGenerationError(
      "RollDek video models are not available through the managed AI gateway. Switch the network mode to direct or BYOK proxy.",
      "proxy-config",
    );
  }
  if (!baseURL.trim()) {
    throw new AIImageGenerationError(
      "AI video provider base URL is not configured.",
      "request-failed",
    );
  }
};

export type RollDekSubmitOutcome = "rejected" | "unknown";

const SUBMIT_OUTCOME_UNKNOWN: RollDekSubmitOutcome = "unknown";
const SUBMIT_OUTCOME_REJECTED: RollDekSubmitOutcome = "rejected";

/**
 * Submits once. Errors carry `details.submitOutcome`:
 * - `rejected`: the provider refused the request; no task was created.
 * - `unknown`: a task may exist (network error, 5xx, no task id). Tell the
 *   user to check the RollDek console before submitting again.
 * An AbortError is rethrown as-is; whether a task exists is then unknown too.
 */
export const submitRollDekVideoTask = async (
  request: RollDekVideoRequest,
): Promise<{ taskId: string; endpoint: string }> => {
  const config = request.config || loadAIProxyConfig();

  assertRollDekTransport(request.baseURL, config);

  const body =
    request.protocol === "volc-tasks"
      ? buildRollDekVolcRequestBody(request)
      : buildRollDekSdRequestBody(request);
  const endpoint = buildRollDekSubmitURL(request.protocol, request.baseURL);
  let response: Response;

  try {
    response = await fetchAIRequest(
      endpoint,
      {
        method: "POST",
        headers: buildHeaders(request.apiKey, true),
        body: JSON.stringify(body),
        signal: request.signal,
      },
      { kind: "video-submit", signal: request.signal, config },
    );
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw error;
    }
    if (error instanceof AIProxyTransportError) {
      throw new AIImageGenerationError(error.message, error.code, {
        ...error.details,
        submitOutcome: SUBMIT_OUTCOME_UNKNOWN,
      });
    }
    throw new AIImageGenerationError(
      "AI video request failed before a response arrived. The task may or may not have been created; check the RollDek console before submitting again.",
      "cors-or-network",
      {
        endpoint,
        errorMessage: error?.message,
        submitOutcome: SUBMIT_OUTCOME_UNKNOWN,
      },
    );
  }

  const responseJSON = await readJSON(response);

  if (!response.ok) {
    const error = normalizeProviderError(response.status, responseJSON as any, {
      endpoint,
    });
    error.details = {
      ...(error.details as object),
      submitOutcome:
        response.status >= 500
          ? SUBMIT_OUTCOME_UNKNOWN
          : SUBMIT_OUTCOME_REJECTED,
    };
    throw error;
  }

  const taskId =
    readString(responseJSON.id) || readString(responseJSON.task_id);

  if (!taskId) {
    throw new AIImageGenerationError(
      "Video submission returned no task id. The task may or may not have been created; check the RollDek console before submitting again.",
      "invalid-response",
      {
        endpoint,
        providerResponse: responseJSON,
        submitOutcome: SUBMIT_OUTCOME_UNKNOWN,
      },
    );
  }

  return { taskId, endpoint };
};

/**
 * Polls once. HTTP and network failures throw, and the caller keeps polling
 * the same task. A missing task throws with `details.taskNotFound`, so the
 * caller can stop after a few in a row instead of on the first one.
 */
export const pollRollDekVideoTask = async ({
  protocol,
  baseURL,
  apiKey,
  taskId,
  signal,
  config: configOverride,
}: {
  protocol: RollDekVideoProtocol;
  baseURL: string;
  apiKey: string;
  taskId: string;
  signal?: AbortSignal;
  config?: AIProxyConfigV2;
}): Promise<AIVideoPollResult> => {
  const config = configOverride || loadAIProxyConfig();

  assertRollDekTransport(baseURL, config);

  const endpoint = buildRollDekPollURL(protocol, baseURL, taskId);
  let response: Response;

  try {
    response = await fetchAIRequest(
      endpoint,
      { method: "GET", headers: buildHeaders(apiKey, false), signal },
      { kind: "video-poll", signal, config },
    );
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw error;
    }
    if (error instanceof AIProxyTransportError) {
      throw new AIImageGenerationError(
        error.message,
        error.code,
        error.details,
      );
    }
    throw new AIImageGenerationError(
      "AI video status request failed. The task keeps running; polling will retry.",
      "cors-or-network",
      { endpoint, errorMessage: error?.message },
    );
  }

  const responseJSON = await readJSON(response);

  if (!response.ok) {
    const code = readErrorCode(responseJSON);
    const error = normalizeProviderError(response.status, responseJSON as any, {
      endpoint,
    });

    // sd: 400 `task_not_exist`; Volcengine: 404 `task_not_found`.
    if (code === "task_not_exist" || code === "task_not_found") {
      error.details = { ...(error.details as object), taskNotFound: true };
    }
    throw error;
  }

  const status = normalizeRollDekStatus(readString(responseJSON.status));
  const progress = readNumber(responseJSON.progress);

  if (status === "failed") {
    return {
      status,
      ...(progress != null ? { progress } : {}),
      error:
        readString(responseJSON.error?.message) ||
        `Video task ${readString(responseJSON.status) || "failed"}.`,
    };
  }

  if (status !== "completed") {
    return { status, ...(progress != null ? { progress } : {}) };
  }

  const usage = responseJSON.usage as Record<string, unknown> | undefined;
  const totalTokens =
    readNumber(usage?.total_tokens) ?? readNumber(usage?.completion_tokens);
  const durationSeconds =
    readNumber(responseJSON.duration) ?? readNumber(responseJSON.seconds);

  return {
    status,
    ...(progress != null ? { progress } : {}),
    // Built from the configured host; downloading it needs the API key.
    videoURL: buildRollDekContentURL(baseURL, taskId),
    ...(durationSeconds != null ? { durationSeconds } : {}),
    ...(totalTokens != null ? { totalTokens } : {}),
  };
};

/** Matches the `ai-video-ingest` server limit. */
export const ROLLDEK_VIDEO_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

const readBodyWithLimit = async (response: Response, maxBytes: number) => {
  const reader = response.body?.getReader?.();

  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new Error("video-too-large");
    }
    return buffer;
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error("video-too-large");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

// An MP4 starts with a box whose type (bytes 4–8) is `ftyp`.
const hasMP4Signature = (bytes: Uint8Array) =>
  bytes.byteLength >= 8 &&
  String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) === "ftyp";

/**
 * Downloads a finished task's video with the API key (ADR 0039 §7). The URL
 * is built from the configured Base URL. Failures carry
 * `details.downloadFailed`; the task should be kept, since downloading again
 * is free.
 */
export const downloadRollDekVideoResult = async ({
  baseURL,
  apiKey,
  taskId,
  signal,
  config: configOverride,
  maxBytes = ROLLDEK_VIDEO_DOWNLOAD_MAX_BYTES,
}: {
  baseURL: string;
  apiKey: string;
  taskId: string;
  signal?: AbortSignal;
  config?: AIProxyConfigV2;
  maxBytes?: number;
}): Promise<{ blob: Blob; mimeType: string; bytes: number }> => {
  const config = configOverride || loadAIProxyConfig();

  assertRollDekTransport(baseURL, config);

  const endpoint = buildRollDekContentURL(baseURL, taskId);
  const headers = buildHeaders(apiKey, false);
  headers.set("Accept", "video/mp4");
  const fail = (message: string, details: Record<string, unknown> = {}) =>
    new AIImageGenerationError(message, "invalid-response", {
      endpoint,
      downloadFailed: true,
      ...details,
    });

  let response: Response;
  try {
    response = await fetchAIRequest(
      endpoint,
      { method: "GET", headers, signal },
      { kind: "video-poll", signal, config },
    );
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw error;
    }
    if (error instanceof AIProxyTransportError) {
      throw new AIImageGenerationError(error.message, error.code, {
        ...error.details,
        endpoint,
        downloadFailed: true,
      });
    }
    throw new AIImageGenerationError(
      "Downloading the generated video failed. The video is still on RollDek; try downloading again.",
      "cors-or-network",
      { endpoint, errorMessage: error?.message, downloadFailed: true },
    );
  }

  if (!response.ok) {
    const error = normalizeProviderError(
      response.status,
      (await readJSON(response)) as any,
      { endpoint },
    );
    error.details = { ...(error.details as object), downloadFailed: true };
    throw error;
  }

  const mimeType = (response.headers.get("Content-Type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (mimeType !== "video/mp4") {
    throw fail(
      `The generated video has an unexpected type (${mimeType || "none"}).`,
      { mimeType },
    );
  }

  const declaredLength = Number(response.headers.get("Content-Length") || 0);
  if (declaredLength > maxBytes) {
    throw fail("The generated video is too large to save.", {
      bytes: declaredLength,
    });
  }

  let bytes: Uint8Array;
  try {
    bytes = await readBodyWithLimit(response, maxBytes);
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw error;
    }
    if (error?.message === "video-too-large") {
      throw fail("The generated video is too large to save.");
    }
    throw new AIImageGenerationError(
      "Downloading the generated video was interrupted. Try downloading again.",
      "cors-or-network",
      { endpoint, errorMessage: error?.message, downloadFailed: true },
    );
  }

  if (!hasMP4Signature(bytes)) {
    throw fail("The downloaded file is not a valid MP4 video.", {
      bytes: bytes.byteLength,
    });
  }

  return {
    blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType }),
    mimeType,
    bytes: bytes.byteLength,
  };
};
