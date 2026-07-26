import { t } from "@excalidraw/excalidraw/i18n";

import {
  getAIProxyEndpoint,
  getAIProxyReadyEndpoint,
  loadAIProxyConfig,
} from "./proxyConfig";

import type { AIProxyConfigV1 } from "./proxyConfig";

export type AIRequestKind =
  | "image-generation"
  | "remote-image"
  | "video-submit"
  | "video-poll"
  | "text-agent"
  | "vision-agent";

export type AIRequestTransportOptions = {
  kind: AIRequestKind;
  signal?: AbortSignal;
  config?: AIProxyConfigV1;
};

export type AIProxyTransportErrorCode =
  | "proxy-network"
  | "proxy-error"
  | "proxy-config";

export class AIProxyTransportError extends Error {
  constructor(
    public readonly code: AIProxyTransportErrorCode,
    message: string,
    public readonly details?: {
      status?: number;
      proxyErrorCode?: string;
      requestId?: string;
    },
  ) {
    super(message);
    this.name = "AIProxyTransportError";
  }
}

const getProxyErrorMessage = (code: string) => {
  if (code === "AI_PROXY_TOKEN_REQUIRED" || code === "AI_PROXY_TOKEN_INVALID") {
    return t("ai.proxy.errors.token");
  }

  if (code === "AI_PROXY_TARGET_BLOCKED") {
    return t("ai.proxy.errors.targetBlocked");
  }

  if (code === "AI_PROXY_REDIRECT_REQUIRES_FINAL_URL") {
    return t("ai.proxy.errors.redirect");
  }

  return t("ai.proxy.errors.server");
};

const createRequestId = () => {
  try {
    return crypto.randomUUID();
  } catch {
    return `ai-proxy-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
};

const assertTargetURL = (targetURL: string) => {
  try {
    const url = new URL(targetURL);

    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.hash
    ) {
      throw new Error("invalid target");
    }
  } catch {
    throw new AIProxyTransportError(
      "proxy-config",
      t("ai.proxy.errors.invalidTarget"),
    );
  }
};

export const getAIProxyErrorCode = (response: Response) => {
  return response.headers.get("X-Excalidraw-AI-Proxy-Error") || "";
};

export const throwForAIProxyResponse = (response: Response) => {
  const proxyErrorCode = getAIProxyErrorCode(response);

  if (!proxyErrorCode) {
    return;
  }

  throw new AIProxyTransportError(
    "proxy-error",
    getProxyErrorMessage(proxyErrorCode),
    {
      status: response.status,
      proxyErrorCode,
      requestId:
        response.headers.get("X-Excalidraw-AI-Request-ID") || undefined,
    },
  );
};

export const fetchAIRequest = async (
  targetURL: string,
  init: RequestInit,
  options: AIRequestTransportOptions,
): Promise<Response> => {
  const config = options.config || loadAIProxyConfig();
  const signal = options.signal || init.signal || undefined;

  if (!config.enabled) {
    return fetch(targetURL, { ...init, signal });
  }

  assertTargetURL(targetURL);

  let endpoint: string;

  try {
    endpoint = getAIProxyEndpoint(config);
  } catch {
    throw new AIProxyTransportError(
      "proxy-config",
      t("ai.proxy.errors.invalidEndpoint"),
    );
  }

  const headers = new Headers(init.headers);
  const requestId = createRequestId();
  headers.set("X-Excalidraw-AI-Target", targetURL);
  headers.set("X-Excalidraw-AI-Request-ID", requestId);

  if (config.accessToken.trim()) {
    headers.set("X-Excalidraw-AI-Proxy-Token", config.accessToken.trim());
  }

  try {
    const response = await fetch(endpoint, {
      ...init,
      headers,
      signal,
    });
    throwForAIProxyResponse(response);
    return response;
  } catch (error: any) {
    if (error instanceof AIProxyTransportError) {
      throw error;
    }

    if (error?.name === "AbortError" || signal?.aborted) {
      throw error;
    }

    throw new AIProxyTransportError(
      "proxy-network",
      t("ai.proxy.errors.network"),
    );
  }
};

export const testAIProxyConnection = async (
  config: AIProxyConfigV1,
  signal?: AbortSignal,
) => {
  let readyEndpoint: string;

  try {
    readyEndpoint = getAIProxyReadyEndpoint(getAIProxyEndpoint(config));
  } catch {
    throw new AIProxyTransportError(
      "proxy-config",
      t("ai.proxy.errors.invalidEndpoint"),
    );
  }

  const headers = new Headers({ Accept: "application/json" });
  headers.set("X-Excalidraw-AI-Request-ID", createRequestId());

  if (config.accessToken.trim()) {
    headers.set("X-Excalidraw-AI-Proxy-Token", config.accessToken.trim());
  }

  try {
    const response = await fetch(readyEndpoint, {
      method: "GET",
      headers,
      signal,
    });
    throwForAIProxyResponse(response);

    if (!response.ok) {
      throw new AIProxyTransportError(
        "proxy-error",
        t("ai.proxy.errors.server"),
        { status: response.status },
      );
    }

    return response;
  } catch (error: any) {
    if (
      error instanceof AIProxyTransportError ||
      error?.name === "AbortError" ||
      signal?.aborted
    ) {
      throw error;
    }

    throw new AIProxyTransportError(
      "proxy-network",
      t("ai.proxy.errors.network"),
    );
  }
};
