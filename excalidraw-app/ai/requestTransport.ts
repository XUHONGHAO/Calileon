import { t } from "@excalidraw/excalidraw/i18n";

import { getCloudBackend } from "../data/cloud";
import {
  AiGatewayHttpError,
  createHttpAiGateway,
} from "../data/cloud/HttpAiGateway";

import {
  AIProxyConfigError,
  getAIProxyEndpoint,
  getAIProxyReadyEndpoint,
  loadAIProxyConfig,
} from "./proxyConfig";
import { getAIGatewayEndpoint } from "./proxyConfig";

import type { AIProxyConfigV2 } from "./proxyConfig";
import type {
  AiGateway,
  AiGatewayCapability,
  AiGatewayCatalogEntry,
} from "../data/cloud/types";

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
  config?: AIProxyConfigV2;
  managedOperation?: string;
  managedParams?: Record<string, string>;
  managedAccessToken?: string;
  /** Optional user prompt to audit when the account has explicitly opted in. */
  auditPrompt?: string;
  /** Catalog metadata resolved by an adapter for managed-gateway requests. */
  managedRoute?: AiGatewayCatalogEntry;
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

const getManagedGatewayErrorMessage = (code: string) => {
  switch (code) {
    case "AI_GATEWAY_UNAUTHORIZED":
      return t("ai.proxy.managedSignInRequired");
    case "AI_GATEWAY_RATE_LIMITED":
    case "AI_GATEWAY_QUOTA_EXCEEDED":
    case "AI_GATEWAY_CONCURRENCY_EXCEEDED":
      return t("ai.proxy.errors.managedQuota");
    case "AI_GATEWAY_ROUTE_NOT_FOUND":
    case "AI_GATEWAY_OPERATION_NOT_ALLOWED":
      return t("ai.proxy.errors.managedRouteMissing");
    case "AI_GATEWAY_NOT_READY":
    case "AI_GATEWAY_DISABLED":
      return t("ai.proxy.managedUnavailable");
    default:
      return t("ai.proxy.errors.managedGateway");
  }
};

const createRequestId = () => {
  try {
    return crypto.randomUUID();
  } catch {
    return `ai-proxy-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
};

/**
 * Resolve the configured managed gateway through the cloud boundary. The
 * default endpoint uses the assembled adapter (and therefore its AuthProvider)
 * while an explicitly configured endpoint is still constructed without
 * importing any platform SDK into the AI module.
 */
export const getManagedGatewayForConfig = (
  config: AIProxyConfigV2,
): AiGateway => {
  const backend = getCloudBackend();
  const runtimeEndpoint = String(
    import.meta.env.VITE_APP_AI_GATEWAY_URL || "",
  ).trim();
  if (!config.gatewayEndpoint.trim() && !runtimeEndpoint) {
    return backend.ai;
  }
  return createHttpAiGateway({
    auth: backend.auth,
    baseURL: getAIGatewayEndpoint(config),
  });
};

/**
 * Resolve a route alias against the server catalog. A local provider URL or
 * key is never needed for this lookup; the catalog intentionally contains
 * only public route metadata.
 */
export const getManagedRouteForCapability = async (
  capability: AiGatewayCapability,
  options: {
    config?: AIProxyConfigV2;
    accessToken?: string;
    routeId?: string;
  } = {},
): Promise<AiGatewayCatalogEntry> => {
  const config = options.config || loadAIProxyConfig();
  if (config.mode !== "managed-gateway") {
    throw new AIProxyTransportError(
      "proxy-config",
      t("ai.proxy.errors.managedRouteMissing"),
    );
  }
  const routeId = options.routeId || config.managedRoutes[capability];
  if (!routeId) {
    throw new AIProxyTransportError(
      "proxy-config",
      t("ai.proxy.errors.managedRouteMissing"),
    );
  }
  const gateway = getManagedGatewayForConfig(config);
  let catalog: AiGatewayCatalogEntry[];
  try {
    catalog = await gateway.getCatalog({ accessToken: options.accessToken });
  } catch (error: any) {
    if (error instanceof AiGatewayHttpError) {
      throw new AIProxyTransportError(
        "proxy-error",
        getManagedGatewayErrorMessage(error.code),
        {
          status: error.status,
          proxyErrorCode: error.code,
          requestId: error.requestId,
        },
      );
    }
    throw error;
  }
  const route = catalog.find(
    (entry) => entry.id === routeId && entry.capability === capability,
  );
  if (!route) {
    throw new AIProxyTransportError(
      "proxy-config",
      t("ai.proxy.errors.managedRouteMissing"),
    );
  }
  return route;
};

/** A non-network placeholder used only as the ignored target argument. */
export const MANAGED_GATEWAY_TARGET = "https://managed.invalid/";

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

  if (config.mode === "direct") {
    return fetch(targetURL, { ...init, signal });
  }

  if (config.mode === "managed-gateway") {
    const routeId =
      options.managedRoute?.id || config.managedRoutes[options.kind];
    if (!routeId) {
      throw new AIProxyTransportError(
        "proxy-config",
        t("ai.proxy.errors.managedRouteMissing"),
      );
    }
    if (
      options.managedRoute &&
      options.managedRoute.capability !== options.kind
    ) {
      throw new AIProxyTransportError(
        "proxy-config",
        t("ai.proxy.errors.managedRouteMissing"),
      );
    }
    const operation =
      options.managedOperation ||
      (
        {
          "image-generation": "generate",
          "remote-image": "download",
          "video-submit": "submit",
          "video-poll": "poll",
          "text-agent": "stream",
          "vision-agent": "generate",
        } as const
      )[options.kind];
    try {
      const backend = getCloudBackend();
      const runtimeEndpoint = String(
        import.meta.env.VITE_APP_AI_GATEWAY_URL || "",
      ).trim();
      const gateway = options.managedRoute
        ? getManagedGatewayForConfig(config)
        : config.gatewayEndpoint.trim() || runtimeEndpoint
        ? createHttpAiGateway({
            auth: backend.auth,
            baseURL: getAIGatewayEndpoint(config),
          })
        : backend.ai;
      let auditDraftId: string | undefined;
      if (options.auditPrompt?.trim()) {
        const consent = await gateway.getAuditConsent({
          accessToken: options.managedAccessToken,
        });
        if (consent.deploymentEnabled && consent.enabled) {
          auditDraftId = await gateway.createAuditDraft({
            routeId,
            prompt: options.auditPrompt,
            accessToken: options.managedAccessToken,
          });
        }
      }
      return await gateway.invoke({
        routeId,
        operation,
        method: init.method,
        body: init.body,
        headers: init.headers,
        query: options.managedParams,
        signal,
        accessToken: options.managedAccessToken,
        auditDraftId,
      });
    } catch (error: any) {
      if (error?.name === "AbortError" || signal?.aborted) {
        throw error;
      }
      if (error instanceof AiGatewayHttpError) {
        throw new AIProxyTransportError(
          "proxy-error",
          getManagedGatewayErrorMessage(error.code),
          {
            status: error.status,
            proxyErrorCode: error.code,
            requestId: error.requestId,
          },
        );
      }
      if (error instanceof AIProxyConfigError) {
        throw new AIProxyTransportError(
          "proxy-config",
          t("ai.proxy.errors.invalidEndpoint"),
        );
      }
      throw new AIProxyTransportError(
        "proxy-error",
        getManagedGatewayErrorMessage(error?.code || ""),
        {
          status: error?.status,
          proxyErrorCode: error?.code,
          requestId: error?.requestId,
        },
      );
    }
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
  config: AIProxyConfigV2,
  signal?: AbortSignal,
) => {
  if (config.mode !== "byok-proxy") {
    throw new AIProxyTransportError(
      "proxy-config",
      t("ai.proxy.errors.tryByokProxy"),
    );
  }
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
