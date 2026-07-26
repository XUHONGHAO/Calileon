import {
  fetchAIRequest,
  getAIProxyErrorCode,
  throwForAIProxyResponse,
} from "./requestTransport";

import type { AIProxyConfigV1 } from "./proxyConfig";
import type { AIProxyTransportError } from "./requestTransport";

const directConfig: AIProxyConfigV1 = {
  version: 1,
  enabled: false,
  endpoint: "",
  accessToken: "",
};

const proxyConfig: AIProxyConfigV1 = {
  version: 1,
  enabled: true,
  endpoint: "/ai-proxy/v1/forward",
  accessToken: "proxy-token",
};

describe("AI request transport", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves the existing direct fetch path by default", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const body = JSON.stringify({ prompt: "hello" });
    const signal = new AbortController().signal;

    await fetchAIRequest(
      "https://provider.example/v1/generate",
      {
        method: "POST",
        headers: { Authorization: "Bearer provider-key" },
        body,
        signal,
      },
      { kind: "image-generation", config: directConfig },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example/v1/generate",
      expect.objectContaining({ body, signal }),
    );
  });

  it("uses the transport signal in direct mode without proxy classification", async () => {
    const response = new Response("provider response", {
      headers: { "X-Excalidraw-AI-Proxy-Error": "PROVIDER_HEADER" },
    });
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    await expect(
      fetchAIRequest(
        "https://provider.example/v1/generate",
        {},
        { kind: "vision-agent", signal, config: directConfig },
      ),
    ).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example/v1/generate",
      expect.objectContaining({ signal }),
    );
  });

  it("moves only the final URL to proxy headers and keeps provider body/headers", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const body = new FormData();
    body.set("prompt", "private prompt");

    await fetchAIRequest(
      "https://provider.example/v1/images/edits?secret=query",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer provider-key",
          "x-goog-api-key": "google-key",
        },
        body,
      },
      { kind: "image-generation", config: proxyConfig },
    );

    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const headers = init.headers as Headers;

    expect(endpoint).toBe("/ai-proxy/v1/forward");
    expect(headers.get("X-Excalidraw-AI-Target")).toBe(
      "https://provider.example/v1/images/edits?secret=query",
    );
    expect(headers.get("X-Excalidraw-AI-Proxy-Token")).toBe("proxy-token");
    expect(headers.get("Authorization")).toBe("Bearer provider-key");
    expect(headers.get("x-goog-api-key")).toBe("google-key");
    expect(init.body).toBe(body);
  });

  it("classifies proxy network and stable proxy response failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    await expect(
      fetchAIRequest(
        "https://provider.example/v1/generate",
        {},
        { kind: "text-agent", config: proxyConfig },
      ),
    ).rejects.toMatchObject<Partial<AIProxyTransportError>>({
      code: "proxy-network",
    });

    const response = new Response(JSON.stringify({ error: {} }), {
      status: 403,
      headers: {
        "X-Excalidraw-AI-Proxy-Error": "AI_PROXY_TARGET_BLOCKED",
        "X-Excalidraw-AI-Request-ID": "request-1234",
      },
    });
    expect(getAIProxyErrorCode(response)).toBe("AI_PROXY_TARGET_BLOCKED");
    expect(() => throwForAIProxyResponse(response)).toThrowError(
      expect.objectContaining({ code: "proxy-error" }),
    );
  });

  it("does not silently fall back to direct fetch when proxying fails", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("proxy unavailable");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchAIRequest(
        "https://provider.example/v1/generate",
        {},
        { kind: "video-submit", config: proxyConfig },
      ),
    ).rejects.toMatchObject({ code: "proxy-network" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
