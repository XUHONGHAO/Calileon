import http from "node:http";
import https from "node:https";
import net from "node:net";

import ipaddr from "ipaddr.js";

import { createPinnedLookup } from "../dnsPin.js";
import { copyUpstreamResponseHeaders } from "../headers.js";
import { resolveTarget } from "../targetPolicy.js";

import { GatewayError } from "./errors.js";

import type {
  IncomingHttpHeaders,
  IncomingMessage,
  RequestOptions,
} from "node:http";
import type { Readable } from "node:stream";

import type { AIProxyConfig } from "../config.js";
import type { GatewayCredentialVault } from "./credentials.js";
import type { GatewayOperationConfig, GatewayRouteCandidate } from "./types.js";

const SAFE_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "anthropic-version",
  "openai-organization",
  "openai-project",
  "range",
  "accept-language",
  "user-agent",
]);

const normalizeAddress = (address: string) => {
  try {
    return ipaddr.process(address).toNormalizedString();
  } catch {
    if (address.startsWith("::ffff:")) {
      return address.slice(7);
    }
    return address;
  }
};

const addressesMatch = (actual: string | undefined, expected: string) =>
  !!actual && normalizeAddress(actual) === normalizeAddress(expected);

const mapTargetError = (error: unknown): GatewayError => {
  if (error instanceof GatewayError) {
    return error;
  }
  const code =
    typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code || "")
      : "";
  switch (code) {
    case "AI_PROXY_TARGET_BLOCKED":
      return new GatewayError("AI_GATEWAY_FORBIDDEN", 403, {
        retryable: false,
      });
    case "AI_PROXY_TARGET_INVALID":
      return new GatewayError("AI_GATEWAY_INVALID_REQUEST", 400, {
        retryable: false,
      });
    case "AI_PROXY_REQUEST_TOO_LARGE":
      return new GatewayError("AI_GATEWAY_REQUEST_TOO_LARGE", 413, {
        retryable: false,
      });
    case "AI_PROXY_TIMEOUT":
      return new GatewayError("AI_GATEWAY_UPSTREAM_UNAVAILABLE", 504, {
        retryable: true,
      });
    case "AI_PROXY_DNS_FAILED":
    case "AI_PROXY_UPSTREAM_UNREACHABLE":
    case "AI_PROXY_UPSTREAM_PROTOCOL_ERROR":
      return new GatewayError("AI_GATEWAY_UPSTREAM_UNAVAILABLE", 502, {
        retryable: true,
      });
    case "AI_PROXY_REDIRECT_REQUIRES_FINAL_URL":
      return new GatewayError("AI_GATEWAY_UPSTREAM_UNAVAILABLE", 502, {
        message: "The managed provider requires its final URL.",
        retryable: false,
      });
    case "AI_PROXY_REDIRECT_LIMIT":
      return new GatewayError("AI_GATEWAY_UPSTREAM_UNAVAILABLE", 502, {
        message: "The managed provider redirected too many times.",
        retryable: false,
      });
    default:
      return new GatewayError("AI_GATEWAY_UPSTREAM_UNAVAILABLE", 502, {
        cause: error,
      });
  }
};

const createProviderHeaders = async ({
  incoming,
  candidate,
  credentialVault,
  target,
  contentLength,
  includeCredential,
}: {
  incoming: IncomingHttpHeaders;
  candidate: GatewayRouteCandidate;
  credentialVault: GatewayCredentialVault;
  target: URL;
  contentLength?: number;
  includeCredential: boolean;
}) => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (!SAFE_REQUEST_HEADERS.has(name) || value == null) {
      continue;
    }
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  delete headers.authorization;
  delete headers["x-goog-api-key"];
  delete headers["api-key"];
  if (typeof contentLength === "number") {
    headers["content-length"] = String(contentLength);
  } else {
    delete headers["content-length"];
  }
  // DNS pinning controls where the socket connects; Host and SNI must still
  // carry the configured hostname for virtual-host providers.
  headers.host = target.host;
  headers["user-agent"] = "Excalidraw-AI-Gateway/1";
  if (includeCredential && candidate.credentialHeader !== "none") {
    const secret = await credentialVault.get(candidate.credentialId || "");
    try {
      const value = secret.toString("utf8").trim();
      if (candidate.credentialHeader === "authorization-bearer") {
        headers.authorization = /^Bearer\s+/i.test(value)
          ? value
          : `Bearer ${value}`;
      } else {
        headers[candidate.credentialHeader] = value;
      }
    } finally {
      secret.fill(0);
    }
  }
  return headers;
};

export type GatewayProviderResponse = Readonly<{
  request: http.ClientRequest;
  response: IncomingMessage;
}>;

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REPLAY_BODY_BYTES = 2 * 1024 * 1024;

const redirectFailure = (message: string) =>
  new GatewayError("AI_GATEWAY_UPSTREAM_UNAVAILABLE", 502, {
    message,
    retryable: false,
  });

const destroyProviderResponse = (provider: GatewayProviderResponse) => {
  provider.response.destroy();
  provider.request.destroy();
};

const requestGatewayOnce = async ({
  target,
  method,
  candidate,
  incomingHeaders,
  body,
  bodyStream,
  credentialVault,
  proxyConfig,
  signal,
  onDispatched,
  startBodyStream,
  includeCredential,
}: {
  target: Awaited<ReturnType<typeof resolveTarget>>;
  method: GatewayOperationConfig["method"];
  candidate: GatewayRouteCandidate;
  incomingHeaders: IncomingHttpHeaders;
  body?: Buffer;
  bodyStream?: Readable;
  credentialVault: GatewayCredentialVault;
  proxyConfig: AIProxyConfig;
  signal?: AbortSignal;
  onDispatched?: () => Promise<boolean>;
  startBodyStream?: () => void;
  includeCredential: boolean;
}): Promise<GatewayProviderResponse> => {
  const headers = await createProviderHeaders({
    incoming: incomingHeaders,
    candidate,
    credentialVault,
    target: target.url,
    includeCredential,
    ...(body ? { contentLength: body.byteLength } : {}),
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let dispatchStarted = false;
    let connectTimer: NodeJS.Timeout | undefined;
    let requestTimer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
      if (requestTimer) {
        clearTimeout(requestTimer);
        requestTimer = undefined;
      }
      signal?.removeEventListener("abort", abort);
    };

    const finishError = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error instanceof GatewayError ? error : mapTargetError(error));
    };

    const options: RequestOptions = {
      protocol: target.url.protocol,
      hostname: target.hostname,
      port: target.url.port || undefined,
      path: `${target.url.pathname}${target.url.search}`,
      method,
      headers,
      agent: false,
      lookup: createPinnedLookup(target.address, target.family),
      ...(target.url.protocol === "https:" && !net.isIP(target.hostname)
        ? { servername: target.hostname }
        : {}),
    };
    const transport = target.url.protocol === "https:" ? https : http;

    const providerRequest = transport.request(options, (providerResponse) => {
      if (settled) {
        providerResponse.destroy();
        return;
      }
      // Request bytes are dispatched only after the validated socket and the
      // accounting lease transition complete. Therefore a response here is
      // guaranteed to have a running ledger entry.
      settled = true;
      cleanup();
      providerResponse.setTimeout(proxyConfig.idleTimeoutMs, () => {
        providerResponse.destroy(
          new GatewayError("AI_GATEWAY_UPSTREAM_UNAVAILABLE", 504, {
            retryable: true,
          }),
        );
      });
      providerResponse.once("end", cleanup);
      providerResponse.once("close", cleanup);
      providerResponse.once("error", cleanup);
      resolve({ request: providerRequest, response: providerResponse });
    });

    const abort = () => {
      providerRequest.destroy(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("Gateway request aborted."),
      );
    };

    const dispatch = () => {
      if (dispatchStarted || settled) {
        return;
      }
      dispatchStarted = true;
      if (body) {
        providerRequest.end(body);
      } else if (bodyStream) {
        startBodyStream?.();
        bodyStream.pipe(providerRequest);
      } else {
        providerRequest.end();
      }
    };

    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
    providerRequest.once("error", finishError);
    providerRequest.once("socket", (socket) => {
      const event =
        target.url.protocol === "https:" ? "secureConnect" : "connect";
      socket.once(event, () => {
        if (settled) {
          return;
        }
        if (!addressesMatch(socket.remoteAddress, target.address)) {
          finishError(
            new GatewayError("AI_GATEWAY_FORBIDDEN", 403, {
              message: "The provider connection address changed.",
              retryable: false,
            }),
          );
          providerRequest.destroy();
          return;
        }
        const dispatchAfterAccounting = async () => {
          if (onDispatched) {
            const accepted = await onDispatched();
            if (!accepted) {
              throw new GatewayError("AI_GATEWAY_RESERVATION_EXPIRED", 503, {
                retryable: true,
              });
            }
          }
          dispatch();
        };
        void dispatchAfterAccounting().catch((error) => {
          finishError(error);
          providerRequest.destroy(error instanceof Error ? error : undefined);
        });
      });
    });
    connectTimer = setTimeout(() => {
      providerRequest.destroy(
        new GatewayError("AI_GATEWAY_UPSTREAM_UNAVAILABLE", 504, {
          retryable: true,
        }),
      );
    }, proxyConfig.connectTimeoutMs);
    connectTimer.unref();
    requestTimer = setTimeout(() => {
      providerRequest.destroy(
        new GatewayError("AI_GATEWAY_UPSTREAM_UNAVAILABLE", 504, {
          retryable: true,
        }),
      );
    }, proxyConfig.requestTimeoutMs);
    requestTimer.unref();
    bodyStream?.once("error", (error) => {
      if (!providerRequest.destroyed) {
        providerRequest.destroy(error instanceof Error ? error : undefined);
      }
    });
  });
};

export const requestGatewayCandidate = async ({
  targetURL,
  operation,
  candidate,
  incomingHeaders,
  body,
  bodyStream,
  credentialVault,
  proxyConfig,
  signal,
  onDispatched,
  startBodyStream,
}: {
  targetURL: string;
  operation: GatewayOperationConfig;
  candidate: GatewayRouteCandidate;
  incomingHeaders: IncomingHttpHeaders;
  body?: Buffer;
  bodyStream?: Readable;
  credentialVault: GatewayCredentialVault;
  proxyConfig: AIProxyConfig;
  signal?: AbortSignal;
  onDispatched(): Promise<boolean>;
  startBodyStream?: () => void;
}): Promise<GatewayProviderResponse> => {
  let currentURL = targetURL;
  let method = operation.method;
  let currentBody = body;
  let currentBodyStream = bodyStream;
  let redirectCount = 0;
  let credentialOrigin: string | null = null;
  let accountingNotified = false;
  const canReplayBody =
    !!body &&
    operation.replayable === true &&
    body.byteLength <= MAX_REPLAY_BODY_BYTES;
  const visited = new Set<string>();
  const dispatchAccounting = async () => {
    if (accountingNotified) {
      return true;
    }
    const accepted = await onDispatched();
    accountingNotified = accepted;
    return accepted;
  };

  for (;;) {
    let target: Awaited<ReturnType<typeof resolveTarget>>;
    try {
      target = await resolveTarget(currentURL, proxyConfig);
    } catch (error) {
      throw mapTargetError(error);
    }
    if (visited.has(target.url.href)) {
      throw redirectFailure("The managed provider redirected in a loop.");
    }
    visited.add(target.url.href);
    credentialOrigin ||= target.url.origin;

    const provider = await requestGatewayOnce({
      target,
      method,
      candidate,
      incomingHeaders,
      ...(currentBody ? { body: currentBody } : {}),
      ...(currentBodyStream ? { bodyStream: currentBodyStream } : {}),
      credentialVault,
      proxyConfig,
      signal,
      includeCredential: target.url.origin === credentialOrigin,
      onDispatched: dispatchAccounting,
      startBodyStream,
    });

    const status = provider.response.statusCode || 502;
    const location = provider.response.headers.location;
    if (!REDIRECT_STATUS_CODES.has(status) || !location) {
      return provider;
    }

    if (redirectCount >= proxyConfig.maxRedirects) {
      destroyProviderResponse(provider);
      throw redirectFailure("The managed provider redirected too many times.");
    }

    let nextURL: URL;
    try {
      nextURL = new URL(location, target.url);
    } catch (error) {
      destroyProviderResponse(provider);
      throw new GatewayError("AI_GATEWAY_UPSTREAM_UNAVAILABLE", 502, {
        message: "The managed provider returned an invalid redirect.",
        retryable: false,
        cause: error,
      });
    }
    if (target.url.protocol === "https:" && nextURL.protocol !== "https:") {
      destroyProviderResponse(provider);
      throw new GatewayError("AI_GATEWAY_FORBIDDEN", 403, {
        message: "The managed provider attempted to downgrade HTTPS.",
        retryable: false,
      });
    }

    const hasBody = !!currentBody || !!currentBodyStream;
    if (
      (currentBodyStream && status !== 303) ||
      (hasBody && !currentBodyStream && !canReplayBody)
    ) {
      destroyProviderResponse(provider);
      throw redirectFailure(
        "The managed provider redirected a non-replayable request.",
      );
    }

    destroyProviderResponse(provider);
    redirectCount += 1;
    currentURL = nextURL.href;
    currentBodyStream = undefined;
    if (
      status === 303 ||
      ((status === 301 || status === 302) && method === "POST")
    ) {
      method = "GET";
      currentBody = undefined;
    }
  }
};

export const copyGatewayResponseHeaders = (
  upstream: IncomingMessage,
  response: import("node:http").ServerResponse,
) => {
  copyUpstreamResponseHeaders(upstream, response);
  // A managed redirect is followed above. Do not hand a provider/CDN URL to
  // the browser in an otherwise successful response either.
  response.removeHeader("location");
  response.removeHeader("content-location");
};
