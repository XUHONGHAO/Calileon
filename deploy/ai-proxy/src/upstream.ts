import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Transform, pipeline } from "node:stream";

import ipaddr from "ipaddr.js";

import { createPinnedLookup } from "./dnsPin.js";
import { AIProxyError } from "./errors.js";
import { buildUpstreamRequestHeaders } from "./headers.js";
import { resolveTarget } from "./targetPolicy.js";

import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";

import type { AIProxyConfig } from "./config.js";
import type { ResolvedTarget } from "./targetPolicy.js";

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

type UpstreamResponse = {
  request: ClientRequest;
  response: IncomingMessage;
  target: ResolvedTarget;
  cleanup: () => void;
};

export type ForwardedUpstreamResponse = UpstreamResponse & {
  redirectCount: number;
};

class RequestBodyLimitTransform extends Transform {
  private totalBytes = 0;

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
    this.totalBytes += buffer.byteLength;

    if (this.totalBytes > this.maxBytes) {
      callback(
        new AIProxyError("AI_PROXY_REQUEST_TOO_LARGE", 413, {
          retryable: false,
        }),
      );
      return;
    }

    callback(null, buffer);
  }
}

const normalizeAddress = (address: string) => {
  try {
    return ipaddr.process(address).toNormalizedString();
  } catch {
    return address;
  }
};

const addressesMatch = (actual: string | undefined, expected: string) => {
  return !!actual && normalizeAddress(actual) === normalizeAddress(expected);
};

const mapUpstreamError = (error: unknown) => {
  if (error instanceof AIProxyError) {
    return error;
  }

  const code =
    typeof error === "object" && error && "code" in error
      ? String((error as { code?: unknown }).code || "")
      : "";
  const protocolError =
    code.startsWith("HPE_") || code.startsWith("ERR_TLS") || code === "EPROTO";

  return new AIProxyError(
    protocolError
      ? "AI_PROXY_UPSTREAM_PROTOCOL_ERROR"
      : "AI_PROXY_UPSTREAM_UNREACHABLE",
    502,
    { cause: error },
  );
};

const requestOnce = ({
  incomingRequest,
  target,
  method,
  includeBody,
  includeProviderCredentials,
  config,
  signal,
}: {
  incomingRequest: IncomingMessage;
  target: ResolvedTarget;
  method: string;
  includeBody: boolean;
  includeProviderCredentials: boolean;
  config: AIProxyConfig;
  signal?: AbortSignal;
}) => {
  return new Promise<UpstreamResponse>((resolve, reject) => {
    let settled = false;
    let connectTimer: NodeJS.Timeout | null = null;
    let requestTimer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (requestTimer) {
        clearTimeout(requestTimer);
        requestTimer = null;
      }
      signal?.removeEventListener("abort", abortRequest);
    };

    const fail = (error: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(mapUpstreamError(error));
    };

    const headers = buildUpstreamRequestHeaders(
      incomingRequest.headers,
      target.url,
      includeBody,
      includeProviderCredentials,
    );
    const requestOptions: RequestOptions = {
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
    const upstreamRequest = transport.request(
      requestOptions,
      (upstreamResponse) => {
        if (settled) {
          upstreamResponse.destroy();
          return;
        }

        settled = true;
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        upstreamResponse.setTimeout(config.idleTimeoutMs, () => {
          upstreamResponse.destroy(new AIProxyError("AI_PROXY_TIMEOUT", 504));
        });
        const finish = () => cleanup();
        upstreamResponse.once("end", finish);
        upstreamResponse.once("close", finish);
        upstreamResponse.once("error", finish);
        resolve({
          request: upstreamRequest,
          response: upstreamResponse,
          target,
          cleanup,
        });
      },
    );

    const abortRequest = () => {
      upstreamRequest.destroy(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("The client aborted the request."),
      );
    };

    signal?.addEventListener("abort", abortRequest, { once: true });
    if (signal?.aborted) {
      abortRequest();
    }

    upstreamRequest.once("error", fail);
    upstreamRequest.once("socket", (socket) => {
      const connectedEvent =
        target.url.protocol === "https:" ? "secureConnect" : "connect";
      connectTimer = setTimeout(() => {
        upstreamRequest.destroy(new AIProxyError("AI_PROXY_TIMEOUT", 504));
      }, config.connectTimeoutMs);
      connectTimer.unref();

      socket.once(connectedEvent, () => {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }

        if (!addressesMatch(socket.remoteAddress, target.address)) {
          upstreamRequest.destroy(
            new AIProxyError("AI_PROXY_TARGET_BLOCKED", 403, {
              retryable: false,
            }),
          );
        }
      });
    });

    requestTimer = setTimeout(() => {
      upstreamRequest.destroy(new AIProxyError("AI_PROXY_TIMEOUT", 504));
    }, config.requestTimeoutMs);
    requestTimer.unref();

    if (includeBody) {
      const limiter = new RequestBodyLimitTransform(config.maxRequestBytes);

      pipeline(incomingRequest, limiter, upstreamRequest, (error) => {
        if (error && !upstreamRequest.destroyed) {
          upstreamRequest.destroy(error);
        }
      });
    } else {
      upstreamRequest.end();
    }
  });
};

const hasBodyMethod = (method: string) => {
  return method !== "GET" && method !== "HEAD";
};

const assertContentLengthWithinLimit = (
  request: IncomingMessage,
  maxRequestBytes: number,
) => {
  const rawLength = request.headers["content-length"];
  const contentLength =
    typeof rawLength === "string" ? Number(rawLength.trim()) : NaN;

  if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
    throw new AIProxyError("AI_PROXY_REQUEST_TOO_LARGE", 413, {
      retryable: false,
    });
  }
};

const discardRedirectResponse = (upstream: UpstreamResponse) => {
  upstream.cleanup();
  upstream.response.destroy();
  upstream.request.destroy();
};

export const forwardUpstreamRequest = async ({
  request,
  targetURL,
  config,
  signal,
}: {
  request: IncomingMessage;
  targetURL: string;
  config: AIProxyConfig;
  signal?: AbortSignal;
}): Promise<ForwardedUpstreamResponse> => {
  const initialMethod = (request.method || "GET").toUpperCase();
  const initialHasBody = hasBodyMethod(initialMethod);

  if (initialHasBody) {
    assertContentLengthWithinLimit(request, config.maxRequestBytes);
  }

  let method = initialMethod;
  let includeBody = initialHasBody;
  let currentURL = targetURL;
  let redirectCount = 0;
  let credentialOrigin: string | null = null;
  const visited = new Set<string>();

  for (;;) {
    const target = await resolveTarget(currentURL, config);
    credentialOrigin ||= target.url.origin;

    if (visited.has(target.url.href)) {
      throw new AIProxyError("AI_PROXY_REDIRECT_LIMIT", 508, {
        retryable: false,
      });
    }
    visited.add(target.url.href);

    const upstream = await requestOnce({
      incomingRequest: request,
      target,
      method,
      includeBody,
      includeProviderCredentials: target.url.origin === credentialOrigin,
      config,
      signal,
    });
    const status = upstream.response.statusCode || 502;
    const location = upstream.response.headers.location;

    if (!REDIRECT_STATUS_CODES.has(status) || !location) {
      return { ...upstream, redirectCount };
    }

    if (redirectCount >= config.maxRedirects) {
      discardRedirectResponse(upstream);
      throw new AIProxyError("AI_PROXY_REDIRECT_LIMIT", 508, {
        retryable: false,
      });
    }

    let nextURL: URL;

    try {
      nextURL = new URL(location, target.url);
    } catch (error) {
      discardRedirectResponse(upstream);
      throw new AIProxyError("AI_PROXY_TARGET_INVALID", 400, {
        retryable: false,
        cause: error,
      });
    }

    if (target.url.protocol === "https:" && nextURL.protocol !== "https:") {
      discardRedirectResponse(upstream);
      throw new AIProxyError("AI_PROXY_TARGET_BLOCKED", 403, {
        retryable: false,
      });
    }

    if (includeBody && status !== 303) {
      discardRedirectResponse(upstream);
      throw new AIProxyError("AI_PROXY_REDIRECT_REQUIRES_FINAL_URL", 502, {
        retryable: false,
      });
    }

    discardRedirectResponse(upstream);
    redirectCount += 1;
    currentURL = nextURL.href;

    if (status === 303 && method !== "HEAD") {
      method = "GET";
      includeBody = false;
    }
  }
};
