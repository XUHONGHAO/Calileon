import { STORAGE_KEYS } from "../app_constants";

import { sanitizePersistedURL } from "./sanitizePersistedURL";

import type {
  AIGenerationLogEntry,
  AIGenerationLogStatus,
  AIImageGenerationOutput,
  AIImageGenerationParams,
  AIModelMediaType,
} from "./types";

export const AI_GENERATION_LOGS_UPDATED_EVENT = "excalidraw-ai-generation-logs";

const MAX_AI_GENERATION_LOG_ENTRIES = 200;
const MAX_STRING_LENGTH = 1200;
const MAX_ARRAY_ITEMS = 12;
const MAX_OBJECT_DEPTH = 5;

// URL parsing percent-encodes the `{task_id}` placeholder; keep it readable.
const sanitizePollEndpoint = (value: string) => {
  return sanitizePersistedURL(value).replace(/%7Btask_id%7D/gi, "{task_id}");
};

export const createAIGenerationLogId = () => {
  return `ai-generation-log-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
};

export const loadAIGenerationLogs = (): AIGenerationLogEntry[] => {
  try {
    const raw = localStorage.getItem(
      STORAGE_KEYS.LOCAL_STORAGE_AI_GENERATION_LOGS,
    );

    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    const logs = Array.isArray(parsed)
      ? parsed.filter(isAIGenerationLogEntry).map(sanitizeGenerationLogEntry)
      : [];

    if (JSON.stringify(logs) !== raw) {
      localStorage.setItem(
        STORAGE_KEYS.LOCAL_STORAGE_AI_GENERATION_LOGS,
        JSON.stringify(logs),
      );
    }

    return logs;
  } catch (error: any) {
    console.error(error);
    return [];
  }
};

export const saveAIGenerationLogs = (logs: AIGenerationLogEntry[]) => {
  const normalizedLogs = logs
    .filter(isAIGenerationLogEntry)
    .map(sanitizeGenerationLogEntry)
    .slice(0, MAX_AI_GENERATION_LOG_ENTRIES);

  localStorage.setItem(
    STORAGE_KEYS.LOCAL_STORAGE_AI_GENERATION_LOGS,
    JSON.stringify(normalizedLogs),
  );
  dispatchAIGenerationLogsUpdated(normalizedLogs);

  return normalizedLogs;
};

export const appendAIGenerationLog = (entry: AIGenerationLogEntry) => {
  return saveAIGenerationLogs([entry, ...loadAIGenerationLogs()]);
};

export const clearAIGenerationLogs = () => {
  localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_AI_GENERATION_LOGS);
  dispatchAIGenerationLogsUpdated([]);
};

export const createAIGenerationLogEntry = ({
  submittedAt,
  mediaType,
  mode,
  status,
  model,
  prompt,
  negativePrompt,
  params,
  baseURL,
  endpoint,
  pollEndpoint,
  responseSummary,
  responseDetails,
}: {
  submittedAt: string;
  mediaType: AIModelMediaType;
  mode: AIGenerationLogEntry["mode"];
  status: AIGenerationLogStatus;
  model: {
    id: string;
    name: string;
    siteName: string;
  };
  prompt: string;
  negativePrompt?: string;
  params: AIImageGenerationParams;
  baseURL: string;
  endpoint?: string;
  pollEndpoint?: string;
  responseSummary: string;
  responseDetails: unknown;
}): AIGenerationLogEntry => {
  return {
    id: createAIGenerationLogId(),
    submittedAt,
    completedAt: new Date().toISOString(),
    mediaType,
    mode,
    status,
    model,
    prompt,
    negativePrompt,
    params,
    request: {
      baseURL: sanitizePersistedURL(baseURL),
      endpoint: endpoint ? sanitizePersistedURL(endpoint) : undefined,
      ...(pollEndpoint
        ? { pollEndpoint: sanitizePollEndpoint(pollEndpoint) }
        : {}),
    },
    response: {
      summary: redactSecretLikeText(sanitizePersistedURL(responseSummary)),
      details: sanitizeLogDetails(responseDetails),
    },
  };
};

export const createSuccessResponseDetails = (
  outputs: AIImageGenerationOutput[],
) => {
  return {
    outputCount: outputs.length,
    outputs: outputs.map((output, index) => ({
      index,
      mimeType: output.mimeType,
      remoteURL: output.remoteURL
        ? sanitizePersistedURL(output.remoteURL)
        : undefined,
      storageType: output.storageType || "data-url",
      remoteFetchError: output.remoteFetchError,
      revisedPrompt: output.revisedPrompt,
      dataURL:
        output.storageType === "remote-url"
          ? undefined
          : {
              length: output.dataURL.length,
              prefix: output.dataURL.slice(0, 48),
            },
    })),
  };
};

export const createErrorResponseDetails = (error: any) => {
  return {
    name: error?.name,
    message: error?.message || String(error),
    code: error?.code,
    details: error?.details,
  };
};

/** Sanitized error details for console output (DevTools does not expand
 * custom Error fields such as `code` and `details` on its own). */
export const getLoggableErrorDetails = (error: unknown) => {
  return sanitizeLogDetails(createErrorResponseDetails(error));
};

const dispatchAIGenerationLogsUpdated = (logs: AIGenerationLogEntry[]) => {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent(AI_GENERATION_LOGS_UPDATED_EVENT, {
      detail: logs,
    }),
  );
};

export const sanitizeLogDetails = (
  value: unknown,
  depth = 0,
  fieldName?: string,
): unknown => {
  if (value == null) {
    return value;
  }

  if (typeof value === "string") {
    if (value.startsWith("data:image/")) {
      return {
        kind: "data-url",
        length: value.length,
        preview: value.slice(0, 48),
      };
    }

    const sanitizedValue = redactSecretLikeText(
      shouldPreserveTextField(fieldName) ? value : sanitizePersistedURL(value),
    );

    return sanitizedValue.length > MAX_STRING_LENGTH
      ? `${sanitizedValue.slice(0, MAX_STRING_LENGTH)}...`
      : sanitizedValue;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (depth >= MAX_OBJECT_DEPTH) {
    return "[Max depth reached]";
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitizeLogDetails(item, depth + 1, fieldName));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        shouldRedactField(key)
          ? "[redacted]"
          : sanitizeLogDetails(entry, depth + 1, key),
      ]),
    );
  }

  return String(value);
};

const shouldRedactField = (key: string) => {
  return /api[-_]?key|authorization|token|secret|password/i.test(key);
};

// Providers sometimes echo the key back in an error message or HTML page.
const SECRET_LIKE_TEXT =
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}|\bAIza[A-Za-z0-9_-]{20,}|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g;

const redactSecretLikeText = (value: string) => {
  return value.replace(SECRET_LIKE_TEXT, "[redacted]");
};

const shouldPreserveTextField = (key?: string) => {
  return (
    !!key &&
    !/url|uri|href|link/i.test(key) &&
    /prompt|message|text|description|summary/i.test(key)
  );
};

const sanitizeGenerationLogEntry = (
  entry: AIGenerationLogEntry,
): AIGenerationLogEntry => {
  return {
    ...entry,
    request: {
      baseURL: sanitizePersistedURL(entry.request.baseURL),
      endpoint: entry.request.endpoint
        ? sanitizePersistedURL(entry.request.endpoint)
        : undefined,
      ...(entry.request.pollEndpoint
        ? { pollEndpoint: sanitizePollEndpoint(entry.request.pollEndpoint) }
        : {}),
    },
    response: {
      summary: redactSecretLikeText(
        sanitizePersistedURL(entry.response.summary),
      ),
      details: sanitizeLogDetails(entry.response.details),
    },
  };
};

const isAIGenerationLogEntry = (
  value: unknown,
): value is AIGenerationLogEntry => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const entry = value as Partial<AIGenerationLogEntry>;

  return (
    typeof entry.id === "string" &&
    typeof entry.submittedAt === "string" &&
    typeof entry.completedAt === "string" &&
    (entry.mediaType === "image" ||
      entry.mediaType === "video" ||
      entry.mediaType === "audio") &&
    (entry.status === "success" ||
      entry.status === "failed" ||
      entry.status === "canceled") &&
    !!entry.model &&
    typeof entry.model.name === "string" &&
    typeof entry.model.siteName === "string" &&
    !!entry.response &&
    typeof entry.response.summary === "string"
  );
};
