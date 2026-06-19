import { RequestError } from "@excalidraw/excalidraw/errors";
import { t } from "@excalidraw/excalidraw/i18n";

import {
  DEFAULT_TEXT_AGENT_SYSTEM_PROMPT,
  getAIAgentProviderPreset,
} from "./agentProviderPresets";
import { cleanMermaidCode } from "./mermaidCleaner";

import type { AIAgent } from "./types";

type LLMMessage = {
  role: "user" | "assistant";
  content: string;
};

type TextAgentSubmitOptions = {
  agent: AIAgent | null;
  messages: readonly LLMMessage[];
  onChunk?: (chunk: string) => void;
  onStreamCreated?: () => void;
  signal?: AbortSignal;
};

type TextAgentSubmitResult =
  | {
      generatedResponse: string;
      error: null;
      rateLimit?: null;
      rateLimitRemaining?: null;
    }
  | {
      generatedResponse?: null;
      error: RequestError;
      rateLimit?: null;
      rateLimitRemaining?: null;
    };

const trimTrailingSlashes = (value: string) => value.replace(/\/+$/, "");

const appendEndpoint = (baseURL: string, endpoint: string) => {
  const trimmedBaseURL = trimTrailingSlashes(baseURL.trim());
  const normalizedEndpoint = endpoint.startsWith("/")
    ? endpoint
    : `/${endpoint}`;

  if (trimmedBaseURL.endsWith(normalizedEndpoint)) {
    return trimmedBaseURL;
  }

  return `${trimmedBaseURL}${normalizedEndpoint}`;
};

const getOpenAIChatEndpoint = (agent: AIAgent) => {
  return appendEndpoint(agent.baseURL, "/chat/completions");
};

const getAnthropicMessagesEndpoint = (agent: AIAgent) => {
  return appendEndpoint(agent.baseURL, "/v1/messages");
};

const getGeminiStreamEndpoint = (agent: AIAgent) => {
  const endpoint = appendEndpoint(
    agent.baseURL,
    `/models/${encodeURIComponent(agent.model)}:streamGenerateContent`,
  );

  return `${endpoint}?alt=sse`;
};

const getSystemPrompt = (agent: AIAgent) => {
  return (
    agent.systemPrompt?.trim() ||
    getAIAgentProviderPreset(agent.provider)?.defaultSystemPrompts.text ||
    DEFAULT_TEXT_AGENT_SYSTEM_PROMPT
  );
};

const getAuthorizationHeaderValue = (apiKey: string) => {
  const trimmedApiKey = apiKey.trim();

  if (!trimmedApiKey) {
    return "";
  }

  return /^(Bearer|Basic)\s+/i.test(trimmedApiKey)
    ? trimmedApiKey
    : `Bearer ${trimmedApiKey}`;
};

const getRawAPIKeyHeaderValue = (apiKey: string) => {
  return apiKey.trim().replace(/^(Bearer|Basic)\s+/i, "");
};

const readString = (value: unknown) => {
  return typeof value === "string" ? value : "";
};

const parseResponseJSON = async (response: Response) => {
  try {
    return await response.json();
  } catch {
    return {};
  }
};

const getProviderErrorMessage = async (response: Response) => {
  const responseJSON = (await parseResponseJSON(response)) as any;
  const message =
    responseJSON?.error?.message ||
    responseJSON?.message ||
    responseJSON?.error ||
    `AI agent returned HTTP ${response.status}.`;

  return typeof message === "string"
    ? message
    : `AI agent returned HTTP ${response.status}.`;
};

async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmedLine = line.trim();

        if (trimmedLine.startsWith("data:")) {
          yield trimmedLine.slice(5).trimStart();
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const streamResponse = async (
  response: Response,
  getChunkText: (data: unknown) => string,
  options: Pick<TextAgentSubmitOptions, "onChunk" | "onStreamCreated">,
) => {
  const reader = response.body?.getReader();

  if (!reader) {
    throw new RequestError({
      message: "Could not read the AI agent response stream.",
      status: 500,
    });
  }

  let generatedResponse = "";
  options.onStreamCreated?.();

  for await (const data of parseSSEStream(reader)) {
    if (data === "[DONE]") {
      break;
    }

    try {
      const parsedData = JSON.parse(data);
      const chunk = getChunkText(parsedData);

      if (chunk) {
        generatedResponse += chunk;
        options.onChunk?.(chunk);
      }
    } catch (error) {
      console.warn("Failed to parse AI agent stream chunk:", data, error);
    }
  }

  if (!generatedResponse) {
    throw new RequestError({
      message: "AI agent stream completed without text.",
      status: response.status,
    });
  }

  return generatedResponse;
};

const submitOpenAICompatibleTextAgent = async (
  agent: AIAgent,
  options: TextAgentSubmitOptions,
) => {
  const headers = new Headers({
    Accept: "text/event-stream",
    "Content-Type": "application/json",
  });
  const authorizationHeader = getAuthorizationHeaderValue(agent.apiKey);

  if (authorizationHeader) {
    headers.set("Authorization", authorizationHeader);
  }

  const response = await fetch(getOpenAIChatEndpoint(agent), {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: agent.model,
      stream: true,
      messages: [
        { role: "system", content: getSystemPrompt(agent) },
        ...options.messages,
      ],
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new RequestError({
      message: await getProviderErrorMessage(response),
      status: response.status,
    });
  }

  return streamResponse(
    response,
    (data: any) => readString(data?.choices?.[0]?.delta?.content),
    options,
  );
};

const submitAnthropicTextAgent = async (
  agent: AIAgent,
  options: TextAgentSubmitOptions,
) => {
  const response = await fetch(getAnthropicMessagesEndpoint(agent), {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
      "x-api-key": getRawAPIKeyHeaderValue(agent.apiKey),
    },
    body: JSON.stringify({
      model: agent.model,
      max_tokens: 4096,
      stream: true,
      system: getSystemPrompt(agent),
      messages: options.messages,
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new RequestError({
      message: await getProviderErrorMessage(response),
      status: response.status,
    });
  }

  return streamResponse(
    response,
    (data: any) => readString(data?.delta?.text),
    options,
  );
};

const toGeminiRole = (role: LLMMessage["role"]) => {
  return role === "assistant" ? "model" : "user";
};

const submitGeminiTextAgent = async (
  agent: AIAgent,
  options: TextAgentSubmitOptions,
) => {
  const response = await fetch(getGeminiStreamEndpoint(agent), {
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      "Content-Type": "application/json",
      "x-goog-api-key": getRawAPIKeyHeaderValue(agent.apiKey),
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: getSystemPrompt(agent) }],
      },
      contents: options.messages.map((message) => ({
        role: toGeminiRole(message.role),
        parts: [{ text: message.content }],
      })),
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new RequestError({
      message: await getProviderErrorMessage(response),
      status: response.status,
    });
  }

  return streamResponse(
    response,
    (data: any) => readString(data?.candidates?.[0]?.content?.parts?.[0]?.text),
    options,
  );
};

export const submitTextAgent = async (
  options: TextAgentSubmitOptions,
): Promise<TextAgentSubmitResult> => {
  const { agent } = options;

  if (!agent) {
    return {
      error: new RequestError({
        message: t("ai.assistant.messages.textAgentNotConfigured"),
        status: 400,
      }),
    };
  }

  if (!agent.baseURL.trim() || !agent.model.trim()) {
    return {
      error: new RequestError({
        message:
          agent.type === "llm"
            ? t("ai.assistant.messages.generalAgentIncomplete")
            : t("ai.assistant.messages.textAgentIncomplete"),
        status: 400,
      }),
    };
  }

  try {
    const generatedResponse =
      agent.provider === "anthropic"
        ? await submitAnthropicTextAgent(agent, options)
        : agent.provider === "gemini"
        ? await submitGeminiTextAgent(agent, options)
        : await submitOpenAICompatibleTextAgent(agent, options);
    const cleanedResponse = cleanMermaidCode(generatedResponse);

    return {
      generatedResponse: cleanedResponse,
      error: null,
      rateLimit: null,
      rateLimitRemaining: null,
    };
  } catch (error: any) {
    if (error.name === "AbortError") {
      return {
        error: new RequestError({ message: "Request aborted", status: 499 }),
      };
    }

    return {
      error:
        error instanceof RequestError
          ? error
          : new RequestError({
              message:
                error?.message ||
                t("ai.assistant.messages.aiAgentRequestFailed"),
              status: 500,
            }),
    };
  }
};
