import fs from "node:fs";
import net from "node:net";

import { isBlockedIPAddress } from "../targetPolicy.js";

import { GatewayError } from "./errors.js";

import type {
  GatewayCapability,
  GatewayDeclarativeConfig,
  GatewayOperationConfig,
  GatewayQuotaPolicy,
  GatewayRouteCandidate,
  GatewayRouteConfig,
} from "./types.js";

export type GatewayRuntimeConfig = Readonly<{
  enabled: boolean;
  production: boolean;
  databaseUrl: string;
  jwksUrl: string;
  issuer: string;
  audience: string;
  algorithms: readonly string[];
  routeConfigPath: string;
  auditContentEnabled: boolean;
  kmsProvider: "aws-kms" | "local-kek";
  kmsKeyId: string;
  localKek: string;
  credentialCacheMs: number;
  requestLeaseMs: number;
  deviceCodeTtlMs: number;
  deviceTokenTtlMs: number;
  devicePollIntervalSeconds: number;
  verificationUri: string;
  metricsToken: string;
  allowedOrigins: ReadonlySet<string>;
  trustProxy: boolean;
}>;

const CAPABILITIES = new Set<GatewayCapability>([
  "image-generation",
  "remote-image",
  "video-submit",
  "video-poll",
  "text-agent",
  "vision-agent",
]);
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const CREDENTIAL_HEADERS = new Set([
  "authorization-bearer",
  "x-goog-api-key",
  "x-api-key",
  "api-key",
  "none",
]);
const JWT_ALGORITHMS = new Set(["RS256", "ES256"]);
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const HEADER_NAME_PATTERN = /^[a-z0-9!#$%&'*+.^_`|~-]+$/i;
const MAX_OPERATION_BODY_BYTES = 64 * 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const containsControlCharacters = (value: string) =>
  Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) || 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });

const readBoolean = (value: string | undefined, fallback: boolean) =>
  value == null || !value.trim()
    ? fallback
    : value.trim().toLowerCase() === "true";

const readPositiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const readOrigins = (value: string | undefined, production: boolean) => {
  const origins = new Set<string>();
  for (const raw of (value || "").split(",")) {
    const origin = raw.trim();
    if (!origin) {
      continue;
    }
    if (origin === "null") {
      origins.add(origin);
      continue;
    }
    let url: URL;
    try {
      url = new URL(origin);
    } catch (error) {
      throw new GatewayError("AI_GATEWAY_NOT_READY", 500, {
        message: "AI_GATEWAY_ALLOWED_ORIGINS contains an invalid origin.",
        retryable: false,
        cause: error,
      });
    }
    if (
      url.origin !== origin ||
      (production && url.protocol !== "https:") ||
      (!production && !["http:", "https:"].includes(url.protocol))
    ) {
      throw new GatewayError("AI_GATEWAY_NOT_READY", 500, {
        message: "AI_GATEWAY_ALLOWED_ORIGINS contains an unsafe origin.",
        retryable: false,
      });
    }
    origins.add(url.origin);
  }
  return origins;
};

const validateEndpointURL = (
  raw: string,
  options: {
    name: string;
    production: boolean;
    allowPath?: boolean;
    allowQuery?: boolean;
  },
) => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new GatewayError("AI_GATEWAY_NOT_READY", 500, {
      message: `${options.name} must be a valid URL.`,
      retryable: false,
      cause: error,
    });
  }
  const localDevelopment =
    !options.production &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !localDevelopment) ||
    url.username ||
    url.password ||
    url.hash ||
    (!options.allowPath && url.pathname !== "/") ||
    (!options.allowQuery && url.search)
  ) {
    throw new GatewayError("AI_GATEWAY_NOT_READY", 500, {
      message: `${options.name} uses an unsafe URL.`,
      retryable: false,
    });
  }
  return url.toString();
};

const validateDatabaseURL = (raw: string) => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new GatewayError("AI_GATEWAY_NOT_READY", 500, {
      message: "AI_GATEWAY_DATABASE_URL must be a valid PostgreSQL URL.",
      retryable: false,
      cause: error,
    });
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) {
    throw new GatewayError("AI_GATEWAY_NOT_READY", 500, {
      message: "AI_GATEWAY_DATABASE_URL must use postgres:// or postgresql://.",
      retryable: false,
    });
  }
  return raw;
};

const isValidBase64Key = (value: string) => {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    return false;
  }
  return Buffer.from(value, "base64").byteLength === 32;
};

const requireString = (value: unknown, name: string) => {
  if (typeof value !== "string" || !value.trim()) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: `${name} must be a non-empty string.`,
      retryable: false,
    });
  }
  const result = value.trim();
  if (result.length > 512 || containsControlCharacters(result)) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: `${name} is too long or contains control characters.`,
      retryable: false,
    });
  }
  return result;
};

const requirePositive = (value: unknown, name: string) => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: `${name} must be a positive integer.`,
      retryable: false,
    });
  }
  return Number(value);
};

const validatePolicy = (value: unknown): GatewayQuotaPolicy => {
  if (!isRecord(value)) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500);
  }
  const id = requireString(value.id, "policy.id");
  if (!IDENTIFIER_PATTERN.test(id)) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: "policy.id contains unsupported characters.",
      retryable: false,
    });
  }
  return Object.freeze({
    id,
    dailyCredits: requirePositive(value.dailyCredits, "policy.dailyCredits"),
    monthlyCredits: requirePositive(
      value.monthlyCredits,
      "policy.monthlyCredits",
    ),
    requestsPerMinute: requirePositive(
      value.requestsPerMinute,
      "policy.requestsPerMinute",
    ),
    maxConcurrency: requirePositive(
      value.maxConcurrency,
      "policy.maxConcurrency",
    ),
  });
};

const validateOperation = (value: unknown): GatewayOperationConfig => {
  if (!isRecord(value)) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500);
  }
  const method = requireString(value.method, "operation.method").toUpperCase();
  if (!METHODS.has(method)) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: "operation.method is not allowed.",
      retryable: false,
    });
  }
  const path = requireString(value.path, "operation.path");
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("#") ||
    path.includes("?") ||
    path.includes("\\")
  ) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: "operation.path must be an absolute provider path.",
      retryable: false,
    });
  }
  if (value.params != null && !isRecord(value.params)) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: "operation.params must be an object.",
      retryable: false,
    });
  }
  const params = isRecord(value.params)
    ? Object.fromEntries(
        Object.entries(value.params).map(([name, pattern]) => [
          name,
          requireString(pattern, `operation.params.${name}`),
        ]),
      )
    : undefined;
  for (const [name, pattern] of Object.entries(params || {})) {
    if (!IDENTIFIER_PATTERN.test(name)) {
      throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
        message: "operation.params contains an invalid parameter name.",
        retryable: false,
      });
    }
    try {
      new RegExp(`^(?:${pattern})$`);
    } catch (error) {
      throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
        message: `operation.params.${name} is not a valid pattern.`,
        retryable: false,
        cause: error,
      });
    }
  }
  const placeholders = new Set(
    Array.from(path.matchAll(/\{([a-zA-Z0-9._-]+)\}/g), (match) => match[1]),
  );
  for (const name of placeholders) {
    if (!params || !(name in params)) {
      throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
        message: `operation.path references an undeclared parameter: ${name}.`,
        retryable: false,
      });
    }
  }
  for (const name of Object.keys(params || {})) {
    if (!placeholders.has(name)) {
      throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
        message: `operation.params.${name} is not used by operation.path.`,
        retryable: false,
      });
    }
  }
  if (value.queryParams != null && !Array.isArray(value.queryParams)) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: "operation.queryParams must be an array.",
      retryable: false,
    });
  }
  const queryParams = Array.isArray(value.queryParams)
    ? value.queryParams.map((item) =>
        requireString(item, "operation.queryParams"),
      )
    : [];
  if (
    new Set(queryParams).size !== queryParams.length ||
    queryParams.some((name) => !HEADER_NAME_PATTERN.test(name))
  ) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: "operation.queryParams contains an invalid or duplicate name.",
      retryable: false,
    });
  }
  const maxRequestBytes =
    value.maxRequestBytes == null
      ? undefined
      : requirePositive(value.maxRequestBytes, "operation.maxRequestBytes");
  if (maxRequestBytes && maxRequestBytes > MAX_OPERATION_BODY_BYTES) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: "operation.maxRequestBytes exceeds the gateway limit.",
      retryable: false,
    });
  }
  return Object.freeze({
    method: method as GatewayOperationConfig["method"],
    path,
    ...(params ? { params: Object.freeze(params) } : {}),
    ...(queryParams.length ? { queryParams: Object.freeze(queryParams) } : {}),
    ...(maxRequestBytes == null ? {} : { maxRequestBytes }),
    ...(value.replayable == null
      ? {}
      : typeof value.replayable === "boolean"
      ? { replayable: value.replayable }
      : (() => {
          throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
            message: "operation.replayable must be boolean.",
            retryable: false,
          });
        })()),
  });
};

const validateCandidate = (
  value: unknown,
  production: boolean,
): GatewayRouteCandidate => {
  if (!isRecord(value)) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500);
  }
  const baseUrl = requireString(value.baseUrl, "candidate.baseUrl");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (error) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: "candidate.baseUrl is invalid.",
      retryable: false,
      cause: error,
    });
  }
  const localDevelopment =
    !production &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !localDevelopment) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: "candidate.baseUrl must be a safe HTTPS base URL.",
      retryable: false,
    });
  }
  if (production && url.hostname.toLowerCase().endsWith(".invalid")) {
    throw new GatewayError("AI_GATEWAY_NOT_READY", 500, {
      message:
        "Production route configuration cannot use placeholder provider hosts.",
      retryable: false,
    });
  }
  const candidateHostname = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(candidateHostname) && isBlockedIPAddress(candidateHostname)) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message:
        "candidate.baseUrl must not resolve to a private or reserved address.",
      retryable: false,
    });
  }
  const credentialHeader = requireString(
    value.credentialHeader,
    "candidate.credentialHeader",
  );
  if (!CREDENTIAL_HEADERS.has(credentialHeader)) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: "candidate.credentialHeader is not supported.",
      retryable: false,
    });
  }
  const credentialId =
    value.credentialId == null
      ? undefined
      : requireString(value.credentialId, "candidate.credentialId");
  if (credentialHeader !== "none" && !credentialId) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: "candidate.credentialId is required.",
      retryable: false,
    });
  }
  if (credentialHeader === "none" && credentialId) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message:
        "candidate.credentialId is not allowed when credentialHeader is none.",
      retryable: false,
    });
  }
  const id = requireString(value.id, "candidate.id");
  if (!IDENTIFIER_PATTERN.test(id)) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: "candidate.id contains unsupported characters.",
      retryable: false,
    });
  }
  const candidateWireProtocol =
    value.wireProtocol == null
      ? undefined
      : requireString(value.wireProtocol, "candidate.wireProtocol");
  return Object.freeze({
    id,
    baseUrl: url.toString().replace(/\/$/, ""),
    ...(candidateWireProtocol ? { wireProtocol: candidateWireProtocol } : {}),
    credentialHeader:
      credentialHeader as GatewayRouteCandidate["credentialHeader"],
    ...(credentialId ? { credentialId } : {}),
  });
};

const validateRoute = (
  value: unknown,
  production: boolean,
): GatewayRouteConfig => {
  if (!isRecord(value) || !isRecord(value.operations)) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500);
  }
  const capability = requireString(value.capability, "route.capability");
  if (!CAPABILITIES.has(capability as GatewayCapability)) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: "route.capability is not supported.",
      retryable: false,
    });
  }
  if (!Array.isArray(value.candidates) || !value.candidates.length) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: "route.candidates must not be empty.",
      retryable: false,
    });
  }
  const wireProtocol = requireString(value.wireProtocol, "route.wireProtocol");
  if (
    value.candidates.some(
      (candidate) =>
        isRecord(candidate) &&
        candidate.wireProtocol != null &&
        candidate.wireProtocol !== wireProtocol,
    )
  ) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: "All route candidates must use the route wire protocol.",
      retryable: false,
    });
  }
  if (!Object.keys(value.operations).length) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: "route.operations must not be empty.",
      retryable: false,
    });
  }
  const routeId = requireString(value.id, "route.id");
  if (!IDENTIFIER_PATTERN.test(routeId)) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: "route.id contains unsupported characters.",
      retryable: false,
    });
  }
  const operationNames = Object.keys(value.operations);
  if (
    operationNames.some(
      (name) => !IDENTIFIER_PATTERN.test(name) || name.length > 64,
    )
  ) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: "route operation names contain unsupported characters.",
      retryable: false,
    });
  }
  const candidates = value.candidates.map((candidate) =>
    validateCandidate(candidate, production),
  );
  if (
    new Set(candidates.map((candidate) => candidate.id)).size !==
    candidates.length
  ) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: "candidate.id values must be unique within a route.",
      retryable: false,
    });
  }
  if (
    candidates.some(
      (candidate) =>
        candidate.wireProtocol != null &&
        candidate.wireProtocol !== wireProtocol,
    )
  ) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: "All route candidates must use the route wire protocol.",
      retryable: false,
    });
  }
  const model = requireString(value.model, "route.model");
  if (production && /^replace-with[-_]/i.test(model)) {
    throw new GatewayError("AI_GATEWAY_NOT_READY", 500, {
      message: "Production route configuration cannot use a placeholder model.",
      retryable: false,
    });
  }
  return Object.freeze({
    id: routeId,
    label: requireString(value.label, "route.label"),
    capability: capability as GatewayCapability,
    wireProtocol,
    model,
    costUnits: requirePositive(value.costUnits, "route.costUnits"),
    operations: Object.freeze(
      Object.fromEntries(
        Object.entries(value.operations).map(([name, operation]) => [
          requireString(name, "operation name"),
          validateOperation(operation),
        ]),
      ),
    ),
    candidates: Object.freeze(candidates),
  });
};

export const parseGatewayDeclarativeConfig = (
  value: unknown,
  production: boolean,
): GatewayDeclarativeConfig => {
  if (!isRecord(value) || value.version !== 1) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: "Gateway route config version 1 is required.",
      retryable: false,
    });
  }
  if (!Array.isArray(value.policies) || !Array.isArray(value.routes)) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500);
  }
  if (!value.policies.length || !value.routes.length) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: "Gateway policies and routes must not be empty.",
      retryable: false,
    });
  }
  const policies = value.policies.map(validatePolicy);
  const routes = value.routes.map((route) => validateRoute(route, production));
  const unique = (values: readonly string[], name: string) => {
    if (new Set(values).size !== values.length) {
      throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
        message: `${name} values must be unique.`,
        retryable: false,
      });
    }
  };
  unique(
    policies.map((policy) => policy.id),
    "policy.id",
  );
  unique(
    routes.map((route) => route.id),
    "route.id",
  );
  const defaultPolicy = requireString(value.defaultPolicy, "defaultPolicy");
  if (!policies.some((policy) => policy.id === defaultPolicy)) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: "defaultPolicy does not reference a configured policy.",
      retryable: false,
    });
  }
  return Object.freeze({
    version: 1,
    defaultPolicy,
    policies: Object.freeze(policies),
    routes: Object.freeze(routes),
  });
};

export const loadGatewayDeclarativeConfig = (
  path: string,
  production: boolean,
) => {
  try {
    return parseGatewayDeclarativeConfig(
      JSON.parse(fs.readFileSync(path, "utf8")),
      production,
    );
  } catch (error) {
    if (error instanceof GatewayError) {
      throw error;
    }
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 500, {
      message: "Unable to read the gateway route config.",
      retryable: false,
      cause: error,
    });
  }
};

export const loadGatewayRuntimeConfig = (
  env: NodeJS.ProcessEnv,
  production: boolean,
): GatewayRuntimeConfig => {
  const enabled = readBoolean(env.AI_GATEWAY_ENABLED, false);
  const rawKmsProvider = (
    env.AI_GATEWAY_KMS_PROVIDER || (production ? "aws-kms" : "local-kek")
  )
    .trim()
    .toLowerCase();
  const kmsProvider = rawKmsProvider as "aws-kms" | "local-kek";
  const config: GatewayRuntimeConfig = Object.freeze({
    enabled,
    production,
    databaseUrl: (env.AI_GATEWAY_DATABASE_URL || "").trim(),
    jwksUrl: (env.AI_GATEWAY_JWKS_URL || "").trim(),
    issuer: (env.AI_GATEWAY_AUTH_ISSUER || "").trim(),
    audience: (env.AI_GATEWAY_AUTH_AUDIENCE || "").trim(),
    algorithms: Object.freeze(
      (env.AI_GATEWAY_AUTH_ALGORITHMS || "RS256,ES256")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
    routeConfigPath: (env.AI_GATEWAY_CONFIG_FILE || "").trim(),
    auditContentEnabled: readBoolean(
      env.AI_GATEWAY_CONTENT_AUDIT_ENABLED,
      false,
    ),
    kmsProvider,
    kmsKeyId: (env.AI_GATEWAY_KMS_KEY_ID || "").trim(),
    localKek: (env.AI_GATEWAY_LOCAL_KEK || "").trim(),
    credentialCacheMs: readPositiveInteger(
      env.AI_GATEWAY_CREDENTIAL_CACHE_MS,
      60_000,
    ),
    requestLeaseMs: readPositiveInteger(
      env.AI_GATEWAY_REQUEST_LEASE_MS,
      15 * 60_000,
    ),
    deviceCodeTtlMs: readPositiveInteger(
      env.AI_GATEWAY_DEVICE_CODE_TTL_MS,
      10 * 60_000,
    ),
    deviceTokenTtlMs: readPositiveInteger(
      env.AI_GATEWAY_DEVICE_TOKEN_TTL_MS,
      60 * 60_000,
    ),
    devicePollIntervalSeconds: Math.min(
      60,
      readPositiveInteger(env.AI_GATEWAY_DEVICE_POLL_INTERVAL_SECONDS, 5),
    ),
    verificationUri: (env.AI_GATEWAY_DEVICE_VERIFICATION_URI || "").trim(),
    metricsToken: (env.AI_GATEWAY_METRICS_TOKEN || "").trim(),
    allowedOrigins: readOrigins(env.AI_GATEWAY_ALLOWED_ORIGINS, production),
    trustProxy: readBoolean(env.AI_GATEWAY_TRUST_PROXY, false),
  });

  if (!enabled) {
    return config;
  }
  if (rawKmsProvider !== "aws-kms" && rawKmsProvider !== "local-kek") {
    throw new GatewayError("AI_GATEWAY_NOT_READY", 500, {
      message: "AI_GATEWAY_KMS_PROVIDER must be aws-kms or local-kek.",
      retryable: false,
    });
  }
  if (
    !config.algorithms.length ||
    new Set(config.algorithms).size !== config.algorithms.length ||
    config.algorithms.some((algorithm) => !JWT_ALGORITHMS.has(algorithm))
  ) {
    throw new GatewayError("AI_GATEWAY_NOT_READY", 500, {
      message: "AI_GATEWAY_AUTH_ALGORITHMS must only contain RS256 or ES256.",
      retryable: false,
    });
  }
  const required: Array<[string, string]> = [
    ["AI_GATEWAY_DATABASE_URL", config.databaseUrl],
    ["AI_GATEWAY_JWKS_URL", config.jwksUrl],
    ["AI_GATEWAY_AUTH_ISSUER", config.issuer],
    ["AI_GATEWAY_AUTH_AUDIENCE", config.audience],
    ["AI_GATEWAY_CONFIG_FILE", config.routeConfigPath],
    ["AI_GATEWAY_DEVICE_VERIFICATION_URI", config.verificationUri],
  ];
  const missing = required.filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) {
    throw new GatewayError("AI_GATEWAY_NOT_READY", 500, {
      message: `Missing managed gateway configuration: ${missing.join(", ")}.`,
      retryable: false,
    });
  }
  validateDatabaseURL(config.databaseUrl);
  validateEndpointURL(config.jwksUrl, {
    name: "AI_GATEWAY_JWKS_URL",
    production,
    allowPath: true,
  });
  validateEndpointURL(config.verificationUri, {
    name: "AI_GATEWAY_DEVICE_VERIFICATION_URI",
    production,
    allowPath: true,
    allowQuery: true,
  });
  if (!config.allowedOrigins.size) {
    throw new GatewayError("AI_GATEWAY_NOT_READY", 500, {
      message: "AI_GATEWAY_ALLOWED_ORIGINS is required.",
      retryable: false,
    });
  }
  if (production && kmsProvider !== "aws-kms") {
    throw new GatewayError("AI_GATEWAY_NOT_READY", 500, {
      message: "Production managed gateway requires AWS KMS.",
      retryable: false,
    });
  }
  if (kmsProvider === "aws-kms" && !config.kmsKeyId) {
    throw new GatewayError("AI_GATEWAY_NOT_READY", 500, {
      message: "AI_GATEWAY_KMS_KEY_ID is required for AWS KMS.",
      retryable: false,
    });
  }
  if (kmsProvider === "local-kek") {
    if (!isValidBase64Key(config.localKek)) {
      throw new GatewayError("AI_GATEWAY_NOT_READY", 500, {
        message: "AI_GATEWAY_LOCAL_KEK must be a base64-encoded 32-byte key.",
        retryable: false,
      });
    }
  }
  return config;
};
