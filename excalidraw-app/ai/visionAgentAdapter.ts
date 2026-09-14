import { t } from "@excalidraw/excalidraw/i18n";

import {
  DEFAULT_VISION_AGENT_SYSTEM_PROMPT,
  getAIAgentProviderPreset,
} from "./agentProviderPresets";
import { loadAIProxyConfig } from "./proxyConfig";
import {
  AIProxyTransportError,
  fetchAIRequest,
  getManagedRouteForCapability,
  MANAGED_GATEWAY_TARGET,
} from "./requestTransport";

import type { AIAgent } from "./types";
import type { AIProxyConfigV2 } from "./proxyConfig";
import type { AiGatewayCatalogEntry } from "../data/cloud/types";

type VisionAgentRequest = {
  agent: AIAgent | null;
  image: string;
  texts: string;
  theme: string;
  signal?: AbortSignal;
};

type VisionAgentExecutionRequest = VisionAgentRequest & {
  agent: AIAgent;
  managedRoute?: AiGatewayCatalogEntry;
  transportConfig?: AIProxyConfigV2;
};

const getManagedProvider = (
  route: AiGatewayCatalogEntry,
): AIAgent["provider"] => {
  const protocol = route.wireProtocol.toLowerCase();
  if (protocol.includes("anthropic")) {
    return "anthropic";
  }
  if (protocol.includes("gemini")) {
    return "gemini";
  }
  return "openai-compatible";
};

const createManagedAgent = (
  route: AiGatewayCatalogEntry,
  configured: AIAgent | null,
): AIAgent => ({
  id: configured?.id || `managed:${route.id}`,
  name: configured?.name || route.label,
  type: configured?.type || "vision",
  provider: getManagedProvider(route),
  baseURL: MANAGED_GATEWAY_TARGET,
  apiKey: "",
  model: route.model,
  ...(configured?.systemPrompt
    ? { systemPrompt: configured.systemPrompt }
    : {}),
});

const managedTransportOptions = (request: VisionAgentExecutionRequest) => ({
  ...(request.managedRoute ? { managedRoute: request.managedRoute } : {}),
  ...(request.transportConfig ? { config: request.transportConfig } : {}),
  ...(request.managedRoute ? { managedOperation: "generate" } : {}),
});

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

const getGeminiGenerateEndpoint = (agent: AIAgent) => {
  return appendEndpoint(
    agent.baseURL,
    `/models/${encodeURIComponent(agent.model)}:generateContent`,
  );
};

const getSystemPrompt = (agent: AIAgent) => {
  return (
    agent.systemPrompt?.trim() ||
    getAIAgentProviderPreset(agent.provider)?.defaultSystemPrompts.vision ||
    DEFAULT_VISION_AGENT_SYSTEM_PROMPT
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

const readString = (value: unknown) => {
  return typeof value === "string" ? value : "";
};

const getMimeTypeFromDataURL = (dataURL: string) => {
  return dataURL.match(/^data:([^;,]+)[;,]/)?.[1] || "image/jpeg";
};

const dataURLToBase64Payload = (dataURL: string) => {
  const [, base64Payload] = dataURL.split(",");

  return base64Payload || dataURL;
};

const buildVisionPrompt = (request: VisionAgentRequest) => {
  return [
    "Convert this Excalidraw wireframe into complete, working HTML and CSS.",
    `Theme: ${request.theme}.`,
    request.texts.trim()
      ? `Text extracted from the selected frame:\n${request.texts}`
      : "No text was extracted from the selected frame.",
    "Return only the complete HTML document. Do not include markdown fences.",
  ].join("\n\n");
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

const stripMarkdownFence = (value: string) => {
  const trimmedValue = value.trim();
  const fenceMatch = trimmedValue.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i);

  return fenceMatch ? fenceMatch[1].trim() : trimmedValue;
};

const extractOpenAIContent = (responseJSON: any) => {
  return readString(responseJSON?.choices?.[0]?.message?.content);
};

const extractAnthropicContent = (responseJSON: any) => {
  const parts = Array.isArray(responseJSON?.content)
    ? responseJSON.content
    : [];

  return parts
    .map((part: Record<string, unknown>) => readString(part?.text))
    .filter(Boolean)
    .join("");
};

const extractGeminiContent = (responseJSON: any) => {
  const parts = responseJSON?.candidates?.[0]?.content?.parts;

  return Array.isArray(parts)
    ? parts
        .map((part: Record<string, unknown>) => readString(part?.text))
        .filter(Boolean)
        .join("")
    : "";
};

const assertConfiguredAgent = (agent: AIAgent | null): AIAgent => {
  if (!agent) {
    throw new Error(t("ai.assistant.messages.visionAgentNotConfigured"));
  }

  if (!agent.baseURL.trim() || !agent.model.trim()) {
    throw new Error(t("ai.assistant.messages.visionAgentIncomplete"));
  }

  return agent;
};

const generateWithOpenAICompatibleVisionAgent = async (
  request: VisionAgentExecutionRequest,
) => {
  const agent = request.agent;
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/json",
  });
  const authorizationHeader = getAuthorizationHeaderValue(agent.apiKey);

  if (authorizationHeader) {
    headers.set("Authorization", authorizationHeader);
  }

  const response = await fetchAIRequest(
    getOpenAIChatEndpoint(agent),
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: agent.model,
        messages: [
          { role: "system", content: getSystemPrompt(agent) },
          {
            role: "user",
            content: [
              { type: "text", text: buildVisionPrompt(request) },
              {
                type: "image_url",
                image_url: {
                  url: request.image,
                },
              },
            ],
          },
        ],
      }),
      signal: request.signal,
    },
    {
      kind: "vision-agent",
      signal: request.signal,
      auditPrompt: buildVisionPrompt(request),
      ...managedTransportOptions(request),
    },
  );

  if (!response.ok) {
    throw new Error(await getProviderErrorMessage(response));
  }

  return extractOpenAIContent(await parseResponseJSON(response));
};

const generateWithAnthropicVisionAgent = async (
  request: VisionAgentExecutionRequest,
) => {
  const agent = request.agent;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };
  if (!request.managedRoute) {
    headers["x-api-key"] = agent.apiKey.trim();
  }
  const response = await fetchAIRequest(
    getAnthropicMessagesEndpoint(agent),
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: agent.model,
        max_tokens: 4096,
        system: getSystemPrompt(agent),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: buildVisionPrompt(request) },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: getMimeTypeFromDataURL(request.image),
                  data: dataURLToBase64Payload(request.image),
                },
              },
            ],
          },
        ],
      }),
      signal: request.signal,
    },
    {
      kind: "vision-agent",
      signal: request.signal,
      auditPrompt: buildVisionPrompt(request),
      ...managedTransportOptions(request),
    },
  );

  if (!response.ok) {
    throw new Error(await getProviderErrorMessage(response));
  }

  return extractAnthropicContent(await parseResponseJSON(response));
};

const generateWithGeminiVisionAgent = async (
  request: VisionAgentExecutionRequest,
) => {
  const agent = request.agent;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (!request.managedRoute) {
    headers["x-goog-api-key"] = agent.apiKey.trim();
  }
  const response = await fetchAIRequest(
    getGeminiGenerateEndpoint(agent),
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: getSystemPrompt(agent) }],
        },
        contents: [
          {
            role: "user",
            parts: [
              { text: buildVisionPrompt(request) },
              {
                inline_data: {
                  mime_type: getMimeTypeFromDataURL(request.image),
                  data: dataURLToBase64Payload(request.image),
                },
              },
            ],
          },
        ],
      }),
      signal: request.signal,
    },
    {
      kind: "vision-agent",
      signal: request.signal,
      auditPrompt: buildVisionPrompt(request),
      ...managedTransportOptions(request),
    },
  );

  if (!response.ok) {
    throw new Error(await getProviderErrorMessage(response));
  }

  return extractGeminiContent(await parseResponseJSON(response));
};

export const generateDiagramCodeWithVisionAgent = async (
  request: VisionAgentRequest,
) => {
  const transportConfig = loadAIProxyConfig();
  const managed = transportConfig.mode === "managed-gateway";
  const managedRoute = managed
    ? await getManagedRouteForCapability("vision-agent", {
        config: transportConfig,
      })
    : undefined;
  if (managedRoute && !managedRoute.operations.includes("generate")) {
    throw new AIProxyTransportError(
      "proxy-config",
      t("ai.proxy.errors.managedRouteMissing"),
    );
  }
  const agent = managedRoute
    ? createManagedAgent(managedRoute, request.agent)
    : assertConfiguredAgent(request.agent);
  const executionRequest: VisionAgentExecutionRequest = {
    ...request,
    agent,
    ...(managedRoute ? { managedRoute, transportConfig } : {}),
  };
  const html =
    agent.provider === "anthropic"
      ? await generateWithAnthropicVisionAgent(executionRequest)
      : agent.provider === "gemini"
      ? await generateWithGeminiVisionAgent(executionRequest)
      : await generateWithOpenAICompatibleVisionAgent(executionRequest);

  if (!html.trim()) {
    throw new Error(t("ai.assistant.messages.visionEmptyResponse"));
  }

  return {
    html: stripMarkdownFence(html),
  };
};
