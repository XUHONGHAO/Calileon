import { DEFAULT_SIDEBAR } from "@excalidraw/common";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { copyTextToSystemClipboard } from "@excalidraw/excalidraw/clipboard";
import {
  messageCircleIcon,
  PlusIcon,
} from "@excalidraw/excalidraw/components/icons";
import { convertToExcalidrawElements } from "@excalidraw/element";
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import {
  AI_AGENT_CONFIG_UPDATED_EVENT,
  getDefaultCustomAgent,
  loadAIAgentConfig,
  renderSkillInitialPrompt,
} from "../../ai/agentConfig";
import {
  createChatMessage,
  createConversation,
  loadChatHistory,
  saveChatHistory,
  updateConversationTitle,
} from "../../ai/chatHistory";
import { hasMermaidCodeBlock } from "../../ai/codeBlockDetector";
import { sendMessageToCustomAgent } from "../../ai/customAgentAdapter";
import { createAIOpenSettingsEvent } from "../../ai/workflowEvents";

import "./CustomAgentChat.scss";

import type {
  AIAgentConfig,
  AISkill,
  ChatConversation,
  ChatMessage,
  ChatMode,
  CustomAgentChatHistory,
} from "../../ai/types";

type CustomAgentChatProps = {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  incomingPrompt?: {
    id: number;
    prompt: string;
  } | null;
  incomingSkill?: {
    id: number;
    skill: AISkill;
  } | null;
  onSendPromptToWorkbench?: (prompt: string) => void;
};

const CHAT_MODE_OPTIONS: Array<{ value: ChatMode; label: string }> = [
  { value: "agent", label: "Agent mode" },
  { value: "image", label: "Image mode" },
  { value: "video", label: "Video mode" },
  { value: "audio", label: "Audio mode" },
];

const messagePlusIcon = (
  <>
    {messageCircleIcon}
    <span className="CustomAgentChat__plusBadge" aria-hidden="true">
      {PlusIcon}
    </span>
  </>
);

const chevronDownIcon = (
  <svg aria-hidden="true" focusable="false" role="img" viewBox="0 0 24 24">
    <path
      d="M6 9l6 6l6 -6"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    />
  </svg>
);

const trashIcon = (
  <svg aria-hidden="true" focusable="false" role="img" viewBox="0 0 24 24">
    <path
      d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1 -14M9 7V4h6v3"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    />
  </svg>
);

const ASSISTANT_CANVAS_TEXT_LINE_LENGTH = 72;
const STREAM_PREVIEW_FLUSH_MS = 100;

const updateConversationById = (
  history: CustomAgentChatHistory,
  conversationId: string,
  updater: (conversation: ChatConversation) => ChatConversation,
): CustomAgentChatHistory => {
  let didUpdate = false;
  const conversations = history.conversations.map((conversation) => {
    if (conversation.id !== conversationId) {
      return conversation;
    }

    didUpdate = true;
    return updater(conversation);
  });

  if (!didUpdate) {
    return history;
  }

  return {
    ...history,
    conversations,
  };
};

const isAbortRequestError = (error: Error) => {
  return (
    error.name === "AbortError" ||
    (error as Error & { status?: number }).status === 499 ||
    error.message === "Request aborted"
  );
};

export const CustomAgentChat = ({
  excalidrawAPI,
  incomingPrompt,
  incomingSkill,
  onSendPromptToWorkbench,
}: CustomAgentChatProps) => {
  const [agentConfig, setAgentConfig] =
    useState<AIAgentConfig>(loadAIAgentConfig);
  const [history, setHistory] =
    useState<CustomAgentChatHistory>(loadChatHistory);
  const [inputValue, setInputValue] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isSkillsPanelOpen, setIsSkillsPanelOpen] = useState(false);
  const [isModeMenuOpen, setIsModeMenuOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const deferredHistorySearch = useDeferredValue(historySearch);
  const historyRef = useRef(history);
  const mountedRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeRequestRef = useRef<{
    id: number;
    conversationId: string;
    assistantMessageId: string;
    controller: AbortController;
    canceled: boolean;
  } | null>(null);
  const nextRequestIdRef = useRef(0);
  const streamedContentRef = useRef("");
  const streamPreviewTimeoutRef = useRef<number | null>(null);
  const lastIncomingPromptIdRef = useRef<number | null>(null);
  const lastIncomingSkillIdRef = useRef<number | null>(null);
  const didAutoCreateConversationRef = useRef(false);

  const activeConversation = useMemo(
    () =>
      history.conversations.find(
        (conversation) => conversation.id === history.activeConversationId,
      ) || null,
    [history.activeConversationId, history.conversations],
  );
  const activeAgent = useMemo(
    () =>
      activeConversation
        ? agentConfig.customAgents.find(
            (agent) => agent.id === activeConversation.agentId,
          ) || null
        : null,
    [activeConversation, agentConfig.customAgents],
  );
  const pendingSkill = useMemo(
    () =>
      activeConversation?.pendingSkillId
        ? agentConfig.skills.find(
            (skill) => skill.id === activeConversation.pendingSkillId,
          ) || null
        : null,
    [activeConversation?.pendingSkillId, agentConfig.skills],
  );
  const conversationSearchIndex = useMemo(() => {
    return new Map(
      history.conversations.map((conversation) => {
        const agentLabel = getAgentLabel(agentConfig, conversation.agentId);
        const messageText = conversation.messages
          .map((message) => message.content)
          .join(" ");

        return [
          conversation.id,
          `${conversation.title} ${agentLabel} ${messageText}`.toLowerCase(),
        ];
      }),
    );
  }, [agentConfig, history.conversations]);

  const filteredConversations = useMemo(() => {
    const query = deferredHistorySearch.trim().toLowerCase();

    if (!query) {
      return history.conversations;
    }

    return history.conversations.filter((conversation) => {
      return conversationSearchIndex.get(conversation.id)?.includes(query);
    });
  }, [conversationSearchIndex, deferredHistorySearch, history.conversations]);

  const setLocalHistory = useCallback((nextHistory: CustomAgentChatHistory) => {
    historyRef.current = nextHistory;
    setHistory(nextHistory);
  }, []);

  const persistHistory = useCallback((nextHistory: CustomAgentChatHistory) => {
    const savedHistory = saveChatHistory(nextHistory);
    historyRef.current = savedHistory;
    setHistory(savedHistory);
  }, []);

  const updateConversation = useCallback(
    (
      conversationId: string,
      updater: (conversation: ChatConversation) => ChatConversation,
      options: {
        persist?: boolean;
        sourceHistory?: CustomAgentChatHistory;
      } = {},
    ) => {
      const sourceHistory = options.sourceHistory || historyRef.current;
      const nextHistory = updateConversationById(
        sourceHistory,
        conversationId,
        updater,
      );

      if (nextHistory === sourceHistory) {
        return sourceHistory;
      }

      if (options.persist === false) {
        setLocalHistory(nextHistory);
      } else {
        persistHistory(nextHistory);
      }

      return nextHistory;
    },
    [persistHistory, setLocalHistory],
  );

  const updateActiveConversation = useCallback(
    (
      updater: (conversation: ChatConversation) => ChatConversation,
      sourceHistory = history,
    ) => {
      if (!sourceHistory.activeConversationId) {
        return sourceHistory;
      }

      return updateConversation(sourceHistory.activeConversationId, updater, {
        sourceHistory,
      });
    },
    [history, updateConversation],
  );

  const createNewConversation = useCallback(
    (agentId?: string, pendingSkillId?: string) => {
      const defaultAgent = getDefaultCustomAgent(agentConfig);
      const nextAgentId = agentId || defaultAgent?.id || "";

      if (!nextAgentId) {
        setErrorMessage("Create a Custom Agent before starting a chat.");
        setStatusMessage("");
        return null;
      }

      const conversation = {
        ...createConversation(nextAgentId),
        pendingSkillId,
      };
      const nextHistory = {
        conversations: [conversation, ...history.conversations],
        activeConversationId: conversation.id,
      };

      persistHistory(nextHistory);
      setInputValue("");
      setIsHistoryOpen(false);
      setStatusMessage("New chat created.");
      setErrorMessage("");
      return conversation;
    },
    [agentConfig, history.conversations, persistHistory],
  );

  const clearStreamPreviewTimeout = useCallback(() => {
    if (streamPreviewTimeoutRef.current === null) {
      return;
    }

    window.clearTimeout(streamPreviewTimeoutRef.current);
    streamPreviewTimeoutRef.current = null;
  }, []);

  const flushStreamPreview = useCallback(
    (conversationId: string, assistantMessageId: string, content: string) => {
      updateConversation(
        conversationId,
        (conversation) => ({
          ...conversation,
          messages: conversation.messages.map((message) =>
            message.id === assistantMessageId
              ? { ...message, content }
              : message,
          ),
          updatedAt: Date.now(),
        }),
        { persist: false },
      );
    },
    [updateConversation],
  );

  const scheduleStreamPreview = useCallback(
    (conversationId: string, assistantMessageId: string) => {
      if (streamPreviewTimeoutRef.current !== null) {
        return;
      }

      streamPreviewTimeoutRef.current = window.setTimeout(() => {
        streamPreviewTimeoutRef.current = null;
        flushStreamPreview(
          conversationId,
          assistantMessageId,
          streamedContentRef.current,
        );
      }, STREAM_PREVIEW_FLUSH_MS);
    },
    [flushStreamPreview],
  );

  const abortActiveGeneration = useCallback(() => {
    const activeRequest = activeRequestRef.current;

    if (!activeRequest) {
      return;
    }

    activeRequest.canceled = true;
    activeRequest.controller.abort();
    abortControllerRef.current = null;

    if (mountedRef.current) {
      setIsGenerating(false);
    }
  }, []);

  useEffect(() => {
    const reloadConfig = () => {
      setAgentConfig(loadAIAgentConfig());
    };

    window.addEventListener(AI_AGENT_CONFIG_UPDATED_EVENT, reloadConfig);
    window.addEventListener("storage", reloadConfig);

    return () => {
      window.removeEventListener(AI_AGENT_CONFIG_UPDATED_EVENT, reloadConfig);
      window.removeEventListener("storage", reloadConfig);
    };
  }, []);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      clearStreamPreviewTimeout();
      abortActiveGeneration();
    };
  }, [abortActiveGeneration, clearStreamPreviewTimeout]);

  useEffect(() => {
    if (
      activeConversation ||
      !agentConfig.customAgents.length ||
      didAutoCreateConversationRef.current
    ) {
      return;
    }

    didAutoCreateConversationRef.current = true;
    createNewConversation();
  }, [
    activeConversation,
    agentConfig.customAgents.length,
    createNewConversation,
  ]);

  useEffect(() => {
    if (
      !incomingPrompt ||
      incomingPrompt.id === lastIncomingPromptIdRef.current
    ) {
      return;
    }

    lastIncomingPromptIdRef.current = incomingPrompt.id;
    setInputValue((current) =>
      current.trim()
        ? `${current.trimEnd()}\n\n${incomingPrompt.prompt}`
        : incomingPrompt.prompt,
    );
    setStatusMessage("Prompt loaded from AI Workbench.");
    setErrorMessage("");
  }, [incomingPrompt]);

  const switchConversation = useCallback(
    (conversationId: string) => {
      abortActiveGeneration();
      persistHistory({
        ...history,
        activeConversationId: conversationId,
      });
      setInputValue("");
      setIsHistoryOpen(false);
      setStatusMessage("");
      setErrorMessage("");
    },
    [abortActiveGeneration, history, persistHistory],
  );

  const deleteConversation = useCallback(
    (conversationId: string) => {
      if (
        activeRequestRef.current?.conversationId === conversationId ||
        history.activeConversationId === conversationId
      ) {
        abortActiveGeneration();
      }

      const nextConversations = history.conversations.filter(
        (conversation) => conversation.id !== conversationId,
      );
      const nextActiveConversationId =
        history.activeConversationId === conversationId
          ? nextConversations[0]?.id || null
          : history.activeConversationId;

      persistHistory({
        conversations: nextConversations,
        activeConversationId: nextActiveConversationId,
      });
    },
    [abortActiveGeneration, history, persistHistory],
  );

  const clearAllConversations = useCallback(() => {
    if (!window.confirm("Clear all AI Assistant conversations?")) {
      return;
    }

    abortActiveGeneration();
    persistHistory({
      conversations: [],
      activeConversationId: null,
    });
    setInputValue("");
    setStatusMessage("All chats cleared.");
    setErrorMessage("");
    setIsHistoryOpen(false);
  }, [abortActiveGeneration, persistHistory]);

  const switchAgent = useCallback(
    (agentId: string) => {
      abortActiveGeneration();
      updateActiveConversation((conversation) => ({
        ...conversation,
        agentId,
        pendingSkillId: undefined,
        updatedAt: Date.now(),
      }));
      setStatusMessage("Agent switched.");
      setErrorMessage("");
    },
    [abortActiveGeneration, updateActiveConversation],
  );

  const selectSkill = useCallback(
    (skill: AISkill) => {
      abortActiveGeneration();

      if (activeConversation) {
        updateActiveConversation((conversation) => ({
          ...conversation,
          agentId: skill.agentId,
          pendingSkillId: skill.initialPrompt ? skill.id : undefined,
          updatedAt: Date.now(),
        }));
      } else {
        createNewConversation(
          skill.agentId,
          skill.initialPrompt ? skill.id : undefined,
        );
      }

      setIsSkillsPanelOpen(false);
      setStatusMessage(
        skill.initialPrompt
          ? `${skill.name} selected. Type your input to start.`
          : `${skill.name} selected.`,
      );
      setErrorMessage("");
    },
    [
      abortActiveGeneration,
      activeConversation,
      createNewConversation,
      updateActiveConversation,
    ],
  );

  useEffect(() => {
    if (!incomingSkill || incomingSkill.id === lastIncomingSkillIdRef.current) {
      return;
    }

    lastIncomingSkillIdRef.current = incomingSkill.id;
    selectSkill(incomingSkill.skill);
  }, [incomingSkill, selectSkill]);

  const sendMessage = useCallback(async () => {
    const content = inputValue.trim();

    if (!content || isGenerating || activeRequestRef.current) {
      return;
    }

    const conversation = activeConversation || createNewConversation();

    if (!conversation) {
      return;
    }

    const agentId = conversation.agentId;
    const pending = conversation.pendingSkillId
      ? agentConfig.skills.find(
          (skill) => skill.id === conversation.pendingSkillId,
        )
      : null;
    const contentForAgent =
      pending?.initialPrompt && pending.agentId === agentId
        ? renderSkillInitialPrompt(pending, content)
        : content;
    const userMessage = createChatMessage("user", content, agentId);
    const assistantMessage = createChatMessage("assistant", "", agentId);
    const now = Date.now();
    const nextConversation = updateConversationTitle({
      ...conversation,
      pendingSkillId: undefined,
      messages: [...conversation.messages, userMessage, assistantMessage],
      updatedAt: now,
    });
    const nextHistory = {
      activeConversationId: nextConversation.id,
      conversations: [
        nextConversation,
        ...history.conversations.filter(
          (item) => item.id !== nextConversation.id,
        ),
      ],
    };

    persistHistory(nextHistory);
    setInputValue("");
    setStatusMessage("");
    setErrorMessage("");
    setIsGenerating(true);

    const abortController = new AbortController();
    const requestId = nextRequestIdRef.current + 1;
    nextRequestIdRef.current = requestId;
    abortControllerRef.current = abortController;
    streamedContentRef.current = "";
    activeRequestRef.current = {
      id: requestId,
      conversationId: nextConversation.id,
      assistantMessageId: assistantMessage.id,
      controller: abortController,
      canceled: false,
    };

    const messagesForAgent = [
      ...conversation.messages,
      {
        ...userMessage,
        content: contentForAgent,
      },
    ];
    const result = await sendMessageToCustomAgent({
      agentId,
      messages: messagesForAgent,
      signal: abortController.signal,
      onChunk: (chunk) => {
        if (!mountedRef.current || activeRequestRef.current?.id !== requestId) {
          return;
        }

        streamedContentRef.current += chunk;
        scheduleStreamPreview(nextConversation.id, assistantMessage.id);
      },
    });

    clearStreamPreviewTimeout();

    const activeRequest = activeRequestRef.current;

    if (
      !mountedRef.current ||
      !activeRequest ||
      activeRequest.id !== requestId
    ) {
      return;
    }

    flushStreamPreview(
      activeRequest.conversationId,
      activeRequest.assistantMessageId,
      streamedContentRef.current,
    );

    setIsGenerating(false);
    abortControllerRef.current = null;
    activeRequestRef.current = null;

    if (result.error) {
      if (activeRequest.canceled || isAbortRequestError(result.error)) {
        updateConversation(activeRequest.conversationId, (current) => ({
          ...current,
          messages: current.messages.map((message) =>
            message.id === activeRequest.assistantMessageId
              ? { ...message, content: streamedContentRef.current }
              : message,
          ),
          updatedAt: Date.now(),
        }));
        setStatusMessage("Response canceled.");
        setErrorMessage("");
        return;
      }

      updateConversation(activeRequest.conversationId, (current) => ({
        ...current,
        messages: current.messages.filter(
          (message) => message.id !== activeRequest.assistantMessageId,
        ),
        updatedAt: Date.now(),
      }));
      setErrorMessage(result.error.message || "AI Assistant request failed.");
      return;
    }

    const finalAssistantMessage = createChatMessage(
      "assistant",
      result.content || streamedContentRef.current,
      agentId,
    );

    updateConversation(activeRequest.conversationId, (current) => ({
      ...current,
      messages: current.messages.map((message) =>
        message.id === activeRequest.assistantMessageId
          ? {
              ...finalAssistantMessage,
              id: activeRequest.assistantMessageId,
              timestamp: assistantMessage.timestamp,
            }
          : message,
      ),
      updatedAt: Date.now(),
    }));
  }, [
    activeConversation,
    agentConfig.skills,
    clearStreamPreviewTimeout,
    createNewConversation,
    flushStreamPreview,
    history.conversations,
    inputValue,
    isGenerating,
    persistHistory,
    scheduleStreamPreview,
    updateConversation,
  ]);

  const cancelGeneration = useCallback(() => {
    abortActiveGeneration();
  }, [abortActiveGeneration]);

  const showComingSoon = useCallback(
    (mode: ChatMode) => {
      if (mode === "agent") {
        updateActiveConversation((conversation) => ({
          ...conversation,
          mode: "agent",
          updatedAt: Date.now(),
        }));
        setIsModeMenuOpen(false);
        return;
      }

      setStatusMessage("This mode is coming soon.");
      setIsModeMenuOpen(false);
    },
    [updateActiveConversation],
  );

  const openAISettings = useCallback(() => {
    excalidrawAPI?.toggleSidebar({
      name: null,
      force: false,
    });
    window.dispatchEvent(createAIOpenSettingsEvent({ tab: "agents" }));
  }, [excalidrawAPI]);

  const copyCode = useCallback(async (code: string) => {
    await copyTextToSystemClipboard(code);
    setStatusMessage("Copied.");
    setErrorMessage("");
  }, []);

  const sendPromptToWorkbench = useCallback(
    (prompt: string) => {
      onSendPromptToWorkbench?.(prompt);
      excalidrawAPI?.toggleSidebar({
        name: DEFAULT_SIDEBAR.name,
        tab: "ai-image",
        force: true,
      });
      setStatusMessage("Sent to AI Workbench.");
      setErrorMessage("");
    },
    [excalidrawAPI, onSendPromptToWorkbench],
  );

  const insertMermaid = useCallback(
    async (definition: string) => {
      if (!excalidrawAPI) {
        return;
      }

      try {
        const api = await import("@excalidraw/mermaid-to-excalidraw");
        const { elements: skeletonElements, files = {} } =
          await parseMermaidDefinition(api, definition);
        const mermaidElements = centerElementsInViewport(
          convertToExcalidrawElements(skeletonElements, {
            regenerateIds: true,
          }),
          excalidrawAPI,
        );

        if (!mermaidElements.length) {
          throw new Error("No Excalidraw elements were generated.");
        }

        const fileValues = Object.values(files);

        if (fileValues.length) {
          excalidrawAPI.addFiles(fileValues);
        }

        excalidrawAPI.updateScene({
          elements: [
            ...excalidrawAPI.getSceneElementsIncludingDeleted(),
            ...mermaidElements,
          ],
          appState: {
            selectedElementIds: Object.fromEntries(
              mermaidElements.map((element) => [element.id, true]),
            ),
          },
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
        excalidrawAPI.scrollToContent(mermaidElements, {
          fitToContent: true,
        });
        excalidrawAPI.setToast({
          message: "Inserted Mermaid diagram.",
          duration: 3000,
        });
      } catch (error: any) {
        excalidrawAPI.setToast({
          message: error?.message || "Could not insert Mermaid diagram.",
          duration: 4000,
        });
      }
    },
    [excalidrawAPI],
  );

  const insertAssistantText = useCallback(
    (text: string) => {
      insertAssistantTextToCanvas(excalidrawAPI, text);
    },
    [excalidrawAPI],
  );

  return (
    <div className="CustomAgentChat">
      <header className="CustomAgentChat__header">
        <div>
          <strong>AI Assistant</strong>
          <span>Custom Agents and Skills</span>
        </div>
        <div className="CustomAgentChat__headerActions">
          <button
            type="button"
            title="New chat"
            aria-label="New chat"
            className="CustomAgentChat__iconButton CustomAgentChat__newChatButton"
            onClick={() => createNewConversation()}
          >
            <span className="CustomAgentChat__chatPlusIcon" aria-hidden="true">
              {messagePlusIcon}
            </span>
          </button>
          <button
            type="button"
            title="Recent chats"
            aria-label="Recent chats"
            className="CustomAgentChat__iconButton"
            aria-expanded={isHistoryOpen}
            onClick={() => setIsHistoryOpen((open) => !open)}
          >
            {chevronDownIcon}
          </button>
          <button
            type="button"
            title="Clear chats"
            aria-label="Clear chats"
            className="CustomAgentChat__iconButton"
            onClick={clearAllConversations}
          >
            {trashIcon}
          </button>
        </div>
      </header>

      {isHistoryOpen && (
        <section
          className="CustomAgentChat__historyPopover"
          aria-label="Recent chats"
        >
          <div className="CustomAgentChat__historyHeader">
            <strong>Recent Chats</strong>
            <span>{history.conversations.length}</span>
          </div>
          <input
            className="CustomAgentChat__historySearch"
            type="search"
            value={historySearch}
            placeholder="Search history"
            onChange={(event) => setHistorySearch(event.target.value)}
          />
          <div className="CustomAgentChat__historyList">
            {filteredConversations.length === 0 && (
              <div className="CustomAgentChat__empty">
                {history.conversations.length === 0
                  ? "No chats yet."
                  : "No chats found."}
              </div>
            )}
            {filteredConversations.map((conversation) => (
              <div
                key={conversation.id}
                className={
                  conversation.id === activeConversation?.id
                    ? "CustomAgentChat__conversation is-selected"
                    : "CustomAgentChat__conversation"
                }
              >
                <button
                  type="button"
                  className="CustomAgentChat__conversationSelect"
                  aria-current={
                    conversation.id === activeConversation?.id
                      ? "true"
                      : undefined
                  }
                  onClick={() => switchConversation(conversation.id)}
                >
                  <strong>{conversation.title}</strong>
                  <small>
                    with {getAgentLabel(agentConfig, conversation.agentId)}
                  </small>
                  <small>
                    {conversation.messages.length} messages -{" "}
                    {formatRelativeTime(conversation.updatedAt)}
                  </small>
                </button>
                <button
                  type="button"
                  className="CustomAgentChat__conversationDelete"
                  title="Delete chat"
                  aria-label={`Delete chat ${conversation.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteConversation(conversation.id);
                  }}
                >
                  x
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {!agentConfig.customAgents.length && (
        <div className="CustomAgentChat__notice">
          Create an LLM Agent and Custom Agent in AI Settings before chatting.
          <button type="button" onClick={openAISettings}>
            Open AI Settings
          </button>
        </div>
      )}

      <section className="CustomAgentChat__chat">
        <div className="CustomAgentChat__messages">
          {!activeConversation?.messages.length && (
            <div className="CustomAgentChat__empty">
              Start a new conversation with {activeAgent?.name || "an agent"}.
            </div>
          )}
          {activeConversation?.messages.map((message) => (
            <ChatMessageView
              key={message.id}
              message={message}
              onCopyCode={copyCode}
              onSendPromptToWorkbench={sendPromptToWorkbench}
              onInsertMermaid={insertMermaid}
              onInsertTextToCanvas={insertAssistantText}
              canInsertToCanvas={!!excalidrawAPI}
            />
          ))}
        </div>

        <label className="CustomAgentChat__input">
          <textarea
            aria-label="Message"
            value={inputValue}
            rows={4}
            disabled={isGenerating || !agentConfig.customAgents.length}
            placeholder={
              pendingSkill?.initialPrompt
                ? "Type the input for this Skill..."
                : "Describe what you need..."
            }
            onChange={(event) => setInputValue(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                sendMessage();
              }
            }}
          />
        </label>

        <div className="CustomAgentChat__footer">
          <label className="CustomAgentChat__agentSelect">
            <span>Agent</span>
            <select
              value={activeConversation?.agentId || ""}
              disabled={!activeConversation || !agentConfig.customAgents.length}
              onChange={(event) => switchAgent(event.target.value)}
            >
              {agentConfig.customAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.icon} {agent.name}
                </option>
              ))}
            </select>
          </label>
          <div className="CustomAgentChat__footerActions">
            <button
              type="button"
              onClick={() => setIsSkillsPanelOpen((open) => !open)}
            >
              Skills
            </button>
            <button
              type="button"
              onClick={() => setIsModeMenuOpen((open) => !open)}
            >
              {activeConversation?.mode === "agent"
                ? "Agent"
                : activeConversation?.mode || "Agent"}{" "}
              v
            </button>
            <button type="button" onClick={openAISettings}>
              Settings
            </button>
            {pendingSkill && (
              <span className="CustomAgentChat__pendingSkill">
                {pendingSkill.icon} {pendingSkill.name}
              </span>
            )}
            <button
              type="button"
              className="CustomAgentChat__sendButton"
              disabled={!inputValue.trim() || isGenerating}
              onClick={sendMessage}
            >
              {isGenerating ? "Sending..." : "Send"}
            </button>
            {isGenerating && (
              <button type="button" onClick={cancelGeneration}>
                Cancel
              </button>
            )}
          </div>
        </div>

        {isSkillsPanelOpen && (
          <div className="CustomAgentChat__popover">
            <strong>Skills</strong>
            {agentConfig.skills.length === 0 && (
              <span>No Skills configured.</span>
            )}
            {agentConfig.skills.map((skill) => (
              <button
                key={skill.id}
                type="button"
                onClick={() => selectSkill(skill)}
              >
                {skill.icon} {skill.name}
              </button>
            ))}
            <button type="button" onClick={openAISettings}>
              Manage Skills
            </button>
          </div>
        )}

        {isModeMenuOpen && (
          <div className="CustomAgentChat__popover CustomAgentChat__popover--mode">
            <strong>Mode</strong>
            {CHAT_MODE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                disabled={option.value !== "agent"}
                title={
                  option.value === "agent"
                    ? option.label
                    : `${option.label} mode is preview-only.`
                }
                onClick={() => showComingSoon(option.value)}
              >
                {activeConversation?.mode === option.value ? "* " : ""}
                {option.label}
                {option.value !== "agent" ? " (preview)" : ""}
              </button>
            ))}
          </div>
        )}
      </section>

      {(statusMessage || errorMessage) && (
        <div
          role={errorMessage ? "alert" : "status"}
          className={
            errorMessage
              ? "CustomAgentChat__message is-error"
              : "CustomAgentChat__message"
          }
        >
          {errorMessage || statusMessage}
        </div>
      )}
    </div>
  );
};

type ChatMessageViewProps = {
  message: ChatMessage;
  onCopyCode: (code: string) => void;
  onSendPromptToWorkbench: (prompt: string) => void;
  onInsertMermaid: (definition: string) => void;
  onInsertTextToCanvas: (text: string) => void;
  canInsertToCanvas?: boolean;
};

export const ChatMessageView = memo(
  ({
    message,
    onCopyCode,
    onSendPromptToWorkbench,
    onInsertMermaid,
    onInsertTextToCanvas,
    canInsertToCanvas = true,
  }: ChatMessageViewProps) => {
    const canvasText = useMemo(
      () => getAssistantCanvasText(message),
      [message],
    );
    const mermaidDefinition = useMemo(
      () => getMermaidDefinition(message),
      [message],
    );

    return (
      <article
        className={
          message.role === "user"
            ? "CustomAgentChat__chatMessage is-user"
            : "CustomAgentChat__chatMessage"
        }
      >
        <div className="CustomAgentChat__messageMeta">
          <strong>{message.role === "user" ? "You" : "Assistant"}</strong>
          <span>{formatTime(message.timestamp)}</span>
        </div>
        <div className="CustomAgentChat__messageContent">
          {message.content || "Thinking..."}
        </div>
        {message.codeBlocks?.map((block, index) => (
          <div
            className="CustomAgentChat__codeBlock"
            key={`${block.code}-${index}`}
          >
            <pre>{block.code}</pre>
            <div>
              <button type="button" onClick={() => onCopyCode(block.code)}>
                Copy Code
              </button>
            </div>
          </div>
        ))}
        {message.detectedPrompt && (
          <button
            className="CustomAgentChat__inlineAction"
            type="button"
            onClick={() =>
              onSendPromptToWorkbench(message.detectedPrompt!.text)
            }
          >
            Send to Workbench
          </button>
        )}
        {canvasText && (
          <button
            className="CustomAgentChat__inlineAction"
            type="button"
            disabled={!canInsertToCanvas}
            title={
              canInsertToCanvas
                ? "Insert assistant text to canvas"
                : "Canvas is not available"
            }
            onClick={() => onInsertTextToCanvas(canvasText)}
          >
            Insert text to Canvas
          </button>
        )}
        {mermaidDefinition && (
          <button
            className="CustomAgentChat__inlineAction"
            type="button"
            disabled={!canInsertToCanvas}
            title={
              canInsertToCanvas
                ? "Insert Mermaid diagram to canvas"
                : "Canvas is not available"
            }
            onClick={() => onInsertMermaid(mermaidDefinition)}
          >
            Insert Mermaid to Canvas
          </button>
        )}
      </article>
    );
  },
);

ChatMessageView.displayName = "ChatMessageView";

const getAgentLabel = (config: AIAgentConfig, agentId: string) => {
  const agent = config.customAgents.find((item) => item.id === agentId);

  return agent ? `${agent.name} ${agent.icon}` : "Missing agent";
};

const formatTime = (timestamp: number) => {
  if (!timestamp) {
    return "";
  }

  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
};

const formatRelativeTime = (timestamp: number) => {
  const diff = Date.now() - timestamp;

  if (diff < 60 * 1000) {
    return "just now";
  }

  if (diff < 60 * 60 * 1000) {
    return `${Math.floor(diff / (60 * 1000))} min ago`;
  }

  if (diff < 24 * 60 * 60 * 1000) {
    return `${Math.floor(diff / (60 * 60 * 1000))} hours ago`;
  }

  return new Date(timestamp).toLocaleDateString();
};

const getMermaidDefinition = (message: ChatMessage) => {
  if (!hasMermaidCodeBlock(message.content)) {
    return null;
  }

  return (
    message.codeBlocks?.find((block) => {
      const language = block.language.toLowerCase();
      const code = block.code.trim();

      return (
        language === "mermaid" ||
        /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie)\b/.test(
          code,
        )
      );
    })?.code || null
  );
};

export const getAssistantCanvasText = (message: ChatMessage) => {
  if (message.role !== "assistant") {
    return null;
  }

  return formatAssistantCanvasText(message.content);
};

export const formatAssistantCanvasText = (content: string) => {
  const text = content.replace(/```[\s\S]*?```/g, "").trim();

  if (!text) {
    return null;
  }

  return text
    .split(/\r?\n/)
    .flatMap((line) =>
      wrapAssistantCanvasTextLine(
        line.replace(/\s+/g, " ").trim(),
        ASSISTANT_CANVAS_TEXT_LINE_LENGTH,
      ),
    )
    .join("\n")
    .trim();
};

export const insertAssistantTextToCanvas = (
  excalidrawAPI: ExcalidrawImperativeAPI | null,
  text: string,
) => {
  if (!excalidrawAPI) {
    return false;
  }

  const canvasText = formatAssistantCanvasText(text);

  if (!canvasText) {
    return false;
  }

  const textElements = centerElementsInViewport(
    convertToExcalidrawElements(
      [
        {
          type: "text",
          x: 0,
          y: 0,
          text: canvasText,
          fontSize: 20,
        },
      ],
      {
        regenerateIds: true,
      },
    ),
    excalidrawAPI,
  );

  if (!textElements.length) {
    return false;
  }

  excalidrawAPI.updateScene({
    elements: [
      ...excalidrawAPI.getSceneElementsIncludingDeleted(),
      ...textElements,
    ],
    appState: {
      selectedElementIds: Object.fromEntries(
        textElements.map((element) => [element.id, true]),
      ),
    },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  excalidrawAPI.scrollToContent(textElements, {
    fitToContent: true,
  });
  excalidrawAPI.setToast({
    message: "Inserted assistant text.",
    duration: 3000,
  });

  return true;
};

const wrapAssistantCanvasTextLine = (line: string, maxLength: number) => {
  if (!line) {
    return [""];
  }

  const words = line.split(" ");
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    if (!currentLine) {
      currentLine = word;
      continue;
    }

    if (`${currentLine} ${word}`.length > maxLength) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = `${currentLine} ${word}`;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
};

const parseMermaidDefinition = async (
  api: typeof import("@excalidraw/mermaid-to-excalidraw"),
  definition: string,
) => {
  try {
    return await api.parseMermaidToExcalidraw(definition);
  } catch (error) {
    if (!definition.includes('"')) {
      throw error;
    }

    return api.parseMermaidToExcalidraw(definition.replace(/"/g, "'"));
  }
};

const centerElementsInViewport = (
  elements: readonly ExcalidrawElement[],
  excalidrawAPI: ExcalidrawImperativeAPI,
) => {
  if (!elements.length) {
    return [];
  }

  const appState = excalidrawAPI.getAppState();
  const zoom = appState.zoom.value || 1;
  const sceneCenterX = (appState.width / 2 - appState.scrollX) / zoom;
  const sceneCenterY = (appState.height / 2 - appState.scrollY) / zoom;
  const bounds = elements.reduce(
    (acc, element) => ({
      minX: Math.min(acc.minX, element.x),
      minY: Math.min(acc.minY, element.y),
      maxX: Math.max(acc.maxX, element.x + element.width),
      maxY: Math.max(acc.maxY, element.y + element.height),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    },
  );
  const offsetX = sceneCenterX - (bounds.minX + bounds.maxX) / 2;
  const offsetY = sceneCenterY - (bounds.minY + bounds.maxY) / 2;

  return elements.map((element) => ({
    ...element,
    x: element.x + offsetX,
    y: element.y + offsetY,
  }));
};
