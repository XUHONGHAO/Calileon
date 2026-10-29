// Debug context attached to AI media errors (`AIImageGenerationError.details`)
// so the generation log can explain a failure: which stage, how long it took,
// what the provider sent back and what (shape of) request we sent. Values are
// summaries only; the generation log sanitizer redacts secrets before storing.

const MAX_RAW_BODY_LENGTH = 2000;
const MAX_SUMMARY_STRING_LENGTH = 200;
const MAX_SUMMARY_DEPTH = 3;
const MAX_SUMMARY_ITEMS = 8;

// Response headers that help a provider look up a request. Cross-origin
// responses only expose them when the provider lists them in
// Access-Control-Expose-Headers; missing ones are simply skipped.
const DIAGNOSTIC_RESPONSE_HEADERS = [
  "content-type",
  "x-request-id",
  "request-id",
  "x-trace-id",
  "cf-ray",
  "retry-after",
  "x-ratelimit-remaining-requests",
  "x-excalidraw-ai-request-id",
];

export type AIRequestStage = "submit" | "poll";

export type AIRequestDiagnostics = {
  stage: AIRequestStage;
  method: string;
  endpoint: string;
  transport: string;
  elapsedMs: number;
  request?: unknown;
};

export type AIProviderResponseBody = {
  json: Record<string, unknown>;
  rawBody?: string;
};

export const createAIRequestTimer = () => {
  const startedAt = Date.now();

  return () => Date.now() - startedAt;
};

export const readDiagnosticResponseHeaders = (response: Response) => {
  const headers: Record<string, string> = {};

  for (const name of DIAGNOSTIC_RESPONSE_HEADERS) {
    const value = response.headers?.get(name);

    if (value) {
      headers[name] = value;
    }
  }

  return headers;
};

/**
 * Reads a provider response once as text, then parses it. Non-JSON bodies
 * (HTML error pages, plain-text gateway errors) are kept as a truncated
 * `rawBody` instead of being discarded.
 */
export const readProviderResponseBody = async (
  response: Response,
): Promise<AIProviderResponseBody> => {
  let text: string;

  try {
    text = await response.text();
  } catch {
    return { json: {} };
  }

  if (!text.trim()) {
    return { json: {} };
  }

  try {
    const parsed = JSON.parse(text);

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { json: parsed as Record<string, unknown> };
    }
  } catch {
    // fall through to rawBody
  }

  return {
    json: {},
    rawBody:
      text.length > MAX_RAW_BODY_LENGTH
        ? `${text.slice(0, MAX_RAW_BODY_LENGTH)}...`
        : text,
  };
};

export const describeNetworkFailure = (
  error: any,
  diagnostics: AIRequestDiagnostics,
) => ({
  ...diagnostics,
  errorName: error?.name,
  errorMessage: error?.message,
  online: typeof navigator === "undefined" ? undefined : navigator.onLine,
});

const summarizeValue = (
  value: unknown,
  fieldName: string,
  depth: number,
): unknown => {
  if (typeof value === "string") {
    // Prompts are logged separately and base64 images are huge; keep sizes.
    if (
      value.startsWith("data:") ||
      /prompt/i.test(fieldName) ||
      fieldName === "text" ||
      value.length > MAX_SUMMARY_STRING_LENGTH
    ) {
      return `[string, ${value.length} chars]`;
    }
    return value;
  }

  if (value == null || typeof value !== "object") {
    return value;
  }

  if (depth >= MAX_SUMMARY_DEPTH) {
    return Array.isArray(value) ? `[array, ${value.length} items]` : "[object]";
  }

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_SUMMARY_ITEMS)
      .map((item) => summarizeValue(item, fieldName, depth + 1));

    return value.length > MAX_SUMMARY_ITEMS
      ? [...items, `[+${value.length - MAX_SUMMARY_ITEMS} more]`]
      : items;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      summarizeValue(entry, key, depth + 1),
    ]),
  );
};

/** Shape of the outgoing body: scalar params verbatim, payloads as sizes. */
export const summarizeRequestBody = (body: unknown): unknown => {
  if (typeof body === "string") {
    try {
      return { format: "json", body: summarizeValue(JSON.parse(body), "", 0) };
    } catch {
      return { format: "text", length: body.length };
    }
  }

  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const fields: unknown[] = [];

    body.forEach((value, key) => {
      fields.push(
        typeof value === "string"
          ? { [key]: summarizeValue(value, key, 1) }
          : { [key]: `[file ${value.type || "unknown"}, ${value.size} bytes]` },
      );
    });

    return { format: "multipart", fields };
  }

  return undefined;
};
