import { t } from "@excalidraw/excalidraw/i18n";

import { loadAIAgentConfig } from "./agentConfig";
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

export const sendMessageToGeneralAgent = async ({
  agentId,
  messages,
  onChunk,
  onStreamCreated,
  signal,
}: SendMessageOptions): Promise<SendMessageResult> => {
  const config = loadAIAgentConfig();
  const generalAgent = config.llmAgents.find((agent) => agent.id === agentId);

  if (!generalAgent) {
    return {
      content: "",
      error: new Error(t("ai.assistant.messages.generalAgentNotFound")),
    };
  }

  const result = await submitTextAgent({
    agent: generalAgent,
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
