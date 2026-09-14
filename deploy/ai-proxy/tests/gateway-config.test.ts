import {
  loadGatewayRuntimeConfig,
  parseGatewayDeclarativeConfig,
} from "../src/gateway/config.js";

const baseRuntime = {
  AI_GATEWAY_ENABLED: "true",
  AI_GATEWAY_DATABASE_URL: "postgresql://gateway:secret@localhost:5432/gateway",
  AI_GATEWAY_JWKS_URL: "https://auth.example.test/.well-known/jwks.json",
  AI_GATEWAY_AUTH_ISSUER: "https://auth.example.test",
  AI_GATEWAY_AUTH_AUDIENCE: "authenticated",
  AI_GATEWAY_CONFIG_FILE: "/tmp/routes.json",
  AI_GATEWAY_ALLOWED_ORIGINS: "https://app.example.test,null",
  AI_GATEWAY_DEVICE_VERIFICATION_URI: "https://app.example.test/ai-device",
  AI_GATEWAY_LOCAL_KEK: Buffer.alloc(32, 7).toString("base64"),
};

const route = (overrides: Record<string, unknown> = {}) => ({
  id: "text-route",
  label: "Text",
  capability: "text-agent",
  wireProtocol: "openai-chat-sse",
  model: "model-a",
  costUnits: 1,
  operations: {
    stream: {
      method: "POST",
      path: "/v1/chat/completions",
      replayable: true,
    },
  },
  candidates: [
    {
      id: "primary",
      baseUrl: "https://provider.example.test",
      credentialHeader: "none",
    },
  ],
  ...overrides,
});

const declarative = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  defaultPolicy: "standard",
  policies: [
    {
      id: "standard",
      dailyCredits: 10,
      monthlyCredits: 100,
      requestsPerMinute: 5,
      maxConcurrency: 2,
    },
  ],
  routes: [route()],
  ...overrides,
});

describe("managed gateway configuration", () => {
  it("requires a complete runtime and rejects invalid KMS providers", () => {
    expect(() =>
      loadGatewayRuntimeConfig(
        { ...baseRuntime, AI_GATEWAY_KMS_PROVIDER: "bogus" },
        false,
      ),
    ).toThrow(/KMS_PROVIDER/);

    expect(() =>
      loadGatewayRuntimeConfig(
        { ...baseRuntime, AI_GATEWAY_LOCAL_KEK: "not-a-key" },
        false,
      ),
    ).toThrow(/LOCAL_KEK/);

    expect(loadGatewayRuntimeConfig(baseRuntime, false)).toMatchObject({
      kmsProvider: "local-kek",
    });
    expect(
      loadGatewayRuntimeConfig(
        { ...baseRuntime, AI_GATEWAY_DEVICE_POLL_INTERVAL_SECONDS: "120" },
        false,
      ).devicePollIntervalSeconds,
    ).toBe(60);
  });

  it("fails closed for empty policies/routes and unsafe provider literals", () => {
    expect(() =>
      parseGatewayDeclarativeConfig(declarative({ policies: [] }), false),
    ).toThrow(/must not be empty/);
    expect(() =>
      parseGatewayDeclarativeConfig(declarative({ routes: [] }), false),
    ).toThrow(/must not be empty/);
    expect(() =>
      parseGatewayDeclarativeConfig(
        declarative({
          routes: [
            route({
              candidates: [
                {
                  id: "private",
                  baseUrl: "https://127.0.0.1:8080",
                  credentialHeader: "none",
                },
              ],
            }),
          ],
        }),
        true,
      ),
    ).toThrow(/private|reserved|safe HTTPS/);
  });

  it("requires operation paths, names, and candidate protocols to agree", () => {
    expect(() =>
      parseGatewayDeclarativeConfig(
        declarative({
          routes: [
            route({
              wireProtocol: "openai-chat-sse",
              candidates: [
                {
                  id: "primary",
                  baseUrl: "https://provider.example.test",
                  credentialHeader: "none",
                  wireProtocol: "anthropic-sse",
                },
              ],
            }),
          ],
        }),
        true,
      ),
    ).toThrow(/wire protocol/);
    expect(() =>
      parseGatewayDeclarativeConfig(
        declarative({
          routes: [
            route({
              operations: {
                stream: { method: "POST", path: "/v1?unsafe=true" },
              },
            }),
          ],
        }),
        false,
      ),
    ).toThrow(/operation.path/);
  });

  it("rejects the placeholder route catalog in production", () => {
    expect(() =>
      parseGatewayDeclarativeConfig(
        declarative({
          routes: [
            route({
              model: "replace-with-model-id",
              candidates: [
                {
                  id: "primary",
                  baseUrl: "https://api.example.invalid",
                  credentialHeader: "none",
                },
              ],
            }),
          ],
        }),
        true,
      ),
    ).toThrow(/placeholder/i);
  });
});
