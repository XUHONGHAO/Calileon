import { loadAIProxyConfig } from "../src/config.js";

describe("AI proxy config", () => {
  it("defaults development to localhost Origin and no access token", () => {
    expect(loadAIProxyConfig({ NODE_ENV: "development" })).toMatchObject({
      port: 3016,
      production: false,
      requireClientToken: false,
      allowHttpLocalhost: true,
    });
    expect(
      loadAIProxyConfig({ NODE_ENV: "development" }).allowedOrigins.has(
        "http://localhost:3000",
      ),
    ).toBe(true);
  });

  it("requires an Origin allowlist and token in production", () => {
    expect(() =>
      loadAIProxyConfig({
        NODE_ENV: "production",
        AI_PROXY_CLIENT_TOKENS: "token-a",
      }),
    ).toThrow("AI_PROXY_ALLOWED_ORIGINS is required in production");
    expect(() =>
      loadAIProxyConfig({
        NODE_ENV: "production",
        AI_PROXY_ALLOWED_ORIGINS: "https://canvas.example.com",
      }),
    ).toThrow("AI_PROXY_CLIENT_TOKENS is required");
    expect(() =>
      loadAIProxyConfig({
        NODE_ENV: "production",
        AI_PROXY_ALLOWED_ORIGINS: "http://canvas.example.com",
        AI_PROXY_CLIENT_TOKENS: "token",
      }),
    ).toThrow("contains an invalid origin");

    expect(
      loadAIProxyConfig({
        NODE_ENV: "production",
        AI_PROXY_ALLOWED_ORIGINS: "https://canvas.example.com",
        AI_PROXY_CLIENT_TOKENS: "current-token, previous-token",
        AI_PROXY_REQUIRE_CLIENT_TOKEN: "false",
      }),
    ).toMatchObject({
      production: true,
      requireClientToken: true,
      clientTokens: ["current-token", "previous-token"],
      allowHttpLocalhost: false,
    });
  });

  it("rejects wildcard and path-bearing Origins", () => {
    expect(() =>
      loadAIProxyConfig({
        NODE_ENV: "development",
        AI_PROXY_ALLOWED_ORIGINS: "*",
      }),
    ).toThrow("cannot contain a wildcard");
    expect(() =>
      loadAIProxyConfig({
        NODE_ENV: "development",
        AI_PROXY_ALLOWED_ORIGINS: "https://canvas.example.com/path",
      }),
    ).toThrow("contains an invalid origin");
  });
});
