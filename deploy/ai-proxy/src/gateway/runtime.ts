import crypto from "node:crypto";

import { GatewayAuthenticator, JwksVerifier } from "./auth.js";
import {
  loadGatewayDeclarativeConfig,
  loadGatewayRuntimeConfig,
} from "./config.js";
import {
  AwsKmsDataKeyProvider,
  EnvelopeCipher,
  LocalKekProvider,
} from "./crypto.js";
import { createGatewayErrorBody, GatewayError } from "./errors.js";
import { GatewayCredentialVault } from "./credentials.js";
import { createGatewayHandler } from "./handler.js";
import { PostgresGatewayStore } from "./store.js";

import type { AIProxyConfig } from "../config.js";
import type { GatewayHttpHandler } from "./types.js";

const getRequestId = (request: import("node:http").IncomingMessage) => {
  const value = request.headers["x-excalidraw-ai-request-id"];
  const requested = Array.isArray(value) ? value[0] : value;
  return typeof requested === "string" && /^[a-zA-Z0-9-]{8,80}$/.test(requested)
    ? requested
    : crypto.randomUUID();
};

/**
 * Keep the thin BYOK proxy available when the optional managed deployment is
 * misconfigured. Managed requests remain fail-closed with a stable 503
 * contract instead of preventing the whole process from starting.
 */
export const createUnavailableGatewayHandler = (
  allowedOrigins: ReadonlySet<string> = new Set(),
  gatewayError = new GatewayError("AI_GATEWAY_NOT_READY", 503),
): GatewayHttpHandler => {
  return async (request, response) => {
    const requestId = getRequestId(request);
    response.statusCode = gatewayError.status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Excalidraw-AI-Gateway", "1");
    response.setHeader("X-Excalidraw-AI-Gateway-Error", gatewayError.code);
    response.setHeader("X-Excalidraw-AI-Request-ID", requestId);
    response.setHeader(
      "Access-Control-Expose-Headers",
      "X-Excalidraw-AI-Gateway, X-Excalidraw-AI-Gateway-Error, X-Excalidraw-AI-Request-ID",
    );
    response.setHeader("Vary", "Origin");
    const origin = request.headers.origin;
    if (typeof origin === "string" && allowedOrigins.has(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
    }
    response.end(
      JSON.stringify(createGatewayErrorBody(gatewayError, requestId)),
    );
    request.resume();
  };
};

export const createGatewayRuntime = (proxyConfig: AIProxyConfig) => {
  const runtime = loadGatewayRuntimeConfig(process.env, proxyConfig.production);
  if (!runtime.enabled) {
    return null;
  }
  const declarative = loadGatewayDeclarativeConfig(
    runtime.routeConfigPath,
    runtime.production,
  );
  const store = new PostgresGatewayStore(runtime.databaseUrl);
  const keyProvider =
    runtime.kmsProvider === "aws-kms"
      ? new AwsKmsDataKeyProvider(runtime.kmsKeyId)
      : new LocalKekProvider(runtime.localKek);
  const cipher = new EnvelopeCipher(keyProvider);
  const verifier = new JwksVerifier({
    jwksUrl: runtime.jwksUrl,
    issuer: runtime.issuer,
    audience: runtime.audience,
    algorithms: runtime.algorithms,
    cacheMs: runtime.credentialCacheMs,
  });
  const authenticator = new GatewayAuthenticator(verifier, store);
  const credentialVault = new GatewayCredentialVault(
    store,
    cipher,
    runtime.credentialCacheMs,
  );
  const handler = createGatewayHandler({
    runtime,
    declarative,
    store,
    authenticator,
    cipher,
    credentialVault,
    proxyConfig,
    checkReady: async () => {
      try {
        const [databaseReady, authReady] = await Promise.all([
          store.checkReady(),
          authenticator.checkReady(),
        ]);
        return databaseReady && authReady;
      } catch {
        return false;
      }
    },
  });
  const purgeTimer = setInterval(() => {
    void store.purgeExpired(Date.now()).catch(() => undefined);
  }, 60 * 60_000);
  purgeTimer.unref();
  return {
    handler,
    close: async () => {
      clearInterval(purgeTimer);
      credentialVault.clear();
      await store.close();
    },
    checkReady: async () => {
      try {
        const [databaseReady, authReady] = await Promise.all([
          store.checkReady(),
          authenticator.checkReady(),
        ]);
        return databaseReady && authReady;
      } catch {
        return false;
      }
    },
  };
};
