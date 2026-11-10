import { vi } from "vitest";

import { STORAGE_KEYS } from "../app_constants";

import { submitTextAgent } from "./textAgentAdapter";
import {
  getSkillSystemPrompt,
  H3_PROMPT_SKILL_ID,
  SEEDANCE20_PROMPT_SKILL_ID,
  SEEDANCE25_PROMPT_SKILL_ID,
} from "./skillPresets";

import { saveAIProxyConfig } from "./proxyConfig";

import type { AIAgent } from "./types";

const createAgent = (overrides: Partial<AIAgent> = {}): AIAgent => ({
  id: "agent-1",
  name: "Agent",
  type: "text",
  provider: "openai-compatible",
  baseURL: "https://api.example.com/v1",
  apiKey: "test-key",
  model: "gpt-test",
  ...overrides,
});

const createSSEBody = (text: string) => {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
};

const createChunkedSSEBody = (chunks: readonly string[]) => {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    },
  });
};

describe("textAgentAdapter", () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_AI_PROXY);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(
    (["openai-compatible", "anthropic", "gemini"] as const).flatMap(
      (provider) =>
        [
          H3_PROMPT_SKILL_ID,
          SEEDANCE20_PROMPT_SKILL_ID,
          SEEDANCE25_PROMPT_SKILL_ID,
        ].map((skillId) => [provider, skillId] as const),
    ),
  )("preserves prompt syntax through %s with %s", async (provider, skillId) => {
    const prompt =
      skillId === H3_PROMPT_SKILL_ID
        ? 'integrated_multimodal_description: [Shot 1] <Subject 1> (S1) says: <d>[Chinese] 你好。</d> A sign reads "营业中". <Picture 1> <Video 1> <Audio 1> <scenetrans> <cutoff>\n\noverall_soundscape: Rain.\n\nnon_diegetic_music: N/A'
        : '【参考素材职责】@图片1 中的女子为<主体1>。\n镜头1：<主体1>说{你好，世界}，<远处传来狗叫声>，（舒缓的钢琴乐），画面出现"咖啡馆"。';
    const event =
      provider === "anthropic"
        ? { delta: { text: prompt } }
        : provider === "gemini"
        ? { candidates: [{ content: { parts: [{ text: prompt }] } }] }
        : { choices: [{ delta: { content: prompt } }] };
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        createSSEBody(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`),
        { status: 200 },
      ),
    );
    const onChunk = vi.fn();
    const systemPrompt = getSkillSystemPrompt(skillId)!;
    const result = await submitTextAgent({
      agent: createAgent({
        type: "llm",
        provider,
        systemPrompt: "Other role",
      }),
      systemPrompt,
      messages: [{ role: "user", content: "Write a cafe video prompt" }],
      onChunk,
    });
    expect(result).toMatchObject({ generatedResponse: prompt, error: null });
    expect(onChunk).toHaveBeenCalledWith(prompt);
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    const sentSystem =
      provider === "anthropic"
        ? body.system
        : provider === "gemini"
        ? body.systemInstruction.parts[0].text
        : body.messages[0].content;
    expect(sentSystem).toBe(systemPrompt.trim());
  });

  it("accepts SSE data lines without a space after the colon", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        createSSEBody(
          'data:{"choices":[{"delta":{"content":"Hello"}}]}\n\ndata:[DONE]\n\n',
        ),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      ),
    );

    await expect(
      submitTextAgent({
        agent: createAgent(),
        messages: [{ role: "user", content: "Say hi" }],
      }),
    ).resolves.toMatchObject({
      generatedResponse: "Hello",
      error: null,
    });
  });

  it("parses chunked CRLF events and flushes an event without a trailing newline", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        createChunkedSSEBody([
          'data: {"choices":[{"delta":{"content":"Hel',
          'lo"}}]}\r',
          "\n\r\ndata: [DO",
          "NE]",
        ]),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      ),
    );

    await expect(
      submitTextAgent({
        agent: createAgent(),
        messages: [{ role: "user", content: "Say hi" }],
      }),
    ).resolves.toMatchObject({
      generatedResponse: "Hello",
      error: null,
    });
  });

  it("joins multiple data lines in the same SSE event", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        createSSEBody(
          'event: message\ndata: {"choices":\ndata: [{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n',
        ),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      ),
    );

    await expect(
      submitTextAgent({
        agent: createAgent(),
        messages: [{ role: "user", content: "Say hi" }],
      }),
    ).resolves.toMatchObject({
      generatedResponse: "Hello",
      error: null,
    });
  });

  it("does not log raw stream payloads when an event contains invalid JSON", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secretPayload = "invalid-json-with-secret-api-key";
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        createSSEBody(
          `data: ${secretPayload}\n\ndata: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n`,
        ),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      ),
    );

    await expect(
      submitTextAgent({
        agent: createAgent(),
        messages: [{ role: "user", content: "Say hi" }],
      }),
    ).resolves.toMatchObject({
      generatedResponse: "Hello",
      error: null,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to parse AI agent stream event.",
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(secretPayload);
  });

  it("strips pasted auth schemes from raw provider key headers", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        createSSEBody('data: {"delta":{"text":"Hello"}}\n\ndata: [DONE]\n\n'),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      ),
    );

    await submitTextAgent({
      agent: createAgent({
        provider: "anthropic",
        baseURL: "https://api.anthropic.com",
        apiKey: "Bearer anthropic-key",
        model: "claude-test",
      }),
      messages: [{ role: "user", content: "Say hi" }],
    });

    expect(vi.mocked(fetch).mock.calls[0][1]?.headers).toMatchObject({
      "x-api-key": "anthropic-key",
    });
  });

  it("preserves SSE parsing when the request uses the proxy transport", async () => {
    saveAIProxyConfig({
      mode: "byok-proxy",
      endpoint: "/ai-proxy/v1/forward",
      accessToken: "proxy-token",
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        createSSEBody(
          'data: {"choices":[{"delta":{"content":"proxied"}}]}\n\ndata: [DONE]\n\n',
        ),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      ),
    );

    await expect(
      submitTextAgent({
        agent: createAgent(),
        messages: [{ role: "user", content: "Say hi" }],
      }),
    ).resolves.toMatchObject({ generatedResponse: "proxied", error: null });

    const [endpoint, init] = vi.mocked(fetch).mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(endpoint).toBe("/ai-proxy/v1/forward");
    expect((init.headers as Headers).get("X-Excalidraw-AI-Target")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
    expect((init.headers as Headers).get("X-Excalidraw-AI-Proxy-Token")).toBe(
      "proxy-token",
    );
  });
});
