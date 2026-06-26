import { vi } from "vitest";

import { submitTextAgent } from "./textAgentAdapter";

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

describe("textAgentAdapter", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
});
