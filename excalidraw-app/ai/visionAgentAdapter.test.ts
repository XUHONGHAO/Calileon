import { STORAGE_KEYS } from "../app_constants";

import { saveAIProxyConfig } from "./proxyConfig";
import { generateDiagramCodeWithVisionAgent } from "./visionAgentAdapter";

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
