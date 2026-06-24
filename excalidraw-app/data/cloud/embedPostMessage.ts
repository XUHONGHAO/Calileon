export const EMBED_API_VERSION = 1;
export const EMBED_API_SOURCE = "excalidraw-embed";

export type EmbedApiMessageType = "command" | "event" | "response";

export type EmbedApiCommandName =
  | "getScene"
  | "setScene"
  | "save"
  | "setReadonly"
  | "ping";

export type EmbedApiEventName = "ready" | "sceneChange" | "saved" | "error";

export interface EmbedApiEnvelope {
  source: typeof EMBED_API_SOURCE;
  version: typeof EMBED_API_VERSION;
  type: EmbedApiMessageType;
  name: string;
  requestId?: string;
  payload?: unknown;
}

export const isEmbedApiEnvelope = (value: unknown): value is EmbedApiEnvelope =>
  !!value &&
  typeof value === "object" &&
  (value as Partial<EmbedApiEnvelope>).source === EMBED_API_SOURCE &&
  (value as Partial<EmbedApiEnvelope>).version === EMBED_API_VERSION &&
  typeof (value as Partial<EmbedApiEnvelope>).type === "string" &&
  typeof (value as Partial<EmbedApiEnvelope>).name === "string";

export const createEmbedEvent = (
  name: EmbedApiEventName,
  payload?: unknown,
): EmbedApiEnvelope => ({
  source: EMBED_API_SOURCE,
  version: EMBED_API_VERSION,
  type: "event",
  name,
  payload,
});

export const createEmbedResponse = (
  requestId: string | undefined,
  name: string,
  payload?: unknown,
): EmbedApiEnvelope => ({
  source: EMBED_API_SOURCE,
  version: EMBED_API_VERSION,
  type: "response",
  name,
  requestId,
  payload,
});

export const createEmbedError = (
  message: string,
  requestId?: string,
): EmbedApiEnvelope => ({
  source: EMBED_API_SOURCE,
  version: EMBED_API_VERSION,
  type: requestId ? "response" : "event",
  name: "error",
  requestId,
  payload: { message },
});
