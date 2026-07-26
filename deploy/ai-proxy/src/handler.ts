import crypto from "node:crypto";
import http from "node:http";

import {
  createAIProxyErrorBody,
  AIProxyError,
  toAIProxyError,
} from "./errors.js";
import {
  applyCORSResponseHeaders,
  applyPreflightHeaders,
  copyUpstreamResponseHeaders,
  isAllowedPreflightHeader,
} from "./headers.js";
import { consoleAIProxyLogger } from "./logger.js";
import { forwardUpstreamRequest } from "./upstream.js";

import type { IncomingMessage, ServerResponse } from "node:http";

import type { AIProxyConfig } from "./config.js";
import type { AIProxyLogger } from "./logger.js";

const FORWARD_PATH = "/ai-proxy/v1/forward";
const HEALTH_PATHS = new Set(["/healthz", "/ai-proxy/healthz"]);
const READY_PATHS = new Set(["/readyz", "/ai-proxy/readyz"]);
const ALLOWED_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

const getSingleHeader = (request: IncomingMessage, name: string) => {
  const value = request.headers[name];

  return typeof value === "string" ? value : "";
};

const createRequestId = (request: IncomingMessage) => {
  const requested = getSingleHeader(request, "x-excalidraw-ai-request-id");

  return /^[a-zA-Z0-9-]{8,80}$/.test(requested)
    ? requested
    : crypto.randomUUID();
};

const normalizeOrigin = (rawOrigin: string) => {
  try {
    const url = new URL(rawOrigin);
    return url.origin === rawOrigin ? url.origin : "";
  } catch {
    return "";
  }
};

const validateOrigin = (request: IncomingMessage, config: AIProxyConfig) => {
  const rawOrigin = getSingleHeader(request, "origin");

  if (!rawOrigin) {
    if (getSingleHeader(request, "sec-fetch-site") === "cross-site") {
      throw new AIProxyError("AI_PROXY_ORIGIN_DENIED", 403, {
        retryable: false,
      });
    }

    return null;
  }

  const origin = normalizeOrigin(rawOrigin);

  if (!origin || !config.allowedOrigins.has(origin)) {
    throw new AIProxyError("AI_PROXY_ORIGIN_DENIED", 403, {
      retryable: false,
    });
  }

  return origin;
};

const hashToken = (value: string) => {
  return crypto.createHash("sha256").update(value).digest();
};

const tokenMatches = (candidate: string, tokens: readonly string[]) => {
  const candidateHash = hashToken(candidate);
  let matched = 0;

  for (const token of tokens) {
    matched |= crypto.timingSafeEqual(candidateHash, hashToken(token)) ? 1 : 0;
  }

  return matched === 1;
};

const validateToken = (request: IncomingMessage, config: AIProxyConfig) => {
  if (!config.requireClientToken) {
    return;
  }

  const token = getSingleHeader(request, "x-excalidraw-ai-proxy-token");

  if (!token) {
    throw new AIProxyError("AI_PROXY_TOKEN_REQUIRED", 401, {
      retryable: false,
    });
  }

  if (!tokenMatches(token, config.clientTokens)) {
    throw new AIProxyError("AI_PROXY_TOKEN_INVALID", 403, {
      retryable: false,
    });
  }
};

const applyProxyMarkerHeaders = (
  response: ServerResponse,
  requestId: string,
) => {
  response.setHeader("X-Excalidraw-AI-Proxy", "1");
  response.setHeader("X-Excalidraw-AI-Request-ID", requestId);
};

const sendJSON = (response: ServerResponse, status: number, body: unknown) => {
  const payload = Buffer.from(JSON.stringify(body));
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", String(payload.byteLength));
  response.end(payload);
};

const sendProxyError = ({
  request,
  response,
  requestId,
  origin,
  error,
  logger,
  startedAt,
}: {
  request: IncomingMessage;
  response: ServerResponse;
  requestId: string;
  origin: string | null;
  error: AIProxyError;
  logger: AIProxyLogger;
  startedAt: number;
}) => {
  if (response.headersSent || response.destroyed) {
    response.destroy();
    return;
  }

  applyProxyMarkerHeaders(response, requestId);
  response.setHeader("X-Excalidraw-AI-Proxy-Error", error.code);
  applyCORSResponseHeaders(response, origin);
  sendJSON(response, error.status, createAIProxyErrorBody(error, requestId));
  request.resume();
  logger.info({
    requestId,
    method: (request.method || "GET").toUpperCase(),
    status: error.status,
    durationMs: Date.now() - startedAt,
    errorCode: error.code,
  });
};

const parseRequestedHeaders = (request: IncomingMessage) => {
  const raw = getSingleHeader(request, "access-control-request-headers");

  return raw
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
};

const handlePreflight = (
  request: IncomingMessage,
  response: ServerResponse,
  config: AIProxyConfig,
) => {
  const origin = validateOrigin(request, config);
  const requestedMethod = getSingleHeader(
    request,
    "access-control-request-method",
  ).toUpperCase();
  const requestedHeaders = parseRequestedHeaders(request);

  if (!origin || !ALLOWED_METHODS.has(requestedMethod)) {
    throw new AIProxyError("AI_PROXY_METHOD_NOT_ALLOWED", 405, {
      retryable: false,
    });
  }

  if (requestedHeaders.some((header) => !isAllowedPreflightHeader(header))) {
    throw new AIProxyError("AI_PROXY_ORIGIN_DENIED", 403, {
      retryable: false,
    });
  }

  applyPreflightHeaders(response, origin, requestedMethod, requestedHeaders);
  response.statusCode = 204;
  response.end();
};

export const createAIProxyHandler = (
  config: AIProxyConfig,
  logger: AIProxyLogger = consoleAIProxyLogger,
) => {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const startedAt = Date.now();
    const requestId = createRequestId(request);
    const path = new URL(request.url || "/", "http://ai-proxy.local").pathname;
    const method = (request.method || "GET").toUpperCase();
    let origin: string | null = null;

    try {
      if (HEALTH_PATHS.has(path)) {
        if (method !== "GET") {
          throw new AIProxyError("AI_PROXY_METHOD_NOT_ALLOWED", 405, {
            retryable: false,
          });
        }

        sendJSON(response, 200, { status: "ok" });
        return;
      }

      if (path === FORWARD_PATH && method === "OPTIONS") {
        handlePreflight(request, response, config);
        return;
      }

      if (path !== FORWARD_PATH && !READY_PATHS.has(path)) {
        sendJSON(response, 404, { error: { code: "NOT_FOUND" } });
        return;
      }

      origin = validateOrigin(request, config);
      validateToken(request, config);

      if (READY_PATHS.has(path)) {
        if (method !== "GET") {
          throw new AIProxyError("AI_PROXY_METHOD_NOT_ALLOWED", 405, {
            retryable: false,
          });
        }

        applyProxyMarkerHeaders(response, requestId);
        applyCORSResponseHeaders(response, origin);
        sendJSON(response, 200, { status: "ready", requestId });
        return;
      }

      if (!ALLOWED_METHODS.has(method)) {
        throw new AIProxyError("AI_PROXY_METHOD_NOT_ALLOWED", 405, {
          retryable: false,
        });
      }

      const targetURL = getSingleHeader(request, "x-excalidraw-ai-target");

      if (!targetURL) {
        throw new AIProxyError("AI_PROXY_TARGET_MISSING", 400, {
          retryable: false,
        });
      }

      const abortController = new AbortController();
      let clientAborted = false;
      const abortUpstream = () => {
        clientAborted = true;
        abortController.abort(new Error("The client disconnected."));
      };
      request.once("aborted", abortUpstream);
      response.once("close", () => {
        if (!response.writableEnded) {
          abortUpstream();
        }
      });

      const upstream = await forwardUpstreamRequest({
        request,
        targetURL,
        config,
        signal: abortController.signal,
      });

      response.statusCode = upstream.response.statusCode || 502;
      if (upstream.response.statusMessage) {
        response.statusMessage = upstream.response.statusMessage;
      }
      copyUpstreamResponseHeaders(upstream.response, response);
      applyProxyMarkerHeaders(response, requestId);
      applyCORSResponseHeaders(response, origin);

      let responseBytes = 0;
      upstream.response.on("data", (chunk: Buffer) => {
        responseBytes += chunk.byteLength;
      });
      upstream.response.once("error", () => {
        response.destroy();
      });
      response.once("finish", () => {
        logger.info({
          requestId,
          method,
          status: response.statusCode,
          durationMs: Date.now() - startedAt,
          ...(config.logTargetHostname
            ? { targetHostname: upstream.target.hostname }
            : {}),
          responseBytes,
          clientAborted,
        });
      });
      upstream.response.pipe(response);
    } catch (error) {
      sendProxyError({
        request,
        response,
        requestId,
        origin,
        error: toAIProxyError(error),
        logger,
        startedAt,
      });
    }
  };
};

export const createAIProxyServer = (
  config: AIProxyConfig,
  logger: AIProxyLogger = consoleAIProxyLogger,
) => {
  const server = http.createServer(createAIProxyHandler(config, logger));

  server.on("connect", (_request, socket) => socket.destroy());
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("clientError", (_error, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    }
  });

  return server;
};
