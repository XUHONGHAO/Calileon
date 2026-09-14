import http from "node:http";
import { once } from "node:events";

import { createGatewayHandler } from "../src/gateway/handler.js";
import { GatewayRouter } from "../src/gateway/routes.js";
import { createUnavailableGatewayHandler } from "../src/gateway/runtime.js";
import { MemoryGatewayStore } from "../src/gateway/store.js";

import type { AddressInfo } from "node:net";

import type { AIProxyConfig } from "../src/config.js";
import type { GatewayRuntimeConfig } from "../src/gateway/config.js";
import type {
  GatewayDeclarativeConfig,
  GatewayIdentity,
} from "../src/gateway/types.js";

const identity: GatewayIdentity = {
  issuer: "issuer",
  subject: "user-1",
  source: "jwt",
};

const proxyConfig: AIProxyConfig = {
  port: 0,
  production: false,
  allowedOrigins: new Set(["http://app.test"]),
  requireClientToken: false,
  clientTokens: [],
  allowHttpLocalhost: true,
  connectTimeoutMs: 500,
  requestTimeoutMs: 2_000,
  idleTimeoutMs: 1_000,
  maxRequestBytes: 1024 * 1024,
  maxRedirects: 5,
  shutdownGraceMs: 1_000,
  logTargetHostname: false,
};

const runtime: GatewayRuntimeConfig = {
  enabled: true,
  production: false,
  databaseUrl: "postgresql://gateway:secret@localhost/gateway",
  jwksUrl: "https://auth.example.test/jwks",
  issuer: "issuer",
  audience: "audience",
  algorithms: ["RS256"],
  routeConfigPath: "/tmp/routes.json",
  auditContentEnabled: false,
  kmsProvider: "local-kek",
  kmsKeyId: "",
  localKek: Buffer.alloc(32).toString("base64"),
  credentialCacheMs: 1_000,
  requestLeaseMs: 10_000,
  deviceCodeTtlMs: 600_000,
  deviceTokenTtlMs: 3_600_000,
  devicePollIntervalSeconds: 5,
  verificationUri: "https://app.test/ai-device",
  metricsToken: "metrics-secret",
  allowedOrigins: new Set(["http://app.test", "null"]),
  trustProxy: false,
};

const makeDeclarative = (
  baseUrl: string,
  candidates?: unknown[],
): GatewayDeclarativeConfig => ({
  version: 1,
  defaultPolicy: "standard",
  policies: [
    {
      id: "standard",
      dailyCredits: 20,
      monthlyCredits: 100,
      requestsPerMinute: 20,
      maxConcurrency: 2,
    },
  ],
  routes: [
    {
      id: "text-route",
      label: "Text route",
      capability: "text-agent",
      wireProtocol: "openai-chat-sse",
      model: "managed-model",
      costUnits: 1,
      operations: {
        stream: {
          method: "POST",
          path: "/v1/chat/completions",
          replayable: true,
          maxRequestBytes: 1024,
        },
      },
      candidates: (candidates || [
        { id: "primary", baseUrl, credentialHeader: "authorization-bearer" },
      ]) as any,
    },
  ],
});

const listen = async (server: http.Server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
};

const close = async (server: http.Server) => {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
};

const createHarness = (
  declarative: GatewayDeclarativeConfig,
  options: {
    ready?: boolean;
    authReady?: boolean;
    markDispatched?: (requestId: string) => Promise<boolean>;
    authIdentity?: GatewayIdentity;
  } = {},
) => {
  const store = new MemoryGatewayStore();
  const authenticator = {
    authenticate: async () => options.authIdentity || identity,
    checkReady: async () => options.authReady !== false,
  };
  const cipher = {
    encrypt: async (value: Buffer) => ({
      provider: "local-kek" as const,
      keyId: "test",
      wrappedKey: "wrapped",
      iv: "iv",
      tag: "tag",
      ciphertext: value.toString("base64"),
    }),
    decrypt: async (envelope: any) =>
      Buffer.from(envelope.ciphertext, "base64"),
  };
  const credentialVault = { get: async () => Buffer.from("provider-secret") };
  const storeDependency = Object.create(store) as MemoryGatewayStore;
  storeDependency.checkReady = async () => options.ready !== false;
  if (options.markDispatched) {
    storeDependency.markDispatched = options.markDispatched;
  }
  const handler = createGatewayHandler({
    runtime,
    declarative,
    store: storeDependency,
    authenticator: authenticator as any,
    cipher: cipher as any,
    credentialVault: credentialVault as any,
    proxyConfig,
    router: new GatewayRouter(declarative),
  });
  return { handler, store };
};

describe("managed gateway HTTP contract", () => {
  it("keeps allowed-origin CORS on fail-closed unavailable responses", async () => {
    const handler = createUnavailableGatewayHandler(
      new Set(["http://app.test"]),
    );
    const server = http.createServer((request, response) => {
      void handler(request, response);
    });
    const port = await listen(server);
    try {
      const allowed = await fetch(`http://127.0.0.1:${port}/catalog`, {
        headers: { Origin: "http://app.test" },
      });
      expect(allowed.status).toBe(503);
      expect(allowed.headers.get("access-control-allow-origin")).toBe(
        "http://app.test",
      );

      const denied = await fetch(`http://127.0.0.1:${port}/catalog`, {
        headers: { Origin: "http://other.test" },
      });
      expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await close(server);
    }
  });

  it("fails readiness closed when either Postgres or JWKS is unavailable", async () => {
    const { handler } = createHarness(makeDeclarative("http://127.0.0.1:1"), {
      authReady: false,
    });
    const server = http.createServer((request, response) => {
      void handler(request, response);
    });
    const port = await listen(server);
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/ai-gateway/v1/readyz`,
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("x-excalidraw-ai-gateway-error")).toBe(
        "AI_GATEWAY_NOT_READY",
      );
    } finally {
      await close(server);
    }
  });

  it("returns a catalog without provider targets and passes provider errors through", async () => {
    const provider = http.createServer((_request, response) => {
      response.writeHead(429, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: "provider limit" } }));
    });
    const providerPort = await listen(provider);
    const { handler } = createHarness(
      makeDeclarative(`http://127.0.0.1:${providerPort}`),
    );
    const server = http.createServer((request, response) => {
      void handler(request, response);
    });
    const port = await listen(server);
    try {
      const catalog = await fetch(
        `http://127.0.0.1:${port}/ai-gateway/v1/catalog`,
        {
          headers: { Origin: "http://app.test", Authorization: "Bearer user" },
        },
      );
      const entries = await catalog.json();
      expect(catalog.status).toBe(200);
      expect(entries[0]).not.toHaveProperty("candidates");
      expect(entries[0]).not.toHaveProperty("baseUrl");

      const response = await fetch(
        `http://127.0.0.1:${port}/ai-gateway/v1/invoke/text-route/stream`,
        {
          method: "POST",
          headers: {
            Origin: "http://app.test",
            Authorization: "Bearer user",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ messages: [] }),
        },
      );
      expect(response.status).toBe(429);
      expect(response.headers.get("x-excalidraw-ai-gateway-error")).toBeNull();
      await expect(response.json()).resolves.toEqual({
        error: { message: "provider limit" },
      });
    } finally {
      await Promise.all([close(server), close(provider)]);
    }
  });

  it("overrides a browser supplied JSON model with the managed route model", async () => {
    let receivedBody = "";
    const provider = http.createServer((request, response) => {
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        receivedBody += chunk;
      });
      request.on("end", () => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
    });
    const providerPort = await listen(provider);
    const { handler } = createHarness(
      makeDeclarative(`http://127.0.0.1:${providerPort}`),
    );
    const server = http.createServer((request, response) => {
      void handler(request, response);
    });
    const port = await listen(server);
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/ai-gateway/v1/invoke/text-route/stream`,
        {
          method: "POST",
          headers: {
            Origin: "http://app.test",
            Authorization: "Bearer user",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: "browser-selected-model" }),
        },
      );
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect(JSON.parse(receivedBody)).toMatchObject({
        model: "managed-model",
      });
    } finally {
      await Promise.all([close(server), close(provider)]);
    }
  });

  it("replays a small JSON request once after a transport failure", async () => {
    const provider = http.createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    const providerPort = await listen(provider);
    const { handler, store } = createHarness(
      makeDeclarative("http://127.0.0.1:1", [
        {
          id: "primary",
          baseUrl: "http://127.0.0.1:1",
          credentialHeader: "none",
        },
        {
          id: "backup",
          baseUrl: `http://127.0.0.1:${providerPort}`,
          credentialHeader: "none",
        },
      ]),
    );
    const server = http.createServer((request, response) => {
      void handler(request, response);
    });
    const port = await listen(server);
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/ai-gateway/v1/invoke/text-route/stream`,
        {
          method: "POST",
          headers: {
            Origin: "http://app.test",
            Authorization: "Bearer user",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prompt: "hello" }),
        },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      const usage = await store.listUsage(identity, 10);
      expect(usage[0]).toMatchObject({ providerAttempts: 2, costUnits: 1 });
    } finally {
      await Promise.all([close(server), close(provider)]);
    }
  });

  it("fails over once on a provider 5xx without charging twice", async () => {
    let primaryRequests = 0;
    let backupRequests = 0;
    const primary = http.createServer((_request, response) => {
      primaryRequests += 1;
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "primary unavailable" }));
    });
    const backup = http.createServer((_request, response) => {
      backupRequests += 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    const primaryPort = await listen(primary);
    const backupPort = await listen(backup);
    const { handler, store } = createHarness(
      makeDeclarative(`http://127.0.0.1:${primaryPort}`, [
        {
          id: "primary",
          baseUrl: `http://127.0.0.1:${primaryPort}`,
          credentialHeader: "none",
        },
        {
          id: "backup",
          baseUrl: `http://127.0.0.1:${backupPort}`,
          credentialHeader: "none",
        },
      ]),
    );
    const server = http.createServer((request, response) => {
      void handler(request, response);
    });
    const port = await listen(server);
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/ai-gateway/v1/invoke/text-route/stream`,
        {
          method: "POST",
          headers: {
            Origin: "http://app.test",
            Authorization: "Bearer user",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prompt: "retry me" }),
        },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(primaryRequests).toBe(1);
      expect(backupRequests).toBe(1);
      await expect(store.listUsage(identity, 10)).resolves.toMatchObject([
        { providerAttempts: 2, costUnits: 1, status: "succeeded" },
      ]);
    } finally {
      await Promise.all([close(server), close(primary), close(backup)]);
    }
  });

  it("rejects provider credentials and oversized streamed bodies", async () => {
    const { handler } = createHarness(makeDeclarative("http://127.0.0.1:1"));
    const server = http.createServer((request, response) => {
      void handler(request, response);
    });
    const port = await listen(server);
    try {
      const forbidden = await fetch(
        `http://127.0.0.1:${port}/ai-gateway/v1/invoke/text-route/stream`,
        {
          method: "POST",
          headers: {
            Origin: "http://app.test",
            Authorization: "Bearer user",
            "X-Api-Key": "provider-secret",
          },
          body: "{}",
        },
      );
      expect(forbidden.status).toBe(403);
      const oversized = await fetch(
        `http://127.0.0.1:${port}/ai-gateway/v1/invoke/text-route/stream`,
        {
          method: "POST",
          headers: {
            Origin: "http://app.test",
            Authorization: "Bearer user",
            "Content-Type": "text/plain",
            "Content-Length": "2048",
          },
          body: "x".repeat(2048),
        },
      );
      expect(oversized.status).toBe(413);
    } finally {
      await close(server);
    }
  });

  it("does not send provider bytes when the reservation expires during connect", async () => {
    let providerRequests = 0;
    const provider = http.createServer((_request, response) => {
      providerRequests += 1;
      response.end("should-not-run");
    });
    const providerPort = await listen(provider);
    const { handler, store } = createHarness(
      makeDeclarative(`http://127.0.0.1:${providerPort}`),
      { markDispatched: async () => false },
    );
    const server = http.createServer((request, response) => {
      void handler(request, response);
    });
    const port = await listen(server);
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/ai-gateway/v1/invoke/text-route/stream`,
        {
          method: "POST",
          headers: {
            Origin: "http://app.test",
            Authorization: "Bearer user",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prompt: "hello" }),
        },
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("x-excalidraw-ai-gateway-error")).toBe(
        "AI_GATEWAY_RESERVATION_EXPIRED",
      );
      expect(providerRequests).toBe(0);
      await expect(store.listUsage(identity, 10)).resolves.toMatchObject([
        { status: "released" },
      ]);
    } finally {
      await Promise.all([close(server), close(provider)]);
    }
  });

  it("follows safe provider redirects without exposing Location or credentials", async () => {
    let redirectedAuthorization = "";
    const final = http.createServer((request, response) => {
      redirectedAuthorization = String(request.headers.authorization || "");
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    const finalPort = await listen(final);
    const redirect = http.createServer((_request, response) => {
      response.writeHead(302, {
        Location: `http://127.0.0.1:${finalPort}/final`,
      });
      response.end();
    });
    const redirectPort = await listen(redirect);
    const { handler } = createHarness(
      makeDeclarative(`http://127.0.0.1:${redirectPort}`),
    );
    const server = http.createServer((request, response) => {
      void handler(request, response);
    });
    const port = await listen(server);
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/ai-gateway/v1/invoke/text-route/stream`,
        {
          method: "POST",
          headers: {
            Origin: "http://app.test",
            Authorization: "Bearer user",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prompt: "hello" }),
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(redirectedAuthorization).toBe("");
    } finally {
      await Promise.all([close(server), close(redirect), close(final)]);
    }
  });

  it("supports Origin:null device pairing with a one-time exchange", async () => {
    const { handler } = createHarness(makeDeclarative("http://127.0.0.1:1"));
    const server = http.createServer((request, response) => {
      void handler(request, response);
    });
    const port = await listen(server);
    try {
      const codeResponse = await fetch(
        `http://127.0.0.1:${port}/ai-gateway/v1/device/code`,
        { method: "POST", headers: { Origin: "null" } },
      );
      expect(codeResponse.status).toBe(200);
      const authorization = await codeResponse.json();
      expect(authorization.intervalSeconds).toBe(5);
      expect(authorization.userCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

      const approve = await fetch(
        `http://127.0.0.1:${port}/ai-gateway/v1/device/approve`,
        {
          method: "POST",
          headers: {
            Origin: "http://app.test",
            Authorization: "Bearer user",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ userCode: authorization.userCode }),
        },
      );
      expect(approve.status).toBe(200);

      const tokenResponse = await fetch(
        `http://127.0.0.1:${port}/ai-gateway/v1/device/token`,
        {
          method: "POST",
          headers: { Origin: "null", "Content-Type": "application/json" },
          body: JSON.stringify({ deviceCode: authorization.deviceCode }),
        },
      );
      expect(tokenResponse.status).toBe(200);
      const token = await tokenResponse.json();
      expect(token.accessToken).toEqual(expect.any(String));

      const reused = await fetch(
        `http://127.0.0.1:${port}/ai-gateway/v1/device/token`,
        {
          method: "POST",
          headers: { Origin: "null", "Content-Type": "application/json" },
          body: JSON.stringify({ deviceCode: authorization.deviceCode }),
        },
      );
      expect(reused.status).toBe(428);
    } finally {
      await close(server);
    }
  });

  it("keeps device sessions away from account and audit controls", async () => {
    const deviceIdentity: GatewayIdentity = {
      ...identity,
      source: "device",
    };
    const { handler } = createHarness(makeDeclarative("http://127.0.0.1:1"), {
      authIdentity: deviceIdentity,
    });
    const server = http.createServer((request, response) => {
      void handler(request, response);
    });
    const port = await listen(server);
    const headers = {
      Origin: "http://app.test",
      Authorization: "Bearer paired-device-token",
    };
    try {
      await expect(
        fetch(`http://127.0.0.1:${port}/ai-gateway/v1/catalog`, { headers }),
      ).resolves.toMatchObject({ status: 200 });
      for (const [path, method] of [
        ["/ai-gateway/v1/account", "DELETE"],
        ["/ai-gateway/v1/audit/consent", "GET"],
        ["/ai-gateway/v1/audits", "GET"],
      ] as const) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers,
        });
        expect(response.status).toBe(403);
        expect(response.headers.get("x-excalidraw-ai-gateway-error")).toBe(
          "AI_GATEWAY_FORBIDDEN",
        );
      }
    } finally {
      await close(server);
    }
  });

  it("exposes an authenticated account deletion endpoint", async () => {
    const { handler, store } = createHarness(
      makeDeclarative("http://127.0.0.1:1"),
    );
    await store.reserve({
      identity,
      requestId: "account-request",
      routeId: "text-route",
      operation: "stream",
      costUnits: 1,
      defaultPolicy: makeDeclarative("http://127.0.0.1:1").policies[0],
      policies: makeDeclarative("http://127.0.0.1:1").policies,
      leaseMs: 10_000,
    });
    const server = http.createServer((request, response) => {
      void handler(request, response);
    });
    const port = await listen(server);
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/ai-gateway/v1/account`,
        {
          method: "DELETE",
          headers: {
            Origin: "http://app.test",
            Authorization: "Bearer user",
          },
        },
      );
      expect(response.status).toBe(204);
      await expect(store.listUsage(identity, 10)).resolves.toHaveLength(0);
    } finally {
      await close(server);
    }
  });
});
