import { STORAGE_KEYS } from "../app_constants";

import { saveAIProxyConfig } from "./proxyConfig";
import {
  describeImageWithVisionAgent,
  generateDiagramCodeWithVisionAgent,
} from "./visionAgentAdapter";

import type { AIAgent } from "./types";

const agent: AIAgent = {
  id: "vision-proxy",
  name: "Vision proxy",
  type: "vision",
  provider: "openai-compatible",
  baseURL: "https://api.example.com/v1",
  apiKey: "vision-key",
  model: "vision-model",
};

describe("visionAgentAdapter", () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_AI_PROXY);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes vision requests through the global proxy transport", async () => {
    saveAIProxyConfig({
      mode: "byok-proxy",
      endpoint: "/ai-proxy/v1/forward",
      accessToken: "proxy-token",
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "<!doctype html><html></html>" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateDiagramCodeWithVisionAgent({
        agent,
        image: "data:image/png;base64,AAAA",
        texts: "Hello",
        theme: "light",
      }),
    ).resolves.toEqual({ html: "<!doctype html><html></html>" });

    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const headers = init.headers as Headers;
    expect(endpoint).toBe("/ai-proxy/v1/forward");
    expect(headers.get("X-Excalidraw-AI-Target")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
    expect(headers.get("X-Excalidraw-AI-Proxy-Token")).toBe("proxy-token");
  });
});

describe("describeImageWithVisionAgent", () => {
  const jsonAnswer = JSON.stringify({
    reading: "我看到一只想跑的鸟。",
    imagePrompt: "a bird made of the existing strokes",
  });

  const openAIMock = () =>
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: jsonAnswer } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_AI_PROXY);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the caller's own prompts and returns raw text", async () => {
    const fetchMock = openAIMock();
    vi.stubGlobal("fetch", fetchMock);

    const result = await describeImageWithVisionAgent({
      agent,
      image: "data:image/png;base64,AAAA",
      systemPrompt: "SYSTEM RULES",
      userPrompt: "USER QUESTION",
    });

    expect(result).toEqual({ text: jsonAnswer });
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(String(init.body));
    expect(body.messages[0]).toEqual({
      role: "system",
      content: "SYSTEM RULES",
    });
    expect(body.messages[1].content[0]).toEqual({
      type: "text",
      text: "USER QUESTION",
    });
    // The wireframe exporter's HTML instructions must not leak in.
    expect(JSON.stringify(body)).not.toContain("wireframe");
  });

  it("routes through the proxy transport when configured", async () => {
    saveAIProxyConfig({
      mode: "byok-proxy",
      endpoint: "/ai-proxy/v1/forward",
      accessToken: "proxy-token",
    });
    const fetchMock = openAIMock();
    vi.stubGlobal("fetch", fetchMock);

    await describeImageWithVisionAgent({
      agent,
      image: "data:image/png;base64,AAAA",
      systemPrompt: "SYSTEM",
      userPrompt: "USER",
    });

    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(endpoint).toBe("/ai-proxy/v1/forward");
    expect((init.headers as Headers).get("X-Excalidraw-AI-Target")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
  });

  it("rejects an incomplete agent without touching the network", async () => {
    const fetchMock = openAIMock();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      describeImageWithVisionAgent({
        agent: { ...agent, baseURL: "" },
        image: "data:image/png;base64,AAAA",
        systemPrompt: "SYSTEM",
        userPrompt: "USER",
      }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: " " } }] }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
      ),
    );

    await expect(
      describeImageWithVisionAgent({
        agent,
        image: "data:image/png;base64,AAAA",
        systemPrompt: "SYSTEM",
        userPrompt: "USER",
      }),
    ).rejects.toThrow();
  });

  it("propagates aborts and provider failures", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("Aborted", "AbortError");
      }),
    );

    await expect(
      describeImageWithVisionAgent({
        agent,
        image: "data:image/png;base64,AAAA",
        systemPrompt: "SYSTEM",
        userPrompt: "USER",
        signal: controller.signal,
      }),
    ).rejects.toThrow(/Aborted/);

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "boom" } }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    await expect(
      describeImageWithVisionAgent({
        agent,
        image: "data:image/png;base64,AAAA",
        systemPrompt: "SYSTEM",
        userPrompt: "USER",
      }),
    ).rejects.toThrow("boom");
  });
});
