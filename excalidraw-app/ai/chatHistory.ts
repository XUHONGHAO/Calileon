import { STORAGE_KEYS } from "../app_constants";

import { detectCodeBlocks } from "./codeBlockDetector";
import { detectPrompt } from "./promptDetector";

import type {
  ChatConversation,
  ChatMessage,
  ChatMode,
  CustomAgentChatHistory,
} from "./types";

export const CUSTOM_AGENT_CHAT_HISTORY_UPDATED_EVENT =
  "excalidraw-custom-agent-chat-history-updated";

const DEFAULT_CHAT_HISTORY: CustomAgentChatHistory = {
  conversations: [],
  activeConversationId: null,
};

export const createChatConversationId = () => {
  return `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

export const createChatMessageId = () => {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

export const createConversation = (
  agentId: string,
  mode: ChatMode = "agent",
): ChatConversation => {
  const now = Date.now();

  return {
    id: createChatConversationId(),
    title: "New chat",
    agentId,
    mode,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
};

export const createChatMessage = (
  role: ChatMessage["role"],
  content: string,
  agentId: string,
): ChatMessage => {
  const analyzed = analyzeAssistantContent(content);

  return {
    id: createChatMessageId(),
    role,
    content,
    agentId,
    timestamp: Date.now(),
    ...(role === "assistant" ? analyzed : null),
  };
};

export const analyzeAssistantContent = (
  content: string,
): Pick<ChatMessage, "codeBlocks" | "detectedPrompt"> => {
  const codeBlocks = detectCodeBlocks(content);
  const detectedPrompt = detectPrompt(content) || undefined;

  return {
    codeBlocks: codeBlocks.length ? codeBlocks : undefined,
    detectedPrompt,
  };
};

export const generateConversationTitle = (firstMessage: string): string => {
  const title = firstMessage.trim().replace(/\s+/g, " ");
  const maxLength = 20;

  if (!title) {
    return "New chat";
  }

  if (title.length <= maxLength) {
    return title;
  }

  const truncated = title.slice(0, maxLength);
  const lastSpace = truncated.lastIndexOf(" ");

  return `${
    lastSpace > maxLength / 2 ? truncated.slice(0, lastSpace) : truncated
  }...`;
};

export const updateConversationTitle = (
  conversation: ChatConversation,
): ChatConversation => {
  const firstUserMessage = conversation.messages.find(
    (message) => message.role === "user",
  );

  if (!firstUserMessage || conversation.title !== "New chat") {
    return conversation;
  }

  return {
    ...conversation,
    title: generateConversationTitle(firstUserMessage.content),
  };
};

export const normalizeChatHistory = (
  history: Partial<CustomAgentChatHistory> | null | undefined,
): CustomAgentChatHistory => {
  const conversations = Array.isArray(history?.conversations)
    ? history.conversations
        .map(normalizeConversation)
        .filter((conversation): conversation is ChatConversation =>
          Boolean(conversation),
        )
    : [];
  const activeConversationId =
    typeof history?.activeConversationId === "string" &&
    conversations.some(
      (conversation) => conversation.id === history.activeConversationId,
    )
      ? history.activeConversationId
      : conversations[0]?.id || null;

  return {
    conversations,
    activeConversationId,
  };
};

export const loadChatHistory = (): CustomAgentChatHistory => {
  try {
    const raw = localStorage.getItem(
      STORAGE_KEYS.LOCAL_STORAGE_CUSTOM_AGENT_CHAT,
    );

    if (!raw) {
      return DEFAULT_CHAT_HISTORY;
    }

    return normalizeChatHistory(JSON.parse(raw));
  } catch (error: any) {
    console.error(error);
    return DEFAULT_CHAT_HISTORY;
  }
};

export const saveChatHistory = (history: CustomAgentChatHistory) => {
  const normalizedHistory = normalizeChatHistory(history);

  localStorage.setItem(
    STORAGE_KEYS.LOCAL_STORAGE_CUSTOM_AGENT_CHAT,
    JSON.stringify(normalizedHistory),
  );

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(CUSTOM_AGENT_CHAT_HISTORY_UPDATED_EVENT, {
        detail: normalizedHistory,
      }),
    );
  }

  return normalizedHistory;
};

const normalizeConversation = (value: unknown): ChatConversation | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const conversation = value as Partial<ChatConversation>;
  const id = typeof conversation.id === "string" ? conversation.id.trim() : "";
  const agentId =
    typeof conversation.agentId === "string" ? conversation.agentId.trim() : "";

  if (!id || !agentId) {
    return null;
  }

  const messages = Array.isArray(conversation.messages)
    ? conversation.messages
        .map(normalizeMessage)
        .filter((message): message is ChatMessage => Boolean(message))
    : [];

  return {
    id,
    title:
      typeof conversation.title === "string" && conversation.title.trim()
        ? conversation.title.trim()
        : "New chat",
    agentId,
    mode: isChatMode(conversation.mode) ? conversation.mode : "agent",
    messages,
    pendingSkillId:
      typeof conversation.pendingSkillId === "string" &&
      conversation.pendingSkillId.trim()
        ? conversation.pendingSkillId.trim()
        : undefined,
    createdAt:
      typeof conversation.createdAt === "number"
        ? conversation.createdAt
        : Date.now(),
    updatedAt:
      typeof conversation.updatedAt === "number"
        ? conversation.updatedAt
        : Date.now(),
  };
};

const normalizeMessage = (value: unknown): ChatMessage | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const message = value as Partial<ChatMessage>;
  const id = typeof message.id === "string" ? message.id.trim() : "";
  const content =
    typeof message.content === "string" ? message.content.trim() : "";
  const agentId =
    typeof message.agentId === "string" ? message.agentId.trim() : "";

  if (
    !id ||
    !agentId ||
    (message.role !== "user" && message.role !== "assistant") ||
    (message.role === "user" && !content)
  ) {
    return null;
  }

  const analyzed =
    message.role === "assistant" ? analyzeAssistantContent(content) : {};

  return {
    id,
    role: message.role,
    content,
    agentId,
    timestamp: typeof message.timestamp === "number" ? message.timestamp : 0,
    ...analyzed,
  };
};

const isChatMode = (mode: unknown): mode is ChatMode => {
  return (
    mode === "agent" || mode === "image" || mode === "video" || mode === "audio"
  );
};
