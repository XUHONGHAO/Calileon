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
    },
    response: {
      summary: sanitizePersistedURL(responseSummary),
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

    const sanitizedValue = shouldPreserveTextField(fieldName)
      ? value
      : sanitizePersistedURL(value);

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
    },
    response: {
      summary: sanitizePersistedURL(entry.response.summary),
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
