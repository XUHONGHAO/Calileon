import crypto from "node:crypto";
import { Transform } from "node:stream";

import { GatewayAuthenticator, hashOpaqueToken } from "./auth.js";
import { redactAuditText } from "./crypto.js";
import {
  createGatewayErrorBody,
  GatewayError,
  toGatewayError,
} from "./errors.js";
import {
  copyGatewayResponseHeaders,
  requestGatewayCandidate,
} from "./invoke.js";
import { TokenBucketLimiter } from "./limiter.js";
import { GatewayMetrics } from "./metrics.js";
import { GatewayRouter } from "./routes.js";

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Readable } from "node:stream";

import type { AIProxyConfig } from "../config.js";
import type { GatewayRuntimeConfig } from "./config.js";
import type { EnvelopeCipher } from "./crypto.js";
import type { GatewayCredentialVault } from "./credentials.js";
import type {
  GatewayDeclarativeConfig,
  GatewayHttpHandler,
  GatewayIdentity,
  GatewayStore,
} from "./types.js";

const GATEWAY_PREFIX = "/ai-gateway/v1";
const MAX_CONTROL_BODY_BYTES = 64 * 1024;
const MAX_REPLAY_BODY_BYTES = 2 * 1024 * 1024;
const AUDIT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const getHeader = (request: IncomingMessage, name: string) => {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] || "" : value || "";
};

const createRequestId = (request: IncomingMessage) => {
  const requested = getHeader(request, "x-excalidraw-ai-request-id");
  return /^[a-zA-Z0-9-]{8,80}$/.test(requested)
    ? requested
    : crypto.randomUUID();
};

const sendJSON = (response: ServerResponse, status: number, body: unknown) => {
  const payload = Buffer.from(JSON.stringify(body));
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", String(payload.byteLength));
  response.end(payload);
};

const applyGatewayHeaders = (
  response: ServerResponse,
  requestId: string,
  origin: string | null,
) => {
  response.setHeader("X-Excalidraw-AI-Gateway", "1");
  response.setHeader("X-Excalidraw-AI-Request-ID", requestId);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader(
    "Access-Control-Expose-Headers",
    [
      "X-Excalidraw-AI-Gateway",
      "X-Excalidraw-AI-Gateway-Error",
      "X-Excalidraw-AI-Request-ID",
    ].join(", "),
  );
  response.setHeader("Vary", "Origin");
  if (origin) {
    response.setHeader("Access-Control-Allow-Origin", origin);
  }
};

const readBody = async (request: IncomingMessage, maxBytes: number) => {
  const rawDeclared = getHeader(request, "content-length").trim();
  if (rawDeclared && !/^\d+$/.test(rawDeclared)) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 400, {
      message: "The content-length header is invalid.",
      retryable: false,
    });
  }
  const declared = rawDeclared ? Number(rawDeclared) : undefined;
  if (
    declared !== undefined &&
    (!Number.isSafeInteger(declared) || declared > maxBytes)
  ) {
    throw new GatewayError("AI_GATEWAY_REQUEST_TOO_LARGE", 413, {
      retryable: false,
    });
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw new GatewayError("AI_GATEWAY_REQUEST_TOO_LARGE", 413, {
        retryable: false,
      });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
};

const readJSON = async <T>(
  request: IncomingMessage,
  maxBytes = MAX_CONTROL_BODY_BYTES,
) => {
  const body = await readBody(request, maxBytes);
  try {
    return JSON.parse(body.toString("utf8") || "{}") as T;
  } catch (error) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 400, {
      retryable: false,
      cause: error,
    });
  }
};

const normalizeLimit = (raw: string, fallback = 50) => {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, 100)
    : fallback;
};

const decodePathSegment = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 400, {
      retryable: false,
      cause: error,
    });
  }
};

const isUUID = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const createUserCode = () => {
  const bytes = crypto.randomBytes(8);
  const chars = Array.from(
    bytes,
    (value) => USER_CODE_ALPHABET[value % USER_CODE_ALPHABET.length],
  ).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
};

const auditContext = (identity: GatewayIdentity, routeId: string) => ({
  purpose: "prompt-audit",
  issuer: identity.issuer,
  subject: identity.subject,
  routeId,
});

const parseIdentity = (
  request: IncomingMessage,
  authenticator: GatewayAuthenticator,
) => authenticator.authenticate(getHeader(request, "authorization"));

const getClientAddress = (
  request: IncomingMessage,
  config: GatewayRuntimeConfig,
) => {
  if (config.trustProxy) {
    const forwarded = getHeader(request, "x-forwarded-for")
      .split(",")[0]
      ?.trim();
    if (forwarded) {
      return forwarded;
    }
  }
  return request.socket.remoteAddress || "unknown";
};

const assertOrigin = (
  request: IncomingMessage,
  config: GatewayRuntimeConfig,
) => {
  const origin = getHeader(request, "origin");
  if (!origin) {
    return null;
  }
  if (!config.allowedOrigins.has(origin)) {
    throw new GatewayError("AI_GATEWAY_FORBIDDEN", 403, {
      message: "The request origin is not allowed.",
      retryable: false,
    });
  }
  return origin;
};

const handlePreflight = (
  request: IncomingMessage,
  response: ServerResponse,
  config: GatewayRuntimeConfig,
  requestId: string,
) => {
  const origin = assertOrigin(request, config);
  if (!origin) {
    throw new GatewayError("AI_GATEWAY_FORBIDDEN", 403, {
      retryable: false,
    });
  }
  const requestedMethod = getHeader(
    request,
    "access-control-request-method",
  ).toUpperCase();
  if (
    !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(requestedMethod)
  ) {
    throw new GatewayError("AI_GATEWAY_OPERATION_NOT_ALLOWED", 405, {
      retryable: false,
    });
  }
  const allowedHeaders = new Set([
    "authorization",
    "content-type",
    "accept",
    "anthropic-version",
    "x-excalidraw-ai-request-id",
    "x-excalidraw-ai-audit-draft",
  ]);
  const requestedHeaders = getHeader(request, "access-control-request-headers")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (requestedHeaders.some((header) => !allowedHeaders.has(header))) {
    throw new GatewayError("AI_GATEWAY_FORBIDDEN", 403, {
      message: "The requested gateway header is not allowed.",
      retryable: false,
    });
  }
  applyGatewayHeaders(response, requestId, origin);
  response.setHeader(
    "Access-Control-Allow-Methods",
    "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  response.setHeader(
    "Access-Control-Allow-Headers",
    [
      "authorization",
      "content-type",
      "accept",
      "anthropic-version",
      "x-excalidraw-ai-request-id",
      "x-excalidraw-ai-audit-draft",
    ].join(", "),
  );
  response.setHeader("Access-Control-Max-Age", "600");
  response.statusCode = 204;
  response.end();
};

export type GatewayHandlerDependencies = Readonly<{
  runtime: GatewayRuntimeConfig;
  declarative: GatewayDeclarativeConfig;
  store: GatewayStore;
  authenticator: GatewayAuthenticator;
  cipher: EnvelopeCipher;
  credentialVault: GatewayCredentialVault;
  proxyConfig: AIProxyConfig;
  router?: GatewayRouter;
  limiter?: TokenBucketLimiter;
  metrics?: GatewayMetrics;
  checkReady?: () => Promise<boolean>;
}>;

class LimitedBodyTransform extends Transform {
  private bytes = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk, encoding);
    this.bytes += buffer.byteLength;
    if (this.bytes > this.maxBytes) {
      callback(
        new GatewayError("AI_GATEWAY_REQUEST_TOO_LARGE", 413, {
          retryable: false,
        }),
      );
      return;
    }
    callback(null, buffer);
  }
}

const declaredBodyLength = (request: IncomingMessage) => {
  const raw = getHeader(request, "content-length");
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 400, {
      message: "The content-length header is invalid.",
      retryable: false,
    });
  }
  return value;
};

const constantTimeTokenEqual = (left: string, right: string) => {
  const leftHash = crypto.createHash("sha256").update(left).digest();
  const rightHash = crypto.createHash("sha256").update(right).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
};

export const createGatewayHandler = (
  dependencies: GatewayHandlerDependencies,
): GatewayHttpHandler => {
  const {
    runtime,
    declarative,
    store,
    authenticator,
    cipher,
    credentialVault,
    proxyConfig,
  } = dependencies;
  const router = dependencies.router || new GatewayRouter(declarative);
  const limiter = dependencies.limiter || new TokenBucketLimiter();
  const metrics = dependencies.metrics || new GatewayMetrics();
  const checkReady =
    dependencies.checkReady ||
    (async () => {
      try {
        const storeReady = await store.checkReady();
        const authReady =
          typeof authenticator.checkReady === "function"
            ? await authenticator.checkReady()
            : true;
        return storeReady && authReady;
      } catch {
        return false;
      }
    });
  const defaultPolicy =
    declarative.policies.find(
      (policy) => policy.id === declarative.defaultPolicy,
    ) || declarative.policies[0];
  if (!defaultPolicy) {
    throw new GatewayError("AI_GATEWAY_NOT_READY", 500, {
      message: "The managed gateway has no quota policy.",
      retryable: false,
    });
  }

  return async (request, response) => {
    const requestId = createRequestId(request);
    const startedAt = Date.now();
    const url = new URL(request.url || "/", "http://ai-gateway.local");
    const method = (request.method || "GET").toUpperCase();
    let origin: string | null = null;
    let reservationCreated = false;
    let dispatched = false;
    let providerAttempts = 0;
    let routeIdForMetrics = "control";

    try {
      if (!runtime.enabled) {
        throw new GatewayError("AI_GATEWAY_DISABLED", 404, {
          retryable: false,
        });
      }
      origin = assertOrigin(request, runtime);
      if (method === "OPTIONS") {
        handlePreflight(request, response, runtime, requestId);
        return;
      }

      // The unauthenticated device bootstrap endpoints are intended for a
      // browser single-file session. Require an explicit Origin (including
      // the literal `null` emitted by file://) so a server-side caller cannot
      // bypass the deployment's browser allowlist; the IP bucket remains a
      // second abuse control.
      if (
        (url.pathname === `${GATEWAY_PREFIX}/device/code` ||
          url.pathname === `${GATEWAY_PREFIX}/device/token`) &&
        !origin
      ) {
        throw new GatewayError("AI_GATEWAY_FORBIDDEN", 403, {
          retryable: false,
        });
      }

      if (
        url.pathname === "/ai-gateway/healthz" ||
        url.pathname === `${GATEWAY_PREFIX}/healthz`
      ) {
        if (method !== "GET") {
          throw new GatewayError("AI_GATEWAY_OPERATION_NOT_ALLOWED", 405, {
            retryable: false,
          });
        }
        applyGatewayHeaders(response, requestId, origin);
        sendJSON(response, 200, { status: "ok", requestId });
        return;
      }

      if (
        url.pathname === "/ai-gateway/readyz" ||
        url.pathname === `${GATEWAY_PREFIX}/readyz`
      ) {
        if (method !== "GET") {
          throw new GatewayError("AI_GATEWAY_OPERATION_NOT_ALLOWED", 405, {
            retryable: false,
          });
        }
        if (!(await checkReady())) {
          throw new GatewayError("AI_GATEWAY_NOT_READY", 503);
        }
        applyGatewayHeaders(response, requestId, origin);
        sendJSON(response, 200, { status: "ready", requestId });
        return;
      }

      if (url.pathname === `${GATEWAY_PREFIX}/metrics`) {
        if (method !== "GET") {
          throw new GatewayError("AI_GATEWAY_OPERATION_NOT_ALLOWED", 405, {
            retryable: false,
          });
        }
        const expected = runtime.metricsToken;
        const supplied = getHeader(request, "authorization").replace(
          /^Bearer\s+/i,
          "",
        );
        if (!expected || !constantTimeTokenEqual(supplied, expected)) {
          throw new GatewayError("AI_GATEWAY_UNAUTHORIZED", 401, {
            retryable: false,
          });
        }
        applyGatewayHeaders(response, requestId, origin);
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/plain; version=0.0.4");
        response.end(metrics.render());
        return;
      }

      // Keep liveness separate from readiness: a deployment with a missing
      // database schema or unavailable JWKS endpoint must not create device
      // sessions, read account data, or dispatch provider requests.
      if (!(await checkReady())) {
        throw new GatewayError("AI_GATEWAY_NOT_READY", 503);
      }

      if (url.pathname === `${GATEWAY_PREFIX}/device/code`) {
        if (method !== "POST") {
          throw new GatewayError("AI_GATEWAY_OPERATION_NOT_ALLOWED", 405, {
            retryable: false,
          });
        }
        limiter.consume(`device-ip:${getClientAddress(request, runtime)}`, {
          capacity: 10,
          refillPerMinute: 10,
        });
        const deviceCode = crypto.randomBytes(32).toString("base64url");
        const userCode = createUserCode();
        const expiresAt = Date.now() + runtime.deviceCodeTtlMs;
        await store.createDeviceAuthorization({
          deviceCodeHash: hashOpaqueToken(deviceCode),
          userCodeHash: hashOpaqueToken(userCode.toUpperCase()),
          userCode,
          expiresAt,
          intervalSeconds: runtime.devicePollIntervalSeconds,
        });
        applyGatewayHeaders(response, requestId, origin);
        sendJSON(response, 200, {
          deviceCode,
          userCode,
          verificationUri: runtime.verificationUri,
          expiresAt,
          intervalSeconds: runtime.devicePollIntervalSeconds,
        });
        return;
      }

      if (url.pathname === `${GATEWAY_PREFIX}/device/token`) {
        if (method !== "POST") {
          throw new GatewayError("AI_GATEWAY_OPERATION_NOT_ALLOWED", 405, {
            retryable: false,
          });
        }
        limiter.consume(`device-ip:${getClientAddress(request, runtime)}`, {
          capacity: 30,
          refillPerMinute: 12,
        });
        const input = await readJSON<{ deviceCode?: string }>(request);
        if (typeof input.deviceCode !== "string" || !input.deviceCode.trim()) {
          throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 400, {
            retryable: false,
          });
        }
        limiter.consume(`device-code:${hashOpaqueToken(input.deviceCode)}`, {
          capacity: 2,
          refillPerMinute: 12,
        });
        const accessToken = crypto.randomBytes(32).toString("base64url");
        const expiresAt = Date.now() + runtime.deviceTokenTtlMs;
        const status = await store.exchangeDeviceAuthorization({
          deviceCodeHash: hashOpaqueToken(input.deviceCode),
          tokenHash: hashOpaqueToken(accessToken),
          tokenExpiresAt: expiresAt,
        });
        if (status === "expired") {
          throw new GatewayError("AI_GATEWAY_DEVICE_EXPIRED", 400, {
            retryable: false,
          });
        }
        if (status === "pending") {
          throw new GatewayError("AI_GATEWAY_DEVICE_PENDING", 428, {
            retryable: true,
          });
        }
        applyGatewayHeaders(response, requestId, origin);
        sendJSON(response, 200, { accessToken, expiresAt });
        return;
      }

      const identity = await parseIdentity(request, authenticator);

      // Device sessions are deliberately narrower than a browser JWT. They
      // exist only to let a paired single-file document invoke the managed
      // catalog and consume its quota; they must never become a second path to
      // account controls or prompt-audit records.
      const isDeviceInvoke = new RegExp(
        `^${GATEWAY_PREFIX}/invoke/[^/]+/[^/]+$`,
      ).test(url.pathname);
      const isDeviceAllowedPath =
        url.pathname === `${GATEWAY_PREFIX}/catalog` ||
        url.pathname === `${GATEWAY_PREFIX}/quota` ||
        url.pathname === `${GATEWAY_PREFIX}/usage` ||
        isDeviceInvoke;
      if (identity.source === "device" && !isDeviceAllowedPath) {
        throw new GatewayError("AI_GATEWAY_FORBIDDEN", 403, {
          message: "This device session cannot access account controls.",
          retryable: false,
        });
      }

      if (url.pathname === `${GATEWAY_PREFIX}/device/approve`) {
        if (method !== "POST" || identity.source !== "jwt") {
          throw new GatewayError("AI_GATEWAY_FORBIDDEN", 403, {
            retryable: false,
          });
        }
        limiter.consume(
          `device-approve:${identity.issuer}:${identity.subject}`,
          {
            capacity: 20,
            refillPerMinute: 20,
          },
        );
        const input = await readJSON<{ userCode?: string }>(request);
        const userCode = input.userCode?.trim().toUpperCase();
        if (!userCode) {
          throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 400, {
            retryable: false,
          });
        }
        const approved = await store.approveDeviceAuthorization({
          userCodeHash: hashOpaqueToken(userCode),
          identity,
        });
        if (!approved) {
          throw new GatewayError("AI_GATEWAY_DEVICE_EXPIRED", 404, {
            retryable: false,
          });
        }
        applyGatewayHeaders(response, requestId, origin);
        sendJSON(response, 200, { approved: true });
        return;
      }

      if (url.pathname === `${GATEWAY_PREFIX}/catalog`) {
        if (method !== "GET") {
          throw new GatewayError("AI_GATEWAY_OPERATION_NOT_ALLOWED", 405, {
            retryable: false,
          });
        }
        applyGatewayHeaders(response, requestId, origin);
        sendJSON(
          response,
          200,
          declarative.routes.map((route) => ({
            id: route.id,
            label: route.label,
            capability: route.capability,
            wireProtocol: route.wireProtocol,
            model: route.model,
            costUnits: route.costUnits,
            operations: Object.keys(route.operations),
          })),
        );
        return;
      }

      if (url.pathname === `${GATEWAY_PREFIX}/quota`) {
        if (method !== "GET") {
          throw new GatewayError("AI_GATEWAY_OPERATION_NOT_ALLOWED", 405, {
            retryable: false,
          });
        }
        applyGatewayHeaders(response, requestId, origin);
        sendJSON(
          response,
          200,
          await store.getQuota(identity, defaultPolicy, declarative.policies),
        );
        return;
      }

      if (url.pathname === `${GATEWAY_PREFIX}/usage`) {
        if (method !== "GET") {
          throw new GatewayError("AI_GATEWAY_OPERATION_NOT_ALLOWED", 405, {
            retryable: false,
          });
        }
        applyGatewayHeaders(response, requestId, origin);
        sendJSON(
          response,
          200,
          await store.listUsage(
            identity,
            normalizeLimit(url.searchParams.get("limit") || ""),
          ),
        );
        return;
      }

      if (url.pathname === `${GATEWAY_PREFIX}/audit/consent`) {
        if (method === "GET") {
          applyGatewayHeaders(response, requestId, origin);
          sendJSON(response, 200, {
            deploymentEnabled: runtime.auditContentEnabled,
            enabled: await store.getAuditConsent(identity),
          });
          return;
        }
        if (method === "PUT") {
          const input = await readJSON<{ enabled?: boolean }>(request);
          if (typeof input.enabled !== "boolean") {
            throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 400, {
              retryable: false,
            });
          }
          await store.setAuditConsent(
            identity,
            runtime.auditContentEnabled && input.enabled,
          );
          applyGatewayHeaders(response, requestId, origin);
          sendJSON(response, 200, {
            deploymentEnabled: runtime.auditContentEnabled,
            enabled: runtime.auditContentEnabled && input.enabled,
          });
          return;
        }
        throw new GatewayError("AI_GATEWAY_OPERATION_NOT_ALLOWED", 405, {
          retryable: false,
        });
      }

      if (url.pathname === `${GATEWAY_PREFIX}/account`) {
        if (method !== "DELETE") {
          throw new GatewayError("AI_GATEWAY_OPERATION_NOT_ALLOWED", 405, {
            retryable: false,
          });
        }
        if (!store.deleteIdentityData) {
          throw new GatewayError("AI_GATEWAY_NOT_READY", 503, {
            message: "Account deletion is not available.",
            retryable: false,
          });
        }
        await store.deleteIdentityData(identity);
        applyGatewayHeaders(response, requestId, origin);
        response.statusCode = 204;
        response.end();
        return;
      }

      if (url.pathname === `${GATEWAY_PREFIX}/audit/drafts`) {
        if (method !== "POST") {
          throw new GatewayError("AI_GATEWAY_OPERATION_NOT_ALLOWED", 405, {
            retryable: false,
          });
        }
        if (
          !runtime.auditContentEnabled ||
          !(await store.getAuditConsent(identity))
        ) {
          throw new GatewayError("AI_GATEWAY_AUDIT_DISABLED", 403, {
            retryable: false,
          });
        }
        const input = await readJSON<{ routeId?: string; prompt?: string }>(
          request,
        );
        if (
          typeof input.routeId !== "string" ||
          typeof input.prompt !== "string"
        ) {
          throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 400, {
            retryable: false,
          });
        }
        const route = router.getRoute(input.routeId);
        const prompt = redactAuditText(input.prompt);
        if (!prompt) {
          throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 400, {
            retryable: false,
          });
        }
        const plaintext = Buffer.from(prompt);
        let envelope: Awaited<ReturnType<EnvelopeCipher["encrypt"]>>;
        try {
          envelope = await cipher.encrypt(
            plaintext,
            auditContext(identity, route.id),
          );
        } finally {
          plaintext.fill(0);
        }
        const auditId = await store.createAudit({
          identity,
          routeId: route.id,
          envelope,
          contentBytes: Buffer.byteLength(prompt, "utf8"),
          expiresAt: Date.now() + AUDIT_RETENTION_MS,
        });
        applyGatewayHeaders(response, requestId, origin);
        sendJSON(response, 201, { auditId });
        return;
      }

      if (url.pathname === `${GATEWAY_PREFIX}/audits`) {
        if (method !== "GET") {
          throw new GatewayError("AI_GATEWAY_OPERATION_NOT_ALLOWED", 405, {
            retryable: false,
          });
        }
        applyGatewayHeaders(response, requestId, origin);
        sendJSON(
          response,
          200,
          await store.listAudits(
            identity,
            normalizeLimit(url.searchParams.get("limit") || ""),
          ),
        );
        return;
      }

      const auditMatch = new RegExp(`^${GATEWAY_PREFIX}/audits/([^/]+)$`).exec(
        url.pathname,
      );
      if (auditMatch) {
        const auditId = decodePathSegment(auditMatch[1]);
        if (!isUUID(auditId)) {
          throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 400, {
            message: "The audit identifier is invalid.",
            retryable: false,
          });
        }
        if (method === "DELETE") {
          await store.deleteAudit(identity, auditId);
          applyGatewayHeaders(response, requestId, origin);
          response.statusCode = 204;
          response.end();
          return;
        }
        if (method === "GET") {
          const record = store.getAuditRecord
            ? await store.getAuditRecord(identity, auditId)
            : (await store.listAudits(identity, 100)).find(
                (item) => item.id === auditId,
              );
          const envelope = await store.getAuditEnvelope(identity, auditId);
          if (!record || !envelope) {
            throw new GatewayError("AI_GATEWAY_ROUTE_NOT_FOUND", 404, {
              message: "The audit record was not found.",
              retryable: false,
            });
          }
          const plaintext = await cipher.decrypt(
            envelope,
            auditContext(identity, record.routeId),
          );
          try {
            applyGatewayHeaders(response, requestId, origin);
            sendJSON(response, 200, {
              ...record,
              prompt: plaintext.toString("utf8"),
            });
          } finally {
            plaintext.fill(0);
          }
          return;
        }
        throw new GatewayError("AI_GATEWAY_OPERATION_NOT_ALLOWED", 405, {
          retryable: false,
        });
      }

      const invokeMatch = new RegExp(
        `^${GATEWAY_PREFIX}/invoke/([^/]+)/([^/]+)$`,
      ).exec(url.pathname);
      if (!invokeMatch) {
        throw new GatewayError("AI_GATEWAY_ROUTE_NOT_FOUND", 404, {
          retryable: false,
        });
      }
      if (
        getHeader(request, "x-excalidraw-ai-target") ||
        getHeader(request, "x-goog-api-key") ||
        getHeader(request, "api-key") ||
        getHeader(request, "x-api-key") ||
        getHeader(request, "apikey")
      ) {
        throw new GatewayError("AI_GATEWAY_FORBIDDEN", 403, {
          message: "Provider targets and credentials are not accepted.",
          retryable: false,
        });
      }
      if (
        identity.source === "device" &&
        getHeader(request, "x-excalidraw-ai-audit-draft")
      ) {
        throw new GatewayError("AI_GATEWAY_FORBIDDEN", 403, {
          message: "Device sessions cannot attach prompt-audit drafts.",
          retryable: false,
        });
      }
      const route = router.getRoute(decodePathSegment(invokeMatch[1]));
      const operationName = decodePathSegment(invokeMatch[2]);
      const operation = router.getOperation(route, operationName);
      routeIdForMetrics = route.id;
      if (method !== operation.method) {
        throw new GatewayError("AI_GATEWAY_OPERATION_NOT_ALLOWED", 405, {
          retryable: false,
        });
      }
      limiter.prune();
      const policyForLimiter = store.getPolicy
        ? await store.getPolicy(identity, defaultPolicy, declarative.policies)
        : defaultPolicy;
      limiter.consume(`${identity.issuer}:${identity.subject}`, {
        capacity: policyForLimiter.requestsPerMinute,
        refillPerMinute: policyForLimiter.requestsPerMinute,
      });
      await store.reserve({
        identity,
        requestId,
        routeId: route.id,
        operation: operationName,
        costUnits: route.costUnits,
        defaultPolicy,
        policies: declarative.policies,
        leaseMs: runtime.requestLeaseMs,
      });
      reservationCreated = true;
      metrics.start();
      const auditId = getHeader(request, "x-excalidraw-ai-audit-draft");
      if (
        auditId &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          auditId,
        )
      ) {
        throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 400, {
          message: "The audit draft identifier is invalid.",
          retryable: false,
        });
      }

      const contentType = getHeader(request, "content-type").toLowerCase();
      const isJSON = contentType.includes("application/json");
      const maxRequestBytes =
        operation.maxRequestBytes || proxyConfig.maxRequestBytes;
      const declaredLength = declaredBodyLength(request);
      if (declaredLength != null && declaredLength > maxRequestBytes) {
        throw new GatewayError("AI_GATEWAY_REQUEST_TOO_LARGE", 413, {
          retryable: false,
        });
      }
      let body: Buffer | undefined;
      let bodyStream: Readable | undefined;
      let startBodyStream: (() => void) | undefined;
      if (method !== "GET" && method !== "HEAD") {
        if (isJSON) {
          body = await readBody(request, maxRequestBytes);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString("utf8") || "{}");
          } catch (error) {
            throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 400, {
              retryable: false,
              cause: error,
            });
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 400, {
              message: "Managed gateway JSON bodies must be objects.",
              retryable: false,
            });
          }
          if (
            Object.prototype.hasOwnProperty.call(parsed, "model") ||
            !route.wireProtocol.toLowerCase().includes("gemini")
          ) {
            parsed = {
              ...(parsed as Record<string, unknown>),
              model: route.model,
            };
          }
          body = Buffer.from(JSON.stringify(parsed));
          if (body.byteLength > maxRequestBytes) {
            throw new GatewayError("AI_GATEWAY_REQUEST_TOO_LARGE", 413, {
              retryable: false,
            });
          }
        } else {
          const limited = new LimitedBodyTransform(maxRequestBytes);
          limited.once("error", () => {
            request.unpipe(limited);
            request.resume();
          });
          let started = false;
          startBodyStream = () => {
            if (!started) {
              started = true;
              request.pipe(limited);
            }
          };
          bodyStream = limited;
        }
      }
      if (auditId) {
        if (
          !runtime.auditContentEnabled ||
          !(await store.getAuditConsent(identity))
        ) {
          throw new GatewayError("AI_GATEWAY_AUDIT_DISABLED", 403, {
            retryable: false,
          });
        }
        const bound = await store.bindAudit(
          identity,
          auditId,
          requestId,
          route.id,
        );
        if (!bound) {
          throw new GatewayError("AI_GATEWAY_INVALID_REQUEST", 400, {
            message:
              "The audit draft is missing, expired, deleted, or already used.",
            retryable: false,
          });
        }
      }
      const replayable =
        method === "GET" ||
        method === "HEAD" ||
        (operation.replayable === true &&
          isJSON &&
          !!body &&
          body.byteLength <= MAX_REPLAY_BODY_BYTES);
      const candidates = router.candidates(route).slice(0, replayable ? 2 : 1);
      let providerResponse: Awaited<
        ReturnType<typeof requestGatewayCandidate>
      > | null = null;
      let lastError: unknown = null;
      const markDispatched = async () => {
        if (dispatched) {
          // A safe replay after a provider 5xx belongs to the same reserved
          // ledger entry. Calling the store a second time would turn a
          // legitimate backup attempt into a false reservation-expired
          // failure.
          return true;
        }
        const accepted = await store.markDispatched(requestId);
        if (!accepted) {
          throw new GatewayError("AI_GATEWAY_RESERVATION_EXPIRED", 503, {
            retryable: true,
          });
        }
        dispatched = true;
        return true;
      };
      // A client disconnect must abort a provider request even if no provider
      // response headers have arrived yet. The timeout is scoped to this
      // invocation and is shared by any safe replay attempt.
      const requestAbortController = new AbortController();
      const abortForClient = () =>
        requestAbortController.abort(new Error("The client disconnected."));
      request.once("aborted", abortForClient);
      response.once("close", () => {
        if (!response.writableEnded) {
          abortForClient();
        }
      });
      const timeoutSignal = AbortSignal.timeout(proxyConfig.requestTimeoutMs);
      const abortFromTimeout = () =>
        requestAbortController.abort(timeoutSignal.reason);
      timeoutSignal.addEventListener("abort", abortFromTimeout, {
        once: true,
      });
      const invocationSignal: AbortSignal = requestAbortController.signal;
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        providerAttempts += 1;
        try {
          const targetURL = router.buildTarget(
            candidate,
            operation,
            Object.fromEntries(url.searchParams),
            url.searchParams,
            { model: route.model },
          );
          providerResponse = await requestGatewayCandidate({
            targetURL,
            operation,
            candidate,
            incomingHeaders: request.headers,
            body,
            bodyStream,
            startBodyStream,
            credentialVault,
            proxyConfig,
            signal: invocationSignal,
            onDispatched: markDispatched,
          });
          const status = providerResponse.response.statusCode || 502;
          if (status >= 500) {
            router.markFailure(route, candidate);
            // The response headers have not been sent to the browser yet. For
            // For an idempotent GET/HEAD or a bounded, replayable JSON request
            // it is safe to discard this provider response and try one
            // same-protocol backup candidate.
            // Streaming, multipart, media, and already-started responses are
            // intentionally never replayed (they never enter this branch).
            if (
              index + 1 < candidates.length &&
              (method === "GET" ||
                method === "HEAD" ||
                (replayable &&
                  isJSON &&
                  !!body &&
                  body.byteLength <= MAX_REPLAY_BODY_BYTES))
            ) {
              providerResponse.response.destroy();
              providerResponse.request.destroy();
              providerResponse = null;
              metrics.failover();
              continue;
            }
          } else {
            router.markSuccess(route, candidate);
          }
          break;
        } catch (error) {
          lastError = error;
          const gatewayError = toGatewayError(error);
          if (requestAbortController.signal.aborted) {
            throw gatewayError;
          }
          if (gatewayError.code !== "AI_GATEWAY_RESERVATION_EXPIRED") {
            router.markFailure(route, candidate);
          }
          if (gatewayError.code === "AI_GATEWAY_RESERVATION_EXPIRED") {
            throw gatewayError;
          }
          if (index + 1 < candidates.length) {
            metrics.failover();
            continue;
          }
        }
      }
      if (!providerResponse) {
        throw (
          lastError || new GatewayError("AI_GATEWAY_UPSTREAM_UNAVAILABLE", 502)
        );
      }

      const upstream = providerResponse.response;
      response.statusCode = upstream.statusCode || 502;
      if (upstream.statusMessage) {
        response.statusMessage = upstream.statusMessage;
      }
      copyGatewayResponseHeaders(upstream, response);
      applyGatewayHeaders(response, requestId, origin);
      let responseBytes = 0;
      let completed = false;
      const finish = async (status: "succeeded" | "failed" | "aborted") => {
        if (completed) {
          return;
        }
        completed = true;
        try {
          await store.finish({
            requestId,
            status,
            providerAttempts,
            responseBytes,
            durationMs: Date.now() - startedAt,
            ...(status === "failed"
              ? { errorCode: `HTTP_${response.statusCode}` }
              : {}),
          });
        } catch {
          // A ledger failure must not turn a completed provider stream into an
          // unhandled rejection or make the response handler crash.
        }
        metrics.finish(route.id, response.statusCode, responseBytes);
      };
      upstream.on("data", (chunk: Buffer) => {
        responseBytes += chunk.byteLength;
      });
      upstream.once("end", () => {
        void finish(response.statusCode < 400 ? "succeeded" : "failed").catch(
          () => undefined,
        );
      });
      upstream.once("error", () => {
        void finish("failed").catch(() => undefined);
        response.destroy();
      });
      response.once("close", () => {
        if (!response.writableEnded) {
          upstream.destroy();
          providerResponse?.request.destroy();
          void finish("aborted").catch(() => undefined);
        }
      });
      upstream.pipe(response);
    } catch (unknownError) {
      const error = toGatewayError(unknownError);
      if (
        error.code === "AI_GATEWAY_QUOTA_EXCEEDED" ||
        error.code === "AI_GATEWAY_CONCURRENCY_EXCEEDED" ||
        error.code === "AI_GATEWAY_RATE_LIMITED"
      ) {
        metrics.denyQuota();
      }
      if (reservationCreated) {
        if (dispatched) {
          try {
            await store.finish({
              requestId,
              status: "failed",
              providerAttempts,
              responseBytes: 0,
              durationMs: Date.now() - startedAt,
              errorCode: error.code,
            });
          } catch {
            // Keep the stable gateway error response even if the ledger is
            // temporarily unavailable while recording the failed request.
          }
          metrics.finish(routeIdForMetrics, error.status, 0);
        } else {
          try {
            await store.release(requestId, error.code);
          } catch {
            // Releasing a reservation is best effort on an already-failed
            // request; never leak a store rejection to the HTTP server.
          }
          metrics.finish(routeIdForMetrics, error.status, 0);
        }
      }
      if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
      }
      applyGatewayHeaders(response, requestId, origin);
      response.setHeader("X-Excalidraw-AI-Gateway-Error", error.code);
      sendJSON(
        response,
        error.status,
        createGatewayErrorBody(error, requestId),
      );
      request.resume();
    }
  };
};

export const createGatewayAuthenticator = GatewayAuthenticator;
