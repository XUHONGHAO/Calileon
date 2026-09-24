import { STORAGE_KEYS } from "../app_constants";

import {
  AI_PROXY_ENDPOINT_PATH,
  DEFAULT_AI_PROXY_CONFIG,
  getAIProxyReadyEndpoint,
  getRuntimeDefaultAIProxyEndpoint,
  loadAIProxyConfig,
  resetAIProxyConfig,
  saveAIProxyConfig,
  validateAIProxyEndpoint,
} from "./proxyConfig";

describe("AI proxy config", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.unstubAllEnvs();
  });

  it("defaults to direct mode and the same-origin endpoint", () => {
    expect(loadAIProxyConfig()).toEqual(DEFAULT_AI_PROXY_CONFIG);
    expect(getRuntimeDefaultAIProxyEndpoint()).toBe(AI_PROXY_ENDPOINT_PATH);
  });

  it("persists a versioned config independently from model and agent stores", () => {
    const saved = saveAIProxyConfig({
      mode: "byok-proxy",
      endpoint: "/ai-proxy/v1/forward",
      accessToken: "  proxy-token  ",
    });

    expect(saved).toEqual({
      version: 2,
      mode: "byok-proxy",
      endpoint: "/ai-proxy/v1/forward",
      accessToken: "proxy-token",
      gatewayEndpoint: "",
      managedRoutes: {},
    });
    expect(loadAIProxyConfig()).toEqual(saved);
    expect(
      JSON.parse(
        localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_AI_PROXY) || "{}",
      ).version,
    ).toBe(2);
  });

  it("merges partial updates without dropping the saved endpoint or mode", () => {
    saveAIProxyConfig({
      mode: "managed-gateway",
      gatewayEndpoint: "/ai-gateway/v1",
      managedRoutes: { "text-agent": "text-route" },
    });
    const saved = saveAIProxyConfig({
      managedRoutes: { "vision-agent": "vision-route" },
    });
    expect(saved).toMatchObject({
      mode: "managed-gateway",
      gatewayEndpoint: "/ai-gateway/v1",
      managedRoutes: {
        "vision-agent": "vision-route",
      },
    });
    expect(saved.managedRoutes).not.toHaveProperty("text-agent");
  });

  it("migrates malformed or unknown fields to safe defaults", () => {
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_AI_PROXY,
      JSON.stringify({ version: 0, enabled: "yes", accessToken: 42 }),
    );

    expect(loadAIProxyConfig()).toEqual(DEFAULT_AI_PROXY_CONFIG);
  });

  it("migrates the legacy V1 enabled flag while keeping direct as the default", () => {
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_AI_PROXY,
      JSON.stringify({
        version: 1,
        enabled: true,
        endpoint: "/ai-proxy/v1/forward",
        accessToken: "legacy-token",
      }),
    );
    expect(loadAIProxyConfig()).toMatchObject({
      version: 2,
      mode: "byok-proxy",
      endpoint: "/ai-proxy/v1/forward",
      accessToken: "legacy-token",
    });
  });

  it("validates relative, HTTPS, and development localhost endpoints", () => {
    expect(validateAIProxyEndpoint("/ai-proxy/v1/forward")).toBe(
      "/ai-proxy/v1/forward",
    );
    expect(
      validateAIProxyEndpoint("https://proxy.example.com/ai-proxy/v1/forward", {
        production: true,
      }),
    ).toBe("https://proxy.example.com/ai-proxy/v1/forward");
    expect(
      validateAIProxyEndpoint("http://localhost:3016/ai-proxy/v1/forward", {
        production: false,
      }),
    ).toBe("http://localhost:3016/ai-proxy/v1/forward");
    expect(() =>
      validateAIProxyEndpoint("https://proxy.example.com/ai-gateway/v1?x=1", {
        production: true,
        allowQuery: false,
      }),
    ).toThrow(/query string/);
  });

  it.each([
    "http://proxy.example.com/ai-proxy/v1/forward",
    "https://user:pass@proxy.example.com/forward",
    "https://proxy.example.com/forward#fragment",
    "ftp://proxy.example.com/forward",
    "//proxy.example.com/forward",
  ])("rejects unsafe endpoint %s", (endpoint) => {
    expect(() =>
      validateAIProxyEndpoint(endpoint, { production: true }),
    ).toThrow(/AI proxy endpoint|HTTP|credentials|fragment|valid URL/);
  });

  it("derives the ready endpoint without carrying query strings", () => {
    expect(getAIProxyReadyEndpoint("/ai-proxy/v1/forward")).toBe(
      "/ai-proxy/readyz",
    );
    expect(
      getAIProxyReadyEndpoint(
        "https://proxy.example.com/ai-proxy/v1/forward?ignored=true",
      ),
    ).toBe("https://proxy.example.com/ai-proxy/readyz");
  });

  it("removes the independent config on reset", () => {
    saveAIProxyConfig({ mode: "byok-proxy", accessToken: "token" });
    expect(resetAIProxyConfig()).toEqual(DEFAULT_AI_PROXY_CONFIG);
    expect(loadAIProxyConfig()).toEqual(DEFAULT_AI_PROXY_CONFIG);
  });

  it("fails closed when production localStorage contains an unsafe endpoint", () => {
    vi.stubEnv("MODE", "production");
    vi.stubEnv("PROD", true);
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_AI_PROXY,
      JSON.stringify({
        version: 2,
        mode: "byok-proxy",
        endpoint: "http://proxy.example.com/ai-proxy/v1/forward",
        accessToken: "should-not-be-used",
      }),
    );

    expect(loadAIProxyConfig()).toEqual(DEFAULT_AI_PROXY_CONFIG);
  });

  it("fails closed for an unsafe managed gateway endpoint", () => {
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_AI_PROXY,
      JSON.stringify({
        version: 2,
        mode: "managed-gateway",
        gatewayEndpoint: "https://gateway.example.com/ai-gateway/v1?unsafe=1",
      }),
    );

    expect(loadAIProxyConfig()).toEqual(DEFAULT_AI_PROXY_CONFIG);
  });
});
