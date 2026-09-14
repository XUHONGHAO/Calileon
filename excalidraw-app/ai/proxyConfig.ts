import { STORAGE_KEYS } from "../app_constants";

export const AI_PROXY_CONFIG_UPDATED_EVENT = "excalidraw-ai-proxy-config";
export const AI_PROXY_ENDPOINT_PATH = "/ai-proxy/v1/forward";
export const AI_PROXY_DEFAULT_READY_PATH = "/ai-proxy/readyz";
export const AI_GATEWAY_ENDPOINT_PATH = "/ai-gateway/v1";

export type AIProxyConfigV1 = {
  version: 1;
  enabled: boolean;
  endpoint: string;
  accessToken: string;
};

export type AITransportMode = "direct" | "byok-proxy" | "managed-gateway";

export type AIProxyConfigV2 = {
  version: 2;
  mode: AITransportMode;
  endpoint: string;
  accessToken: string;
  gatewayEndpoint: string;
  managedRoutes: Record<string, string>;
};

export const DEFAULT_AI_PROXY_CONFIG: AIProxyConfigV2 = {
  version: 2,
  mode: "direct",
  endpoint: "",
  accessToken: "",
  gatewayEndpoint: "",
  managedRoutes: {},
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
  const origin =
    typeof window !== "undefined" ? window.location.origin : undefined;
  // `file://` documents have an opaque `null` origin. It cannot be used as a
  // URL base for validating relative endpoints; use a harmless synthetic
  // HTTP origin so validation still runs and relative paths remain relative.
  return origin && origin !== "null" ? origin : "http://localhost";
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
  options: { production?: boolean; allowQuery?: boolean } = {},
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

  if (options.allowQuery === false && url.search) {
    throw new AIProxyConfigError(
      "The AI service endpoint cannot contain a query string.",
    );
  }

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

export const getAIProxyEndpoint = (config: AIProxyConfigV2) => {
  const endpoint = config.endpoint.trim() || getRuntimeDefaultAIProxyEndpoint();

  return validateAIProxyEndpoint(endpoint);
};

export const getRuntimeDefaultAIGatewayEndpoint = () => {
  const configured = String(
    import.meta.env.VITE_APP_AI_GATEWAY_URL || "",
  ).trim();
  return configured || AI_GATEWAY_ENDPOINT_PATH;
};

export const getAIGatewayEndpoint = (config: AIProxyConfigV2) =>
  validateAIProxyEndpoint(
    config.gatewayEndpoint.trim() || getRuntimeDefaultAIGatewayEndpoint(),
    { allowQuery: false },
  ).replace(/\/+$/, "");

export const getAIGatewayReadyEndpoint = (config: AIProxyConfigV2) =>
  `${getAIGatewayEndpoint(config)}/readyz`;

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

const normalizeManagedRoutes = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, route]) =>
          /^[a-z0-9-]{1,64}$/i.test(key) &&
          typeof route === "string" &&
          /^[a-z0-9._-]{1,128}$/i.test(route.trim()),
      )
      .map(([key, route]) => [key, String(route).trim()]),
  );
};

const normalizeAIProxyConfig = (
  value: unknown,
  options: { production?: boolean } = {},
): AIProxyConfigV2 => {
  const candidate = value && typeof value === "object" ? value : {};
  const isV1 = (candidate as any).version === 1;
  const requestedMode = isV1
    ? (candidate as any).enabled === true
      ? "byok-proxy"
      : "direct"
    : (candidate as any).mode;
  const mode: AITransportMode = [
    "direct",
    "byok-proxy",
    "managed-gateway",
  ].includes(requestedMode)
    ? requestedMode
    : "direct";
  const rawEndpoint =
    typeof (candidate as any).endpoint === "string"
      ? (candidate as any).endpoint.trim()
      : "";
  const endpoint = rawEndpoint
    ? validateAIProxyEndpoint(rawEndpoint, {
        production: options.production,
      })
    : "";

  const rawGatewayEndpoint =
    typeof (candidate as any).gatewayEndpoint === "string"
      ? (candidate as any).gatewayEndpoint.trim()
      : "";
  const gatewayEndpoint = rawGatewayEndpoint
    ? validateAIProxyEndpoint(rawGatewayEndpoint, {
        production: options.production,
        allowQuery: false,
      })
    : "";

  return {
    version: 2,
    mode,
    endpoint,
    accessToken:
      typeof (candidate as any).accessToken === "string"
        ? (candidate as any).accessToken.trim()
        : "",
    gatewayEndpoint,
    managedRoutes: normalizeManagedRoutes((candidate as any).managedRoutes),
  };
};

export const loadAIProxyConfig = (): AIProxyConfigV2 => {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_AI_PROXY);
    const production = isProductionBuild();

    return raw
      ? normalizeAIProxyConfig(JSON.parse(raw), { production })
      : DEFAULT_AI_PROXY_CONFIG;
  } catch {
    return DEFAULT_AI_PROXY_CONFIG;
  }
};

export const saveAIProxyConfig = (config: Partial<AIProxyConfigV2>) => {
  const current = loadAIProxyConfig();
  const normalizedConfig = normalizeAIProxyConfig({
    ...current,
    ...config,
    managedRoutes:
      config.managedRoutes === undefined
        ? current.managedRoutes
        : config.managedRoutes,
  });
  const production = isProductionBuild();

  if (normalizedConfig.endpoint) {
    normalizedConfig.endpoint = validateAIProxyEndpoint(
      normalizedConfig.endpoint,
      { production },
    );
  }
  if (normalizedConfig.gatewayEndpoint) {
    normalizedConfig.gatewayEndpoint = validateAIProxyEndpoint(
      normalizedConfig.gatewayEndpoint,
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
