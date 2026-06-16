import { getCustomAgentLLM, loadAIAgentConfig } from "./agentConfig";
import { submitTextAgent } from "./textAgentAdapter";

import type { ChatMessage } from "./types";

type SendMessageOptions = {
  agentId: string;
  messages: readonly ChatMessage[];
  onChunk?: (chunk: string) => void;
  onStreamCreated?: () => void;
  signal?: AbortSignal;
};

type SendMessageResult =
  | {
      content: string;
      error: null;
    }
  | {
      content: "";
      error: Error;
    };

export const sendMessageToCustomAgent = async ({
  agentId,
  messages,
  onChunk,
  onStreamCreated,
  signal,
}: SendMessageOptions): Promise<SendMessageResult> => {
  const config = loadAIAgentConfig();
  const customAgent = config.customAgents.find((agent) => agent.id === agentId);

  if (!customAgent) {
    return {
      content: "",
      error: new Error("Custom Agent not found."),
    };
  }

  const llmAgent = getCustomAgentLLM(config, agentId);

  if (!llmAgent) {
    return {
      content: "",
      error: new Error("LLM Agent not configured for this Custom Agent."),
    };
  }

  const result = await submitTextAgent({
    agent: {
      ...llmAgent,
      systemPrompt: customAgent.systemPrompt,
    },
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    onChunk,
    onStreamCreated,
    signal,
  });

  if (result.error) {
    return {
      content: "",
      error: result.error,
    };
  }

  return {
    content: result.generatedResponse,
    error: null,
  };
};
