import http from "node:http";
import { once } from "node:events";

import { createAIProxyServer } from "../src/handler.js";

import type { AddressInfo } from "node:net";

import type { AIProxyConfig } from "../src/config.js";

const listen = async (server: http.Server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
};

const close = async (server: http.Server) => {
  server.close();
  await once(server, "close");
};

const config: AIProxyConfig = {
  port: 0,
  production: false,
  allowedOrigins: new Set(["http://app.test"]),
  requireClientToken: false,
  clientTokens: [],
  allowHttpLocalhost: true,
  connectTimeoutMs: 2_000,
  requestTimeoutMs: 5_000,
  idleTimeoutMs: 2_000,
  maxRequestBytes: 1024 * 1024,
  maxRedirects: 5,
  shutdownGraceMs: 1_000,
  logTargetHostname: false,
};

describe("AI proxy streaming", () => {
  it("delivers the first SSE chunk before the provider finishes", async () => {
    const provider = http.createServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      });
      response.write('data: {"chunk":"first"}\n\n');
      setTimeout(() => {
        response.end('data: {"chunk":"second"}\n\n');
      }, 80);
    });
    const providerPort = await listen(provider);
    const proxy = createAIProxyServer(config, { info: () => {} });
    const proxyPort = await listen(proxy);

    try {
      const response = await fetch(
        `http://127.0.0.1:${proxyPort}/ai-proxy/v1/forward`,
        {
          headers: {
            Origin: "http://app.test",
            "X-Excalidraw-AI-Target": `http://127.0.0.1:${providerPort}/sse`,
          },
        },
      );
      const reader = response.body?.getReader();

      expect(reader).toBeDefined();
      const first = await reader!.read();
      const firstText = new TextDecoder().decode(first.value);

      expect(first.done).toBe(false);
      expect(firstText).toContain("first");

      const remaining: Uint8Array[] = [];
      for (;;) {
        const next = await reader!.read();
        if (next.done) {
          break;
        }
        remaining.push(next.value);
      }
      expect(
        new TextDecoder().decode(Buffer.concat(remaining.map(Buffer.from))),
      ).toContain("second");
    } finally {
      await Promise.all([close(proxy), close(provider)]);
    }
  });

  it("streams binary chunks without corrupting or buffering the full response", async () => {
    const firstChunk = Buffer.from([0, 1, 2, 3, 255]);
    const secondChunk = Buffer.from([254, 4, 5, 6, 0]);
    const provider = http.createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.write(firstChunk);
      setTimeout(() => response.end(secondChunk), 80);
    });
    const providerPort = await listen(provider);
    const proxy = createAIProxyServer(config, { info: () => {} });
    const proxyPort = await listen(proxy);

    try {
      const response = await fetch(
        `http://127.0.0.1:${proxyPort}/ai-proxy/v1/forward`,
        {
          headers: {
            Origin: "http://app.test",
            "X-Excalidraw-AI-Target": `http://127.0.0.1:${providerPort}/binary`,
          },
        },
      );
      const reader = response.body?.getReader();

      expect(reader).toBeDefined();
      const first = await reader!.read();
      expect(first.done).toBe(false);
      expect(Buffer.from(first.value || [])).toEqual(firstChunk);

      const remaining: Uint8Array[] = [];
      for (;;) {
        const next = await reader!.read();
        if (next.done) {
          break;
        }
        remaining.push(next.value);
      }
      expect(Buffer.concat(remaining.map(Buffer.from))).toEqual(secondChunk);
    } finally {
      await Promise.all([close(proxy), close(provider)]);
    }
  });

  it("closes the provider connection when the client aborts", async () => {
    let resolveProviderClosed: () => void = () => {};
    const providerClosed = new Promise<void>((resolve) => {
      resolveProviderClosed = resolve;
    });
    const provider = http.createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      const interval = setInterval(
        () => response.write(Buffer.alloc(1024)),
        10,
      );
      response.once("close", () => {
        clearInterval(interval);
        resolveProviderClosed();
      });
    });
    const providerPort = await listen(provider);
    const proxy = createAIProxyServer(config, { info: () => {} });
    const proxyPort = await listen(proxy);

    try {
      const clientRequest = http.get({
        hostname: "127.0.0.1",
        port: proxyPort,
        path: "/ai-proxy/v1/forward",
        headers: {
          Origin: "http://app.test",
          "X-Excalidraw-AI-Target": `http://127.0.0.1:${providerPort}/binary`,
        },
      });
      const [clientResponse] = (await once(clientRequest, "response")) as [
        http.IncomingMessage,
      ];
      await once(clientResponse, "data");
      clientResponse.destroy();
      clientRequest.destroy();

      await Promise.race([
        providerClosed,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Provider connection stayed open.")),
            1_000,
          ),
        ),
      ]);
    } finally {
      proxy.closeAllConnections();
      provider.closeAllConnections();
      await Promise.all([close(proxy), close(provider)]);
    }
  });
});
