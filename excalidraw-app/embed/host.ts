import {
  EMBED_MAX_COMMAND_BYTES,
  EMBED_MAX_RESPONSE_BYTES,
  type EmbedCommandName,
  type EmbedCommandPayloadMap,
  type EmbedCommandResultMap,
  type EmbedContentSource,
  type EmbedEventName,
  type EmbedEventPayloadMap,
  type EmbedExportFormat,
  type EmbedMode,
  type EmbedProtocolError,
  type EmbedProtocolMessage,
  type EmbedSceneData,
  type EmbedUIPreset,
  createEmbedCommand,
  getEmbedMessageByteSize,
  isEmbedProtocolMessage,
  isValidEmbedMessageId,
} from "./protocol";

export class ExcalidrawEmbedError extends Error {
  constructor(public readonly error: EmbedProtocolError) {
    super(error.message);
    this.name = "ExcalidrawEmbedError";
  }
}

export interface ExcalidrawEmbedHostOptions {
  container: HTMLElement;
  src: string;
  instanceId?: string;
  mode?: EmbedMode;
  preset?: EmbedUIPreset;
  title?: string;
  className?: string;
  requestTimeoutMs?: number;
  sandbox?: string;
  allow?: string;
}

export interface ConnectExcalidrawEmbedOptions {
  instanceId: string;
  targetOrigin?: string;
  requestTimeoutMs?: number;
  removeIframeOnDestroy?: boolean;
}

type EmbedEventHandler<Name extends EmbedEventName> = (
  payload: EmbedEventPayloadMap[Name],
) => void;

type PendingRequest = {
  name: EmbedCommandName;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeoutId: number;
};

const createId = (prefix: string) => {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}:${
    uuid ?? `${Date.now()}:${Math.random().toString(36).slice(2)}`
  }`;
};

const getHttpOrigin = (url: URL): string => {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The embed target must use an HTTP(S) origin");
  }
  return url.origin;
};

export class ExcalidrawEmbedHost {
  public readonly ready: Promise<EmbedEventPayloadMap["ready"]>;

  private destroyed = false;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly handlers = new Map<
    EmbedEventName,
    Set<(payload: never) => void>
  >();
  private resolveReady!: (payload: EmbedEventPayloadMap["ready"]) => void;
  private rejectReady!: (reason: unknown) => void;

  constructor(
    public readonly iframe: HTMLIFrameElement,
    public readonly instanceId: string,
    public readonly targetOrigin: string,
    private readonly requestTimeoutMs = 10_000,
    private readonly removeIframeOnDestroy = false,
  ) {
    if (!isValidEmbedMessageId(instanceId)) {
      throw new Error("Invalid embed instance ID");
    }
    getHttpOrigin(new URL(targetOrigin));

    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    window.addEventListener("message", this.handleMessage);
  }

  private handleMessage = (event: MessageEvent) => {
    if (
      this.destroyed ||
      event.source !== this.iframe.contentWindow ||
      event.origin !== this.targetOrigin ||
      !isEmbedProtocolMessage(event.data) ||
      event.data.instanceId !== this.instanceId
    ) {
      return;
    }

    const message: EmbedProtocolMessage = event.data;
    if (getEmbedMessageByteSize(message) > EMBED_MAX_RESPONSE_BYTES) {
      if (message.kind === "response") {
        const pending = this.pending.get(message.requestId);
        if (pending) {
          window.clearTimeout(pending.timeoutId);
          this.pending.delete(message.requestId);
          pending.reject(
            new ExcalidrawEmbedError({
              code: "MESSAGE_TOO_LARGE",
              message: "The embed response exceeds the maximum message size",
            }),
          );
        }
      }
      return;
    }

    if (message.kind === "response") {
      const pending = this.pending.get(message.requestId);
      if (!pending || pending.name !== message.name) {
        return;
      }
      window.clearTimeout(pending.timeoutId);
      this.pending.delete(message.requestId);
      if (message.ok) {
        pending.resolve(message.payload);
      } else {
        pending.reject(new ExcalidrawEmbedError(message.payload));
      }
      return;
    }

    if (message.kind === "event") {
      if (message.name === "ready") {
        this.resolveReady(message.payload as EmbedEventPayloadMap["ready"]);
      }
      const handlers = this.handlers.get(message.name);
      handlers?.forEach((handler) => handler(message.payload as never));
    }
  };

  public on<Name extends EmbedEventName>(
    name: Name,
    handler: EmbedEventHandler<Name>,
  ): () => void {
    const handlers =
      this.handlers.get(name) ?? new Set<(payload: never) => void>();
    handlers.add(handler as (payload: never) => void);
    this.handlers.set(name, handlers);
    return () => {
      handlers.delete(handler as (payload: never) => void);
      if (handlers.size === 0) {
        this.handlers.delete(name);
      }
    };
  }

  public async request<Name extends EmbedCommandName>(
    name: Name,
    payload: EmbedCommandPayloadMap[Name],
  ): Promise<EmbedCommandResultMap[Name]> {
    if (this.destroyed) {
      throw new ExcalidrawEmbedError({
        code: "DESTROYED",
        message: "The embed host has been destroyed",
      });
    }

    await this.ready;
    const requestId = createId("request");
    const message = createEmbedCommand({
      instanceId: this.instanceId,
      requestId,
      name,
      payload,
    });
    if (getEmbedMessageByteSize(message) > EMBED_MAX_COMMAND_BYTES) {
      throw new ExcalidrawEmbedError({
        code: "MESSAGE_TOO_LARGE",
        message: "The embed command exceeds the maximum message size",
      });
    }

    const response = new Promise<EmbedCommandResultMap[Name]>(
      (resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
          this.pending.delete(requestId);
          reject(
            new ExcalidrawEmbedError({
              code: "TIMEOUT",
              message: `Embed command timed out: ${name}`,
            }),
          );
        }, this.requestTimeoutMs);
        this.pending.set(requestId, {
          name,
          resolve: resolve as (value: unknown) => void,
          reject,
          timeoutId,
        });
      },
    );

    this.iframe.contentWindow?.postMessage(message, this.targetOrigin);
    return response;
  }

  public loadScene(source: EmbedContentSource) {
    return this.request("loadScene", { source });
  }

  public setMode(mode: EmbedMode) {
    return this.request("setMode", { mode });
  }

  public scrollToContent(
    options: EmbedCommandPayloadMap["scrollToContent"] = {},
  ) {
    return this.request("scrollToContent", options);
  }

  public scrollToElement(
    elementId: string,
    options: Omit<EmbedCommandPayloadMap["scrollToElement"], "elementId"> = {},
  ) {
    return this.request("scrollToElement", { elementId, ...options });
  }

  public getScene(): Promise<{ scene: EmbedSceneData }> {
    return this.request("getScene", {});
  }

  public export(
    format: EmbedExportFormat,
    options: Omit<EmbedCommandPayloadMap["export"], "format"> = {},
  ) {
    return this.request("export", { format, ...options });
  }

  public subscribe(events: readonly EmbedEventName[]) {
    return this.request("subscribe", { events });
  }

  public unsubscribe(events: readonly EmbedEventName[]) {
    return this.request("unsubscribe", { events });
  }

  public destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    window.removeEventListener("message", this.handleMessage);
    const error = new ExcalidrawEmbedError({
      code: "DESTROYED",
      message: "The embed host has been destroyed",
    });
    this.rejectReady(error);
    this.pending.forEach((pending) => {
      window.clearTimeout(pending.timeoutId);
      pending.reject(error);
    });
    this.pending.clear();
    this.handlers.clear();
    if (this.removeIframeOnDestroy) {
      this.iframe.remove();
    }
  }
}

export const connectExcalidrawEmbed = (
  iframe: HTMLIFrameElement,
  options: ConnectExcalidrawEmbedOptions,
) => {
  const iframeUrl = new URL(iframe.src, document.baseURI);
  const targetOrigin = options.targetOrigin ?? getHttpOrigin(iframeUrl);
  return new ExcalidrawEmbedHost(
    iframe,
    options.instanceId,
    targetOrigin,
    options.requestTimeoutMs,
    options.removeIframeOnDestroy,
  );
};

export const createExcalidrawEmbed = (
  options: ExcalidrawEmbedHostOptions,
): ExcalidrawEmbedHost => {
  const instanceId = options.instanceId ?? createId("embed");
  const url = new URL(options.src, document.baseURI);
  const targetOrigin = getHttpOrigin(url);
  url.searchParams.set("embed", "1");
  url.searchParams.set("instanceId", instanceId);
  url.searchParams.set("parentOrigin", window.location.origin);
  url.searchParams.set("mode", options.mode ?? "view");
  url.searchParams.set("preset", options.preset ?? "full");

  const iframe = document.createElement("iframe");
  iframe.src = url.toString();
  iframe.title = options.title ?? "Excalidraw whiteboard";
  iframe.className = options.className ?? "";
  iframe.setAttribute(
    "sandbox",
    options.sandbox ?? "allow-scripts allow-same-origin allow-downloads",
  );
  iframe.setAttribute(
    "allow",
    options.allow ?? "clipboard-read; clipboard-write",
  );

  const host = new ExcalidrawEmbedHost(
    iframe,
    instanceId,
    targetOrigin,
    options.requestTimeoutMs,
    true,
  );
  options.container.appendChild(iframe);
  return host;
};
