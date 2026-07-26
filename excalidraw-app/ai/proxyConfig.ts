import { STORAGE_KEYS } from "../app_constants";

export const AI_PROXY_CONFIG_UPDATED_EVENT = "excalidraw-ai-proxy-config";
export const AI_PROXY_ENDPOINT_PATH = "/ai-proxy/v1/forward";
export const AI_PROXY_DEFAULT_READY_PATH = "/ai-proxy/readyz";

export type AIProxyConfigV1 = {
  version: 1;
  enabled: boolean;
  endpoint: string;
  accessToken: string;
};

export const DEFAULT_AI_PROXY_CONFIG: AIProxyConfigV1 = {
  version: 1,
  enabled: false,
  endpoint: "",
  accessToken: "",
};

export class AIProxyConfigError extends Error {
  public readonly code = "invalid-endpoint";

  constructor(message: string) {
    super(message);
    this.name = "AIProxyConfigError";
  }
}

const isProductionBuild = () => {
  return (
    import.meta.env.MODE === "production" ||
    String(import.meta.env.PROD) === "true"
  );
};

const getWindowOrigin = () => {
  return typeof window !== "undefined" && window.location.origin
    ? window.location.origin
    : "http://localhost";
};

const stripTrailingSlashes = (value: string) => value.replace(/\/+$/, "");

const isLoopbackHostname = (hostname: string) => {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();

  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
};

const assertNoUnsafeURLParts = (url: URL) => {
  if (url.username || url.password || url.hash) {
    throw new AIProxyConfigError(
      "The AI proxy endpoint cannot contain credentials or a URL fragment.",
    );
  }
};

export const validateAIProxyEndpoint = (
  rawEndpoint: string,
  options: { production?: boolean } = {},
) => {
  const endpoint = rawEndpoint.trim();

  if (!endpoint) {
    return "";
  }

  if (
    Array.from(endpoint).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new AIProxyConfigError(
      "The AI proxy endpoint cannot contain control characters.",
    );
  }

  if (endpoint.startsWith("//")) {
    throw new AIProxyConfigError(
      "The AI proxy endpoint cannot be protocol-relative.",
    );
  }

  const production = options.production ?? isProductionBuild();
  const isRelative = endpoint.startsWith("/") && !endpoint.startsWith("//");
  let url: URL;

  try {
    url = new URL(endpoint, getWindowOrigin());
  } catch {
    throw new AIProxyConfigError("The AI proxy endpoint is not a valid URL.");
  }

  assertNoUnsafeURLParts(url);

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AIProxyConfigError(
      "The AI proxy endpoint must use HTTP or HTTPS.",
    );
  }

  if (
    url.protocol === "http:" &&
    (production || !isLoopbackHostname(url.hostname))
  ) {
    throw new AIProxyConfigError(
      "Remote AI proxy endpoints must use HTTPS. HTTP is allowed only for localhost development.",
    );
  }

  if (isRelative) {
    return endpoint;
  }

  return stripTrailingSlashes(url.toString());
};

export const getRuntimeDefaultAIProxyEndpoint = () => {
  const configured = String(import.meta.env.VITE_APP_AI_PROXY_URL || "").trim();

  return configured || AI_PROXY_ENDPOINT_PATH;
};

export const getAIProxyEndpoint = (config: AIProxyConfigV1) => {
  const endpoint = config.endpoint.trim() || getRuntimeDefaultAIProxyEndpoint();

  return validateAIProxyEndpoint(endpoint);
};

export const getAIProxyReadyEndpoint = (endpoint: string) => {
  const normalizedEndpoint = validateAIProxyEndpoint(endpoint);
  const isRelative = normalizedEndpoint.startsWith("/");
  const url = new URL(normalizedEndpoint, getWindowOrigin());

  if (/\/v1\/forward\/?$/i.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/v1\/forward\/?$/i, "/readyz");
  } else {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/readyz`;
  }
  url.search = "";
  url.hash = "";

  return isRelative ? `${url.pathname}${url.search}` : url.toString();
};

const normalizeAIProxyConfig = (value: unknown): AIProxyConfigV1 => {
  const candidate = value && typeof value === "object" ? value : {};
  const rawEndpoint =
    typeof (candidate as any).endpoint === "string"
      ? (candidate as any).endpoint.trim()
      : "";
  const endpoint = rawEndpoint
    ? validateAIProxyEndpoint(rawEndpoint, { production: false })
    : "";

  return {
    version: 1,
    enabled: (candidate as any).enabled === true,
    endpoint,
    accessToken:
      typeof (candidate as any).accessToken === "string"
        ? (candidate as any).accessToken.trim()
        : "",
  };
};

export const loadAIProxyConfig = (): AIProxyConfigV1 => {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_AI_PROXY);

    return raw
      ? normalizeAIProxyConfig(JSON.parse(raw))
      : DEFAULT_AI_PROXY_CONFIG;
  } catch {
    return DEFAULT_AI_PROXY_CONFIG;
  }
};

export const saveAIProxyConfig = (config: Partial<AIProxyConfigV1>) => {
  const normalizedConfig = normalizeAIProxyConfig(config);
  const production = isProductionBuild();

  if (normalizedConfig.endpoint) {
    normalizedConfig.endpoint = validateAIProxyEndpoint(
      normalizedConfig.endpoint,
      { production },
    );
  }

  localStorage.setItem(
    STORAGE_KEYS.LOCAL_STORAGE_AI_PROXY,
    JSON.stringify(normalizedConfig),
  );

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(AI_PROXY_CONFIG_UPDATED_EVENT, {
        detail: normalizedConfig,
      }),
    );
  }

  return normalizedConfig;
};

export const resetAIProxyConfig = () => {
  localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_AI_PROXY);

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(AI_PROXY_CONFIG_UPDATED_EVENT, {
        detail: DEFAULT_AI_PROXY_CONFIG,
      }),
    );
  }

  return DEFAULT_AI_PROXY_CONFIG;
};
