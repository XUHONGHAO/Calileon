export const EMBED_PROTOCOL_CHANNEL = "excalidraw-embed";
export const EMBED_PROTOCOL_VERSION = 1 as const;

export const EMBED_MAX_COMMAND_BYTES = 5 * 1024 * 1024;
export const EMBED_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export const EMBED_COMMANDS = [
  "loadScene",
  "setMode",
  "scrollToContent",
  "scrollToElement",
  "getScene",
  "export",
  "subscribe",
  "unsubscribe",
] as const;

export const EMBED_EVENTS = [
  "ready",
  "sceneChange",
  "selectionChange",
  "error",
] as const;

export const EMBED_EXPORT_FORMATS = ["png", "svg", "json"] as const;
export const EMBED_MODES = ["view", "edit"] as const;
export const EMBED_UI_PRESETS = ["full", "compact", "presentation"] as const;
export const EMBED_SOURCE_TYPES = ["share", "p1", "scene"] as const;

export type EmbedCommandName = typeof EMBED_COMMANDS[number];
export type EmbedEventName = typeof EMBED_EVENTS[number];
export type EmbedExportFormat = typeof EMBED_EXPORT_FORMATS[number];
export type EmbedMode = typeof EMBED_MODES[number];
export type EmbedUIPreset = typeof EMBED_UI_PRESETS[number];
export type EmbedSourceType = typeof EMBED_SOURCE_TYPES[number];

export type EmbedErrorCode =
  | "INVALID_MESSAGE"
  | "UNSUPPORTED_VERSION"
  | "FORBIDDEN_ORIGIN"
  | "INSTANCE_MISMATCH"
  | "MESSAGE_TOO_LARGE"
  | "READ_ONLY"
  | "NOT_FOUND"
  | "UNSUPPORTED_COMMAND"
  | "EXPORT_FAILED"
  | "TIMEOUT"
  | "DESTROYED"
  | "INTERNAL_ERROR";

export interface EmbedProtocolError {
  code: EmbedErrorCode;
  message: string;
  details?: unknown;
}

export interface EmbedSceneData {
  elements?: readonly unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
}

export type EmbedContentSource =
  | { type: "share"; url: string }
  | { type: "p1"; payload: unknown }
  | { type: "scene"; scene: EmbedSceneData };

export interface EmbedCapabilities {
  protocolVersions: readonly number[];
  commands: readonly EmbedCommandName[];
  events: readonly EmbedEventName[];
  exportFormats: readonly EmbedExportFormat[];
  modes: readonly EmbedMode[];
  uiPresets: readonly EmbedUIPreset[];
  sourceTypes: readonly EmbedSourceType[];
  limits: {
    maxCommandBytes: number;
    maxResponseBytes: number;
  };
}

export const DEFAULT_EMBED_CAPABILITIES: EmbedCapabilities = {
  protocolVersions: [EMBED_PROTOCOL_VERSION],
  commands: EMBED_COMMANDS,
  events: EMBED_EVENTS,
  exportFormats: EMBED_EXPORT_FORMATS,
  modes: EMBED_MODES,
  uiPresets: EMBED_UI_PRESETS,
  sourceTypes: EMBED_SOURCE_TYPES,
  limits: {
    maxCommandBytes: EMBED_MAX_COMMAND_BYTES,
    maxResponseBytes: EMBED_MAX_RESPONSE_BYTES,
  },
};

export type EmbedCommandPayloadMap = {
  loadScene: { source: EmbedContentSource };
  setMode: { mode: EmbedMode };
  scrollToContent: {
    fitToViewport?: boolean;
    animate?: boolean;
    duration?: number;
  };
  scrollToElement: {
    elementId: string;
    fitToViewport?: boolean;
    animate?: boolean;
    duration?: number;
  };
  getScene: Record<string, never>;
  export: {
    format: EmbedExportFormat;
    exportBackground?: boolean;
    exportPadding?: number;
    exportScale?: number;
  };
  subscribe: { events: readonly EmbedEventName[] };
  unsubscribe: { events: readonly EmbedEventName[] };
};

export type EmbedCommandResultMap = {
  loadScene: { loaded: true };
  setMode: { mode: EmbedMode };
  scrollToContent: { scrolled: true };
  scrollToElement: { scrolled: true };
  getScene: { scene: EmbedSceneData };
  export: {
    format: EmbedExportFormat;
    mimeType: string;
    data: string;
  };
  subscribe: { events: readonly EmbedEventName[] };
  unsubscribe: { events: readonly EmbedEventName[] };
};

export type EmbedEventPayloadMap = {
  ready: {
    mode: EmbedMode;
    preset: EmbedUIPreset;
    capabilities: EmbedCapabilities;
  };
  sceneChange: {
    revision: number;
    elementCount: number;
  };
  selectionChange: { selectedElementIds: readonly string[] };
  error: EmbedProtocolError;
};

interface EmbedEnvelopeBase {
  channel: typeof EMBED_PROTOCOL_CHANNEL;
  protocolVersion: typeof EMBED_PROTOCOL_VERSION;
  instanceId: string;
  requestId: string;
  payload: unknown;
}

export type EmbedCommandMessage<
  Name extends EmbedCommandName = EmbedCommandName,
> = EmbedEnvelopeBase & {
  kind: "command";
  name: Name;
  payload: EmbedCommandPayloadMap[Name];
};

export type EmbedSuccessResponse<
  Name extends EmbedCommandName = EmbedCommandName,
> = EmbedEnvelopeBase & {
  kind: "response";
  name: Name;
  ok: true;
  payload: EmbedCommandResultMap[Name];
};

export type EmbedErrorResponse = EmbedEnvelopeBase & {
  kind: "response";
  name: EmbedCommandName;
  ok: false;
  payload: EmbedProtocolError;
};

export type EmbedResponseMessage = EmbedSuccessResponse | EmbedErrorResponse;

export type EmbedEventMessage<Name extends EmbedEventName = EmbedEventName> =
  EmbedEnvelopeBase & {
    kind: "event";
    name: Name;
    payload: EmbedEventPayloadMap[Name];
  };

export type EmbedProtocolMessage =
  | EmbedCommandMessage
  | EmbedResponseMessage
  | EmbedEventMessage;

const MESSAGE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export const isValidEmbedMessageId = (value: unknown): value is string =>
  typeof value === "string" && MESSAGE_ID_RE.test(value);

export const getEmbedMessageByteSize = (value: unknown): number => {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? Number.POSITIVE_INFINITY
      : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

export const isEmbedProtocolMessage = (
  value: unknown,
): value is EmbedProtocolMessage => {
  if (!isRecord(value)) {
    return false;
  }

  if (
    value.channel !== EMBED_PROTOCOL_CHANNEL ||
    value.protocolVersion !== EMBED_PROTOCOL_VERSION ||
    !isValidEmbedMessageId(value.instanceId) ||
    !isValidEmbedMessageId(value.requestId) ||
    !("payload" in value)
  ) {
    return false;
  }

  if (value.kind === "command") {
    return EMBED_COMMANDS.includes(value.name as EmbedCommandName);
  }

  if (value.kind === "event") {
    return EMBED_EVENTS.includes(value.name as EmbedEventName);
  }

  if (value.kind === "response") {
    return (
      EMBED_COMMANDS.includes(value.name as EmbedCommandName) &&
      typeof value.ok === "boolean"
    );
  }

  return false;
};

const createEnvelope = <Payload>(input: {
  instanceId: string;
  requestId: string;
  payload: Payload;
}) => {
  if (
    !isValidEmbedMessageId(input.instanceId) ||
    !isValidEmbedMessageId(input.requestId)
  ) {
    throw new Error("Invalid embed instance or request ID");
  }

  return {
    channel: EMBED_PROTOCOL_CHANNEL,
    protocolVersion: EMBED_PROTOCOL_VERSION,
    instanceId: input.instanceId,
    requestId: input.requestId,
    payload: input.payload,
  } as const;
};

export const createEmbedCommand = <Name extends EmbedCommandName>(input: {
  instanceId: string;
  requestId: string;
  name: Name;
  payload: EmbedCommandPayloadMap[Name];
}): EmbedCommandMessage<Name> => ({
  ...createEnvelope<EmbedCommandPayloadMap[Name]>(input),
  kind: "command",
  name: input.name,
});

export const createEmbedSuccessResponse = <
  Name extends EmbedCommandName,
>(input: {
  instanceId: string;
  requestId: string;
  name: Name;
  payload: EmbedCommandResultMap[Name];
}): EmbedSuccessResponse<Name> => ({
  ...createEnvelope<EmbedCommandResultMap[Name]>(input),
  kind: "response",
  name: input.name,
  ok: true,
});

export const createEmbedErrorResponse = (input: {
  instanceId: string;
  requestId: string;
  name: EmbedCommandName;
  error: EmbedProtocolError;
}): EmbedErrorResponse => ({
  ...createEnvelope<EmbedProtocolError>({ ...input, payload: input.error }),
  kind: "response",
  name: input.name,
  ok: false,
});

export const createEmbedEvent = <Name extends EmbedEventName>(input: {
  instanceId: string;
  requestId: string;
  name: Name;
  payload: EmbedEventPayloadMap[Name];
}): EmbedEventMessage<Name> => ({
  ...createEnvelope<EmbedEventPayloadMap[Name]>(input),
  kind: "event",
  name: input.name,
});
