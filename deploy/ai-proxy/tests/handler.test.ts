import http from "node:http";
import { once } from "node:events";

import { createAIProxyServer } from "../src/handler.js";

import type { AddressInfo } from "node:net";

import type { AIProxyConfig } from "../src/config.js";
import type { AIProxyLogEntry, AIProxyLogger } from "../src/logger.js";

const APP_ORIGIN = "http://app.test";
const CLIENT_TOKEN = "proxy-client-token";

const createConfig = (
  overrides: Partial<AIProxyConfig> = {},
): AIProxyConfig => ({
  port: 0,
  production: false,
  allowedOrigins: new Set([APP_ORIGIN]),
  requireClientToken: true,
  clientTokens: [CLIENT_TOKEN],
  allowHttpLocalhost: true,
  connectTimeoutMs: 2_000,
  requestTimeoutMs: 5_000,
  idleTimeoutMs: 2_000,
  maxRequestBytes: 1024 * 1024,
  maxRedirects: 5,
  shutdownGraceMs: 1_000,
  logTargetHostname: true,
  ...overrides,
});

const listen = async (server: http.Server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
};

const close = async (server: http.Server) => {
  server.close();
  await once(server, "close");
};

const createProvider = () => {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://provider.local");
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }

    if (url.pathname === "/redirect-get") {
      response.writeHead(302, { Location: "/final" });
      response.end();
      return;
    }
    if (url.pathname === "/redirect-post") {
      response.writeHead(307, { Location: "/final" });
      response.end();
      return;
    }
    if (url.pathname === "/redirect-blocked") {
      response.writeHead(302, { Location: "http://10.0.0.1/private" });
      response.end();
      return;
    }
    if (url.pathname === "/provider-error") {
      response.writeHead(429, {
        Connection: "X-Hop-Response",
        "Content-Type": "application/json",
        "Set-Cookie": "provider=secret",
        "Access-Control-Allow-Origin": "*",
        "X-Hop-Response": "remove-me",
        "X-Excalidraw-AI-Proxy": "provider-marker",
        "X-Excalidraw-AI-Proxy-Error": "AI_PROXY_TOKEN_INVALID",
        "X-Excalidraw-AI-Request-ID": "provider-request-id",
      });
      response.end(JSON.stringify({ error: { message: "rate limited" } }));
      return;
    }

    response.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": "provider=secret",
      "Access-Control-Allow-Origin": "https://provider.example",
    });
    response.end(
      JSON.stringify({
        path: url.pathname,
        method: request.method,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }),
    );
  });
};

const proxyFetch = (
  proxyPort: number,
  providerURL: string,
  init: RequestInit = {},
) => {
  return fetch(`http://127.0.0.1:${proxyPort}/ai-proxy/v1/forward`, {
    ...init,
    headers: {
      Origin: APP_ORIGIN,
      "X-Excalidraw-AI-Target": providerURL,
      "X-Excalidraw-AI-Proxy-Token": CLIENT_TOKEN,
      ...(init.headers || {}),
    },
  });
};

describe("AI proxy handler", () => {
  let provider: http.Server;
  let proxy: http.Server;
  let providerPort: number;
  let proxyPort: number;
  let logs: AIProxyLogEntry[];

  beforeEach(async () => {
    provider = createProvider();
    providerPort = await listen(provider);
    logs = [];
    const logger: AIProxyLogger = { info: (entry) => logs.push(entry) };
    proxy = createAIProxyServer(createConfig(), logger);
    proxyPort = await listen(proxy);
  });

  afterEach(async () => {
    await Promise.all([close(proxy), close(provider)]);
  });

  it("forwards JSON bytes and provider credentials while removing proxy headers", async () => {
    const response = await proxyFetch(
      proxyPort,
      `http://127.0.0.1:${providerPort}/json?private=query-value`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer provider-secret",
          "Content-Type": "application/json",
          "X-Goog-Api-Key": "gemini-secret",
          "X-Forwarded-For": "10.0.0.1",
          "X-Custom-Provider": "kept",
        },
        body: JSON.stringify({ prompt: "private prompt" }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-excalidraw-ai-proxy")).toBe("1");
    expect(response.headers.get("access-control-allow-origin")).toBe(
      APP_ORIGIN,
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(body).toMatchObject({
      path: "/json",
      method: "POST",
      body: JSON.stringify({ prompt: "private prompt" }),
    });
    expect(body.headers.authorization).toBe("Bearer provider-secret");
    expect(body.headers["x-goog-api-key"]).toBe("gemini-secret");
    expect(body.headers["x-custom-provider"]).toBe("kept");
    expect(body.headers["x-forwarded-for"]).toBeUndefined();
    expect(body.headers["x-excalidraw-ai-target"]).toBeUndefined();
    expect(body.headers["x-excalidraw-ai-proxy-token"]).toBeUndefined();
  });

  it("preserves multipart content type and request bytes", async () => {
    const boundary = "----excalidraw-ai-proxy-test";
    const multipartBody = [
      `--${boundary}\r\n`,
      'Content-Disposition: form-data; name="prompt"\r\n\r\n',
      "private prompt\r\n",
      `--${boundary}\r\n`,
      'Content-Disposition: form-data; name="image"; filename="image.bin"\r\n',
      "Content-Type: application/octet-stream\r\n\r\n",
      "\u0000\u0001binary-data\r\n",
      `--${boundary}--\r\n`,
    ].join("");

    const response = await proxyFetch(
      proxyPort,
      `http://127.0.0.1:${providerPort}/multipart`,
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body: multipartBody,
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.body).toBe(multipartBody);
    expect(body.headers["content-type"]).toBe(
      `multipart/form-data; boundary=${boundary}`,
    );
  });

  it("passes provider non-2xx status/body through without marking a proxy error", async () => {
    const response = await proxyFetch(
      proxyPort,
      `http://127.0.0.1:${providerPort}/provider-error`,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("x-excalidraw-ai-proxy")).toBe("1");
    expect(response.headers.get("x-excalidraw-ai-proxy-error")).toBeNull();
    expect(response.headers.get("x-excalidraw-ai-request-id")).not.toBe(
      "provider-request-id",
    );
    expect(response.headers.get("x-hop-response")).toBeNull();
    await expect(response.json()).resolves.toEqual({
      error: { message: "rate limited" },
    });
  });

  it("follows safe GET redirects and refuses body replay and unsafe redirect targets", async () => {
    const safe = await proxyFetch(
      proxyPort,
      `http://127.0.0.1:${providerPort}/redirect-get`,
    );
    await expect(safe.json()).resolves.toMatchObject({ path: "/final" });

    const bodyRedirect = await proxyFetch(
      proxyPort,
      `http://127.0.0.1:${providerPort}/redirect-post`,
      { method: "POST", body: "body" },
    );
    expect(bodyRedirect.status).toBe(502);
    expect(bodyRedirect.headers.get("x-excalidraw-ai-proxy-error")).toBe(
      "AI_PROXY_REDIRECT_REQUIRES_FINAL_URL",
    );

    const blocked = await proxyFetch(
      proxyPort,
      `http://127.0.0.1:${providerPort}/redirect-blocked`,
    );
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get("x-excalidraw-ai-proxy-error")).toBe(
      "AI_PROXY_TARGET_BLOCKED",
    );
  });

  it("enforces Origin and token before reading the provider target", async () => {
    const deniedOrigin = await fetch(
      `http://127.0.0.1:${proxyPort}/ai-proxy/v1/forward`,
      {
        headers: {
          Origin: "http://evil.test",
          "X-Excalidraw-AI-Proxy-Token": CLIENT_TOKEN,
          "X-Excalidraw-AI-Target": `http://127.0.0.1:${providerPort}/json`,
        },
      },
    );
    expect(deniedOrigin.status).toBe(403);
    expect(deniedOrigin.headers.get("access-control-allow-origin")).toBeNull();

    const missingToken = await fetch(
      `http://127.0.0.1:${proxyPort}/ai-proxy/v1/forward`,
      {
        headers: {
          Origin: APP_ORIGIN,
          "X-Excalidraw-AI-Target": `http://127.0.0.1:${providerPort}/json`,
        },
      },
    );
    expect(missingToken.status).toBe(401);
    expect(missingToken.headers.get("x-excalidraw-ai-proxy-error")).toBe(
      "AI_PROXY_TOKEN_REQUIRED",
    );
  });

  it("handles CORS preflight without contacting the provider", async () => {
    const response = await fetch(
      `http://127.0.0.1:${proxyPort}/ai-proxy/v1/forward`,
      {
        method: "OPTIONS",
        headers: {
          Origin: APP_ORIGIN,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers":
            "authorization, content-type, x-excalidraw-ai-target, x-excalidraw-ai-proxy-token",
        },
      },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      APP_ORIGIN,
    );
    expect(response.headers.get("access-control-max-age")).toBe("600");
  });

  it("restricts health and readiness endpoints to GET", async () => {
    const health = await fetch(
      `http://127.0.0.1:${proxyPort}/ai-proxy/healthz`,
      { method: "POST" },
    );
    expect(health.status).toBe(405);
    expect(health.headers.get("x-excalidraw-ai-proxy-error")).toBe(
      "AI_PROXY_METHOD_NOT_ALLOWED",
    );

    const ready = await fetch(`http://127.0.0.1:${proxyPort}/ai-proxy/readyz`, {
      method: "POST",
      headers: {
        Origin: APP_ORIGIN,
        "X-Excalidraw-AI-Proxy-Token": CLIENT_TOKEN,
      },
    });
    expect(ready.status).toBe(405);
    expect(ready.headers.get("x-excalidraw-ai-proxy-error")).toBe(
      "AI_PROXY_METHOD_NOT_ALLOWED",
    );
  });

  it("rejects oversized bodies before or during streaming", async () => {
    await close(proxy);
    proxy = createAIProxyServer(createConfig({ maxRequestBytes: 8 }), {
      info: (entry) => logs.push(entry),
    });
    proxyPort = await listen(proxy);

    const response = await proxyFetch(
      proxyPort,
      `http://127.0.0.1:${providerPort}/json`,
      { method: "POST", body: "0123456789" },
    );

    expect(response.status).toBe(413);
    expect(response.headers.get("x-excalidraw-ai-proxy-error")).toBe(
      "AI_PROXY_REQUEST_TOO_LARGE",
    );
  });

  it("logs only a sanitized hostname and operational metadata", async () => {
    const response = await proxyFetch(
      proxyPort,
      `http://127.0.0.1:${providerPort}/json?signed=private-query`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer provider-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: "private prompt" }),
      },
    );
    await response.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const serialized = JSON.stringify(logs);
    expect(serialized).toContain("127.0.0.1");
    expect(serialized).not.toContain("private-query");
    expect(serialized).not.toContain("provider-secret");
    expect(serialized).not.toContain("proxy-client-token");
    expect(serialized).not.toContain("private prompt");
  });
});
