import { AIProxyError } from "./errors.js";

export type AIProxyConfig = {
  port: number;
  production: boolean;
  allowedOrigins: ReadonlySet<string>;
  requireClientToken: boolean;
  clientTokens: readonly string[];
  allowHttpLocalhost: boolean;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  idleTimeoutMs: number;
  maxRequestBytes: number;
  maxRedirects: number;
  shutdownGraceMs: number;
  logTargetHostname: boolean;
};

const readPositiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const readBoolean = (value: string | undefined, fallback: boolean) => {
  if (value == null || !value.trim()) {
    return fallback;
  }

  return value.trim().toLowerCase() === "true";
};

const normalizeOrigin = (value: string, production: boolean) => {
  const url = new URL(value.trim());

  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    (production && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("invalid origin");
  }

  return url.origin;
};

const readOrigins = (value: string | undefined, production: boolean) => {
  const configured = (value || (production ? "" : "http://localhost:3000"))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (configured.includes("*")) {
    throw new AIProxyError("AI_PROXY_INTERNAL_ERROR", 500, {
      message: "AI_PROXY_ALLOWED_ORIGINS cannot contain a wildcard.",
      retryable: false,
    });
  }

  try {
    return new Set(
      configured.map((origin) => normalizeOrigin(origin, production)),
    );
  } catch (error) {
    throw new AIProxyError("AI_PROXY_INTERNAL_ERROR", 500, {
      message: "AI_PROXY_ALLOWED_ORIGINS contains an invalid origin.",
      retryable: false,
      cause: error,
    });
  }
};

const readTokens = (value: string | undefined) => {
  return (value || "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
};

export const loadAIProxyConfig = (
  env: NodeJS.ProcessEnv = process.env,
): AIProxyConfig => {
  const production = env.NODE_ENV === "production";
  const requireClientToken = production
    ? true
    : readBoolean(env.AI_PROXY_REQUIRE_CLIENT_TOKEN, false);
  const clientTokens = readTokens(env.AI_PROXY_CLIENT_TOKENS);
  const allowedOrigins = readOrigins(env.AI_PROXY_ALLOWED_ORIGINS, production);

  if (production && allowedOrigins.size === 0) {
    throw new AIProxyError("AI_PROXY_INTERNAL_ERROR", 500, {
      message: "AI_PROXY_ALLOWED_ORIGINS is required in production.",
      retryable: false,
    });
  }

  if (requireClientToken && clientTokens.length === 0) {
    throw new AIProxyError("AI_PROXY_INTERNAL_ERROR", 500, {
      message: "AI_PROXY_CLIENT_TOKENS is required when tokens are enforced.",
      retryable: false,
    });
  }

  return Object.freeze({
    port: readPositiveInteger(env.AI_PROXY_PORT, 3016),
    production,
    allowedOrigins,
    requireClientToken,
    clientTokens: Object.freeze(clientTokens),
    allowHttpLocalhost:
      !production && readBoolean(env.AI_PROXY_ALLOW_HTTP_LOCALHOST, true),
    connectTimeoutMs: readPositiveInteger(
      env.AI_PROXY_CONNECT_TIMEOUT_MS,
      10_000,
    ),
    requestTimeoutMs: readPositiveInteger(
      env.AI_PROXY_REQUEST_TIMEOUT_MS,
      600_000,
    ),
    idleTimeoutMs: readPositiveInteger(env.AI_PROXY_IDLE_TIMEOUT_MS, 120_000),
    maxRequestBytes: readPositiveInteger(
      env.AI_PROXY_MAX_REQUEST_BYTES,
      64 * 1024 * 1024,
    ),
    maxRedirects: Math.min(
      readPositiveInteger(env.AI_PROXY_MAX_REDIRECTS, 5),
      10,
    ),
    shutdownGraceMs: readPositiveInteger(
      env.AI_PROXY_SHUTDOWN_GRACE_MS,
      30_000,
    ),
    logTargetHostname: readBoolean(env.AI_PROXY_LOG_TARGET_HOSTNAME, true),
  });
};
