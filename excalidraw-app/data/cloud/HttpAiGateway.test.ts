import { createHttpAiGateway } from "./HttpAiGateway";

import type { AiGatewayHttpError } from "./HttpAiGateway";

describe("HttpAiGateway", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps provider non-2xx responses available to protocol adapters", async () => {
    const response = new Response(
      JSON.stringify({ error: { code: "provider" } }),
      {
        status: 429,
        headers: { "Content-Type": "application/json" },
      },
    );
    const fetchImpl = vi.fn(async () => response);
    const gateway = createHttpAiGateway({
      auth: { getAccessToken: async () => "user-token" },
      baseURL: "https://gateway.example.test/ai-gateway/v1",
      fetchImpl,
    });
    await expect(
      gateway.invoke({
        routeId: "route",
        operation: "stream",
        method: "POST",
        headers: {
          Authorization: "provider-token",
          "X-Api-Key": "provider-key",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    ).resolves.toBe(response);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const headers = init.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer user-token");
    expect(headers.get("X-Api-Key")).toBeNull();
    expect(headers.get("X-Excalidraw-AI-Target")).toBeNull();
    expect(init.credentials).toBe("omit");
  });

  it("throws a stable error for gateway failures and fails closed without login", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "AI_GATEWAY_QUOTA_EXCEEDED",
              message: "quota",
              requestId: "request-1",
            },
          }),
          {
            status: 429,
            headers: {
              "X-Excalidraw-AI-Gateway-Error": "AI_GATEWAY_QUOTA_EXCEEDED",
              "Content-Type": "application/json",
            },
          },
        ),
    );
    const gateway = createHttpAiGateway({
      auth: { getAccessToken: async () => "user-token" },
      fetchImpl,
    });
    await expect(gateway.getQuota()).rejects.toMatchObject<
      Partial<AiGatewayHttpError>
    >({
      code: "AI_GATEWAY_QUOTA_EXCEEDED",
      status: 429,
      requestId: "request-1",
      message: "quota",
    });

    const noAuth = createHttpAiGateway({
      auth: { getAccessToken: async () => null },
      fetchImpl,
    });
    await expect(noAuth.getCatalog()).rejects.toMatchObject({
      code: "AI_GATEWAY_UNAUTHORIZED",
      status: 401,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("provides an explicit account-data deletion call", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const gateway = createHttpAiGateway({
      auth: { getAccessToken: async () => "user-token" },
      baseURL: "https://gateway.example.test/ai-gateway/v1",
      fetchImpl,
    });
    await gateway.deleteAccountData();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://gateway.example.test/ai-gateway/v1/account");
    expect(init.method).toBe("DELETE");
    expect(new Headers(init.headers).get("Authorization")).toBe(
      "Bearer user-token",
    );
  });

  it("validates the gateway endpoint before sending credentials", () => {
    expect(() =>
      createHttpAiGateway({
        auth: { getAccessToken: async () => "user-token" },
        baseURL: "http://gateway.example.test/ai-gateway/v1",
      }),
    ).toThrow(/HTTPS|localhost/);
    expect(() =>
      createHttpAiGateway({
        auth: { getAccessToken: async () => "user-token" },
        baseURL: "https://user:pass@gateway.example.test/ai-gateway/v1",
      }),
    ).toThrow(/credentials|endpoint/i);
    expect(() =>
      createHttpAiGateway({
        auth: { getAccessToken: async () => "user-token" },
        baseURL: "https://gateway.example.test/ai-gateway/v1?unsafe=1",
      }),
    ).toThrow(/query string|endpoint/i);
  });

  it("fails closed for disabled device bootstrap methods", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const gateway = createHttpAiGateway({
      auth: { getAccessToken: async () => null },
      enabled: false,
      fetchImpl,
    });

    await expect(gateway.createDeviceAuthorization()).rejects.toMatchObject({
      name: "BackendError",
      code: "not-configured",
    });
    await expect(
      gateway.exchangeDeviceAuthorization("device-code"),
    ).rejects.toMatchObject({
      name: "BackendError",
      code: "not-configured",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses credential-free requests for device bootstrap", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            deviceCode: "device",
            userCode: "ABCD-EFGH",
            verificationUri: "https://app.example/ai-device",
            expiresAt: Date.now() + 60_000,
            intervalSeconds: 5,
          }),
          { status: 200 },
        ),
    );
    const gateway = createHttpAiGateway({
      auth: { getAccessToken: async () => null },
      fetchImpl,
      baseURL: "https://gateway.example.test/ai-gateway/v1",
    });
    await gateway.createDeviceAuthorization();
    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(init.credentials).toBe("omit");
  });

  it("normalizes usage and audit list limits before sending them", async () => {
    const fetchImpl = vi.fn(async () => new Response("[]", { status: 200 }));
    const gateway = createHttpAiGateway({
      auth: { getAccessToken: async () => "user-token" },
      fetchImpl,
      baseURL: "https://gateway.example.test/ai-gateway/v1",
    });

    await gateway.getUsage({ limit: -1 });
    await gateway.listAudits({ limit: Number.POSITIVE_INFINITY });

    const calls = fetchImpl.mock.calls as unknown as Array<
      [string, RequestInit]
    >;
    expect(calls[0][0]).toContain("/usage?limit=50");
    expect(calls[1][0]).toContain("/audits?limit=50");
  });
});
