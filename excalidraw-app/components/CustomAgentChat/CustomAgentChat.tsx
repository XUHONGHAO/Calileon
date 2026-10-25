import { DEFAULT_SIDEBAR } from "@excalidraw/common";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { copyTextToSystemClipboard } from "@excalidraw/excalidraw/clipboard";
import {
  CloseIcon,
  copyIcon,
  messageCircleIcon,
  PlusIcon,
} from "@excalidraw/excalidraw/components/icons";
import { t } from "@excalidraw/excalidraw/i18n";
import { convertToExcalidrawElements } from "@excalidraw/element";
import clsx from "clsx";
import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import {
  AI_AGENT_CONFIG_UPDATED_EVENT,
  getDefaultLLMAgent,
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
import { sendMessageToGeneralAgent } from "../../ai/customAgentAdapter";
import { createAIOpenSettingsEvent } from "../../ai/workflowEvents";

import {
  Callout,
  confirmAction,
  Popover,
  PopoverHeading,
  TextInput,
  UiButton,
} from "../ui";
import { uiCheckIcon } from "../ui/icons";

import "./CustomAgentChat.scss";

import type {
  AIAgentConfig,
  AISkill,
  ChatConversation,
  ChatMessage,
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

const messagePlusIcon = (
  <>
    {messageCircleIcon}
    <span className="CustomAgentChat__plusBadge" aria-hidden="true">
      {PlusIcon}
    </span>
  </>
);

const chevronUpIcon = (
  <svg aria-hidden="true" focusable="false" role="img" viewBox="0 0 24 24">
    <path
      d="M6 15l6 -6l6 6"
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
// Auto-scroll only while the reader is this close to the bottom (px).
const STICK_TO_BOTTOM_THRESHOLD = 48;

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
  // The last send failed and its text was put back in the composer.
  const [canRetry, setCanRetry] = useState(false);
  const [isAgentMenuOpen, setIsAgentMenuOpen] = useState(false);
  const [isSkillsPanelOpen, setIsSkillsPanelOpen] = useState(false);
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
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const lastScrollConversationRef = useRef<{
    id: string;
    count: number;
  } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const agentButtonRef = useRef<HTMLButtonElement>(null);
  const skillsButtonRef = useRef<HTMLButtonElement>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const historySearchRef = useRef<HTMLInputElement>(null);
  const popoverId = useId();
  const agentMenuId = `${popoverId}-agents`;
  const skillsMenuId = `${popoverId}-skills`;
  const historyPanelId = `${popoverId}-history`;
  const closeAgentMenu = useCallback(() => setIsAgentMenuOpen(false), []);
  const closeSkillsMenu = useCallback(() => setIsSkillsPanelOpen(false), []);
  const closeHistory = useCallback(() => setIsHistoryOpen(false), []);

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
        ? agentConfig.llmAgents.find(
            (agent) => agent.id === activeConversation.agentId,
          ) || null
        : null,
    [activeConversation, agentConfig.llmAgents],
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
  const scrollConversationId = activeConversation?.id || "";
  const scrollMessageCount = activeConversation?.messages.length || 0;
  const scrollLastLength = activeConversation?.messages.at(-1)?.content.length;

  // Follow the stream only while the reader is at the bottom; a new message
  // or a conversation switch always jumps down. Set scrollTop on the list
  // itself (scrollIntoView also scrolled the sidebar and the page).
  useEffect(() => {
    const list = messagesRef.current;
    if (!list) {
      return;
    }
    const previous = lastScrollConversationRef.current;
    const isNewContent =
      !previous ||
      previous.id !== scrollConversationId ||
      previous.count < scrollMessageCount;
    lastScrollConversationRef.current = {
      id: scrollConversationId,
      count: scrollMessageCount,
    };

    if (isNewContent || stickToBottomRef.current) {
      list.scrollTop = list.scrollHeight;
      stickToBottomRef.current = true;
    }
  }, [scrollConversationId, scrollMessageCount, scrollLastLength]);

  const onMessagesScroll = useCallback(() => {
    const list = messagesRef.current;
    if (!list) {
      return;
    }
    stickToBottomRef.current =
      list.scrollHeight - list.scrollTop - list.clientHeight <
      STICK_TO_BOTTOM_THRESHOLD;
  }, []);

  const conversationSearchIndex = useMemo(() => {
    return new Map(
      history.conversations.map((conversation) => {
        const agentLabel = getAgentLabel(agentConfig, conversation.agentId, t);
        const messageText = conversation.messages
          .map((message) => message.content)
          .join(" ");

        return [
          conversation.id,
          `${getConversationTitle(
            conversation,
            t,
          )} ${agentLabel} ${messageText}`.toLowerCase(),
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
      sourceHistory = historyRef.current,
    ) => {
      if (!sourceHistory.activeConversationId) {
        return sourceHistory;
      }

      return updateConversation(sourceHistory.activeConversationId, updater, {
        sourceHistory,
      });
    },
    [updateConversation],
  );

  const createNewConversation = useCallback(
    (agentId?: string, pendingSkillId?: string) => {
      const defaultAgent = getDefaultLLMAgent(agentConfig);
      const nextAgentId = agentId || defaultAgent?.id || "";

      if (!nextAgentId) {
        setErrorMessage(t("ai.assistant.messages.needGeneralAgent"));
        setStatusMessage("");
        setCanRetry(false);
        return null;
      }

      const conversation = {
        ...createConversation(nextAgentId),
        pendingSkillId,
      };
      const nextHistory = {
        conversations: [conversation, ...historyRef.current.conversations],
        activeConversationId: conversation.id,
      };

      persistHistory(nextHistory);
      setInputValue("");
      setCanRetry(false);
      setIsAgentMenuOpen(false);
      setIsSkillsPanelOpen(false);
      setIsHistoryOpen(false);
      setStatusMessage(t("ai.assistant.messages.newChatCreated"));
      setErrorMessage("");
      return conversation;
    },
    [agentConfig, persistHistory],
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

  // Stops the request and settles its reply right away: the streamed part is
  // persisted, an empty bubble is dropped (it would read "Thinking..." with
  // no actions). The request slot is released at once, so a new message can
  // be sent before the adapter acknowledges the abort; the old request's own
  // completion then sees a different id and bails.
  const abortActiveGeneration = useCallback(() => {
    const activeRequest = activeRequestRef.current;

    if (!activeRequest) {
      return false;
    }

    clearStreamPreviewTimeout();
    const partial = streamedContentRef.current;
    updateConversation(activeRequest.conversationId, (conversation) => ({
      ...conversation,
      messages: partial
        ? conversation.messages.map((message) =>
            message.id === activeRequest.assistantMessageId
              ? { ...message, content: partial }
              : message,
          )
        : conversation.messages.filter(
            (message) => message.id !== activeRequest.assistantMessageId,
          ),
      updatedAt: Date.now(),
    }));

    activeRequest.canceled = true;
    activeRequestRef.current = null;
    abortControllerRef.current = null;
    activeRequest.controller.abort();

    if (mountedRef.current) {
      setIsGenerating(false);
    }
    return true;
  }, [clearStreamPreviewTimeout, updateConversation]);

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
      // Closing the sidebar unmounts the chat mid-stream. The preview so far
      // only lives in a ref, so abort persists it (or drops the empty bubble);
      // the request's own completion path bails once unmounted.
      abortActiveGeneration();
      clearStreamPreviewTimeout();
    };
  }, [abortActiveGeneration, clearStreamPreviewTimeout]);

  useEffect(() => {
    if (
      activeConversation ||
      !agentConfig.llmAgents.length ||
      didAutoCreateConversationRef.current
    ) {
      return;
    }

    didAutoCreateConversationRef.current = true;
    createNewConversation();
  }, [activeConversation, agentConfig.llmAgents.length, createNewConversation]);

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
    setStatusMessage(t("ai.assistant.messages.promptLoaded"));
    setErrorMessage("");
  }, [incomingPrompt]);

  const switchConversation = useCallback(
    (conversationId: string) => {
      abortActiveGeneration();
      persistHistory({
        ...historyRef.current,
        activeConversationId: conversationId,
      });
      setInputValue("");
      setCanRetry(false);
      setIsAgentMenuOpen(false);
      setIsSkillsPanelOpen(false);
      setIsHistoryOpen(false);
      setStatusMessage("");
      setErrorMessage("");
    },
    [abortActiveGeneration, persistHistory],
  );

  const deleteConversation = useCallback(
    async (conversationId: string, title: string) => {
      const confirmed = await confirmAction(
        t("ai.assistant.messages.deleteChatConfirm", { title }),
        {
          title: t("ai.assistant.deleteChat"),
          confirmLabel: t("ai.common.delete"),
          danger: true,
        },
      );
      if (!confirmed) {
        return false;
      }

      if (
        activeRequestRef.current?.conversationId === conversationId ||
        historyRef.current.activeConversationId === conversationId
      ) {
        abortActiveGeneration();
      }

      const current = historyRef.current;
      const nextConversations = current.conversations.filter(
        (conversation) => conversation.id !== conversationId,
      );
      const nextActiveConversationId =
        current.activeConversationId === conversationId
          ? nextConversations[0]?.id || null
          : current.activeConversationId;

      persistHistory({
        conversations: nextConversations,
        activeConversationId: nextActiveConversationId,
      });
      return true;
    },
    [abortActiveGeneration, persistHistory],
  );

  const deleteMessage = useCallback(
    async (messageId: string) => {
      const isGeneratingMessage =
        activeRequestRef.current?.assistantMessageId === messageId;
      const confirmed = await confirmAction(
        isGeneratingMessage
          ? t("ai.assistant.messages.deleteGeneratingMessageConfirm")
          : t("ai.assistant.messages.deleteMessageConfirm"),
        {
          title: t("ai.assistant.deleteMessage"),
          confirmLabel: t("ai.common.delete"),
          danger: true,
        },
      );
      if (!confirmed) {
        return;
      }

      if (activeRequestRef.current?.assistantMessageId === messageId) {
        abortActiveGeneration();
      }

      updateActiveConversation((conversation) => ({
        ...conversation,
        messages: conversation.messages.filter(
          (message) => message.id !== messageId,
        ),
        updatedAt: Date.now(),
      }));
    },
    [abortActiveGeneration, updateActiveConversation],
  );

  const clearAllConversations = useCallback(async () => {
    if (
      !(await confirmAction(t("ai.assistant.messages.clearAllConfirm"), {
        title: t("ai.assistant.clearChats"),
        confirmLabel: t("ai.common.clear"),
        danger: true,
      }))
    ) {
      return;
    }

    abortActiveGeneration();
    persistHistory({
      conversations: [],
      activeConversationId: null,
    });
    setInputValue("");
    setCanRetry(false);
    setStatusMessage(t("ai.assistant.messages.allChatsCleared"));
    setErrorMessage("");
    setIsAgentMenuOpen(false);
    setIsSkillsPanelOpen(false);
    setIsHistoryOpen(false);
  }, [abortActiveGeneration, persistHistory]);

  const switchAgent = useCallback(
    (agentId: string) => {
      abortActiveGeneration();
      updateActiveConversation((conversation) => ({
        ...conversation,
        agentId,
        updatedAt: Date.now(),
      }));
      setIsAgentMenuOpen(false);
      setStatusMessage(t("ai.assistant.messages.agentSwitched"));
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
          pendingSkillId: skill.initialPrompt ? skill.id : undefined,
          updatedAt: Date.now(),
        }));
      } else {
        createNewConversation(
          undefined,
          skill.initialPrompt ? skill.id : undefined,
        );
      }

      setIsSkillsPanelOpen(false);
      setIsAgentMenuOpen(false);
      setStatusMessage(
        skill.initialPrompt
          ? t("ai.assistant.messages.skillSelectedWithInput", {
              name: skill.name,
            })
          : t("ai.assistant.messages.skillSelected", { name: skill.name }),
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
    const contentForAgent = pending?.initialPrompt
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
        ...historyRef.current.conversations.filter(
          (item) => item.id !== nextConversation.id,
        ),
      ],
    };

    persistHistory(nextHistory);
    setInputValue("");
    setStatusMessage("");
    setErrorMessage("");
    setCanRetry(false);
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
    const result = await sendMessageToGeneralAgent({
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
      // A user Stop is settled in abortActiveGeneration (the id check above
      // returns). This branch covers an abort raised by the adapter itself.
      if (isAbortRequestError(result.error)) {
        const partial = streamedContentRef.current;
        // An empty cancelled reply would render as a permanent "Thinking..."
        // bubble with no actions, so drop it like the failure path does.
        updateConversation(activeRequest.conversationId, (current) => ({
          ...current,
          messages: partial
            ? current.messages.map((message) =>
                message.id === activeRequest.assistantMessageId
                  ? { ...message, content: partial }
                  : message,
              )
            : current.messages.filter(
                (message) => message.id !== activeRequest.assistantMessageId,
              ),
          updatedAt: Date.now(),
        }));
        setStatusMessage(t("ai.assistant.messages.responseCanceled"));
        setErrorMessage("");
        return;
      }

      // Failed: take the turn back out of the history and put the text back
      // in the composer, so Retry (or Enter) resends it without a duplicate.
      updateConversation(activeRequest.conversationId, (current) => {
        const messages = current.messages.filter(
          (message) =>
            message.id !== activeRequest.assistantMessageId &&
            message.id !== userMessage.id,
        );
        return {
          ...current,
          messages,
          title: messages.length ? current.title : conversation.title,
          pendingSkillId: conversation.pendingSkillId,
          updatedAt: Date.now(),
        };
      });
      setInputValue((current) =>
        current.trim() ? `${content}\n\n${current}` : content,
      );
      setCanRetry(true);
      setErrorMessage(
        result.error.message || t("ai.assistant.messages.requestFailed"),
      );
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
    inputValue,
    isGenerating,
    persistHistory,
    scheduleStreamPreview,
    updateConversation,
  ]);

  const cancelGeneration = useCallback(() => {
    if (abortActiveGeneration()) {
      setStatusMessage(t("ai.assistant.messages.responseCanceled"));
      setErrorMessage("");
      setCanRetry(false);
    }
  }, [abortActiveGeneration]);

  const copyChatText = useCallback(async (text: string) => {
    try {
      await copyTextToSystemClipboard(text);
      setStatusMessage(t("ai.common.copied"));
      setErrorMessage("");
    } catch {
      setStatusMessage("");
      setErrorMessage(t("alerts.couldNotCopyToClipboard"));
    }
    setCanRetry(false);
  }, []);

  const sendPromptToWorkbench = useCallback(
    (prompt: string) => {
      onSendPromptToWorkbench?.(prompt);
      excalidrawAPI?.toggleSidebar({
        name: DEFAULT_SIDEBAR.name,
        tab: "ai-image",
        force: true,
      });
      setStatusMessage(t("ai.assistant.messages.sentToWorkbench"));
      setErrorMessage("");
    },
    [excalidrawAPI, onSendPromptToWorkbench],
  );

  const wasGeneratingRef = useRef(false);
  useEffect(() => {
    if (wasGeneratingRef.current && !isGenerating) {
      const active = document.activeElement;
      const chat = inputRef.current?.closest(".CustomAgentChat");
      // Only take focus back from nowhere or from inside the chat panel.
      if (!active || active === document.body || chat?.contains(active)) {
        inputRef.current?.focus();
      }
    }
    wasGeneratingRef.current = isGenerating;
  }, [isGenerating]);

  const openAgentSettings = useCallback(() => {
    window.dispatchEvent(createAIOpenSettingsEvent({ tab: "agents" }));
  }, []);

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
          throw new Error(t("ai.assistant.messages.noExcalidrawElements"));
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
          message: t("ai.assistant.messages.insertedMermaid"),
          duration: 3000,
        });
      } catch (error: any) {
        excalidrawAPI.setToast({
          message:
            error?.message || t("ai.assistant.messages.insertMermaidFailed"),
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
      {!agentConfig.llmAgents.length && (
        <Callout
          tone="warning"
          live={false}
          className="CustomAgentChat__notice"
          action={
            <UiButton size="sm" onClick={openAgentSettings}>
              {t("ai.common.openSettings")}
            </UiButton>
          }
        >
          {t("ai.assistant.noticeNoAgents")}
        </Callout>
      )}

      <section className="CustomAgentChat__chat">
        <div
          ref={messagesRef}
          className="CustomAgentChat__messages"
          onScroll={onMessagesScroll}
        >
          {!activeConversation?.messages.length && (
            <div className="CustomAgentChat__empty">
              {t("ai.assistant.startConversation", {
                agent: activeAgent?.name || t("ai.assistant.fallbackAgent"),
              })}
            </div>
          )}
          {activeConversation?.messages.map((message) => (
            <ChatMessageView
              key={message.id}
              message={message}
              onCopyCode={copyChatText}
              onCopyMessage={copyChatText}
              onDeleteMessage={deleteMessage}
              onSendPromptToWorkbench={sendPromptToWorkbench}
              onInsertMermaid={insertMermaid}
              onInsertTextToCanvas={insertAssistantText}
              canInsertToCanvas={!!excalidrawAPI}
            />
          ))}
        </div>

        <div className="CustomAgentChat__composer">
          <div className="CustomAgentChat__composerToolbar">
            <Popover
              open={isAgentMenuOpen}
              onClose={closeAgentMenu}
              anchorRef={agentButtonRef}
              role="menu"
              id={agentMenuId}
              aria-label={t("ai.assistant.agent")}
              placement="top-start"
              className="CustomAgentChat__picker"
            >
              <PopoverHeading>{t("ai.assistant.agent")}</PopoverHeading>
              {agentConfig.llmAgents.map((agent) => {
                const checked = agent.id === activeConversation?.agentId;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={checked}
                    className={clsx("UiPopover__item", {
                      "is-selected": checked,
                    })}
                    title={agent.name}
                    onClick={() => switchAgent(agent.id)}
                  >
                    <span className="UiPopover__label">{agent.name}</span>
                    <span className="UiPopover__check" aria-hidden="true">
                      {checked ? uiCheckIcon : null}
                    </span>
                  </button>
                );
              })}
            </Popover>

            <Popover
              open={isSkillsPanelOpen}
              onClose={closeSkillsMenu}
              anchorRef={skillsButtonRef}
              role="menu"
              id={skillsMenuId}
              aria-label={t("ai.assistant.skills")}
              placement="top-start"
              className="CustomAgentChat__picker"
            >
              <PopoverHeading>{t("ai.assistant.skills")}</PopoverHeading>
              {agentConfig.skills.length === 0 && (
                <div className="UiPopover__empty" role="presentation">
                  {t("ai.assistant.noSkills")}
                </div>
              )}
              {agentConfig.skills.map((skill) => (
                <button
                  key={skill.id}
                  type="button"
                  role="menuitem"
                  className="UiPopover__item"
                  title={skill.name}
                  onClick={() => selectSkill(skill)}
                >
                  {skill.icon && (
                    <span className="UiPopover__lead" aria-hidden="true">
                      {skill.icon}
                    </span>
                  )}
                  <span className="UiPopover__label">{skill.name}</span>
                </button>
              ))}
            </Popover>

            <Popover
              open={isHistoryOpen}
              onClose={closeHistory}
              anchorRef={historyButtonRef}
              role="dialog"
              id={historyPanelId}
              aria-label={t("ai.assistant.recentChats")}
              placement="top-end"
              initialFocusRef={historySearchRef}
              maxHeight={360}
              className="UiPopover--panel CustomAgentChat__history"
            >
              <TextInput
                ref={historySearchRef}
                className="CustomAgentChat__historySearch"
                type="search"
                value={historySearch}
                aria-label={t("ai.assistant.searchHistory")}
                placeholder={t("ai.assistant.searchHistory")}
                onChange={(event) => setHistorySearch(event.target.value)}
              />
              <div className="UiPopover__list">
                {filteredConversations.length === 0 && (
                  <div className="UiPopover__empty">
                    {history.conversations.length === 0
                      ? t("ai.assistant.noChatsYet")
                      : t("ai.assistant.noChatsFound")}
                  </div>
                )}
                {filteredConversations.map((conversation) => {
                  const isCurrent = conversation.id === activeConversation?.id;
                  const title = getConversationTitle(conversation, t);
                  return (
                    <div key={conversation.id} className="UiPopover__row">
                      <button
                        type="button"
                        className={clsx(
                          "UiPopover__item",
                          "UiPopover__item--stacked",
                          { "is-selected": isCurrent },
                        )}
                        aria-current={isCurrent ? "true" : undefined}
                        title={title}
                        onClick={() => switchConversation(conversation.id)}
                      >
                        <span className="UiPopover__label">{title}</span>
                        <span className="UiPopover__meta">
                          {formatRelativeTime(conversation.updatedAt, t)}
                        </span>
                      </button>
                      <UiButton
                        variant="ghost"
                        size="sm"
                        iconOnly
                        icon={CloseIcon}
                        className="CustomAgentChat__conversationDelete"
                        title={t("ai.assistant.deleteChat")}
                        aria-label={t("ai.assistant.deleteChatNamed", {
                          title,
                        })}
                        onClick={() =>
                          void deleteConversation(conversation.id, title).then(
                            (deleted) => {
                              // The row (and the focused button) went away.
                              if (deleted) {
                                historySearchRef.current?.focus();
                              }
                            },
                          )
                        }
                      />
                    </div>
                  );
                })}
              </div>
            </Popover>

            <div className="CustomAgentChat__composerControls">
              <button
                ref={agentButtonRef}
                type="button"
                className="CustomAgentChat__toolbarButton CustomAgentChat__agentButton"
                disabled={!activeConversation || !agentConfig.llmAgents.length}
                aria-haspopup="menu"
                aria-expanded={isAgentMenuOpen}
                aria-controls={isAgentMenuOpen ? agentMenuId : undefined}
                aria-label={t("ai.assistant.agent")}
                onClick={() => {
                  setIsAgentMenuOpen((open) => !open);
                  setIsSkillsPanelOpen(false);
                  setIsHistoryOpen(false);
                }}
              >
                <span className="CustomAgentChat__agentLabel">
                  {t("ai.assistant.agent")}
                </span>
                <strong
                  className={
                    activeAgent
                      ? "CustomAgentChat__agentValue"
                      : "CustomAgentChat__agentValue is-missing"
                  }
                  title={activeAgent?.name || t("ai.assistant.missingAgent")}
                >
                  {activeAgent?.name || t("ai.assistant.missingAgent")}
                </strong>
                <span className="CustomAgentChat__agentChevron">
                  {chevronUpIcon}
                </span>
              </button>
              <button
                ref={skillsButtonRef}
                type="button"
                className="CustomAgentChat__toolbarButton"
                aria-haspopup="menu"
                aria-expanded={isSkillsPanelOpen}
                aria-controls={isSkillsPanelOpen ? skillsMenuId : undefined}
                onClick={() => {
                  setIsSkillsPanelOpen((open) => !open);
                  setIsAgentMenuOpen(false);
                  setIsHistoryOpen(false);
                }}
              >
                {t("ai.assistant.skills")}
              </button>
              {pendingSkill && (
                <span className="CustomAgentChat__pendingSkill">
                  {pendingSkill.icon} {pendingSkill.name}
                </span>
              )}
            </div>

            <div className="CustomAgentChat__composerActions">
              <button
                type="button"
                title={t("ai.assistant.newChat")}
                aria-label={t("ai.assistant.newChat")}
                className="CustomAgentChat__iconButton CustomAgentChat__newChatButton"
                onClick={() => createNewConversation()}
              >
                <span
                  className="CustomAgentChat__chatPlusIcon"
                  aria-hidden="true"
                >
                  {messagePlusIcon}
                </span>
              </button>
              <button
                ref={historyButtonRef}
                type="button"
                title={t("ai.assistant.recentChats")}
                aria-label={t("ai.assistant.recentChats")}
                className="CustomAgentChat__iconButton"
                aria-haspopup="dialog"
                aria-expanded={isHistoryOpen}
                aria-controls={isHistoryOpen ? historyPanelId : undefined}
                onClick={() => {
                  setIsHistoryOpen((open) => !open);
                  setIsAgentMenuOpen(false);
                  setIsSkillsPanelOpen(false);
                }}
              >
                {chevronUpIcon}
              </button>
              <button
                type="button"
                title={t("ai.assistant.clearChats")}
                aria-label={t("ai.assistant.clearChats")}
                className="CustomAgentChat__iconButton"
                onClick={clearAllConversations}
              >
                {trashIcon}
              </button>
            </div>
          </div>

          <div className="CustomAgentChat__inputRow">
            <label className="CustomAgentChat__input">
              <textarea
                ref={inputRef}
                aria-label={t("ai.assistant.message")}
                value={inputValue}
                rows={4}
                disabled={isGenerating || !agentConfig.llmAgents.length}
                placeholder={
                  pendingSkill?.initialPrompt
                    ? t("ai.assistant.skillInputPlaceholder")
                    : t("ai.assistant.inputPlaceholder")
                }
                onChange={(event) => setInputValue(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key !== "Enter" ||
                    event.nativeEvent.isComposing ||
                    event.shiftKey
                  ) {
                    return;
                  }

                  event.preventDefault();
                  sendMessage();
                }}
              />
            </label>
            {isGenerating ? (
              <UiButton
                variant="danger"
                size="sm"
                className="CustomAgentChat__sendButton"
                aria-label={t("ai.assistant.stopGenerating")}
                onClick={cancelGeneration}
              >
                {t("ai.assistant.stop")}
              </UiButton>
            ) : (
              <UiButton
                variant="primary"
                size="sm"
                className="CustomAgentChat__sendButton"
                aria-label={t("ai.assistant.sendMessage")}
                disabled={!inputValue.trim() || !agentConfig.llmAgents.length}
                onClick={() => void sendMessage()}
              >
                {t("ai.assistant.send")}
              </UiButton>
            )}
          </div>
        </div>
      </section>

      {(statusMessage || errorMessage) && (
        <Callout
          tone={errorMessage ? "danger" : "info"}
          className={
            errorMessage
              ? "CustomAgentChat__message is-error"
              : "CustomAgentChat__message"
          }
          action={
            errorMessage && canRetry && inputValue.trim() && !isGenerating ? (
              <UiButton size="sm" onClick={() => void sendMessage()}>
                {t("ai.assistant.retry")}
              </UiButton>
            ) : undefined
          }
        >
          {errorMessage || statusMessage}
        </Callout>
      )}
    </div>
  );
};

type ChatMessageViewProps = {
  message: ChatMessage;
  onCopyCode: (code: string) => void;
  onCopyMessage: (content: string) => void;
  onDeleteMessage: (messageId: string) => void;
  onSendPromptToWorkbench: (prompt: string) => void;
  onInsertMermaid: (definition: string) => void;
  onInsertTextToCanvas: (text: string) => void;
  canInsertToCanvas?: boolean;
};

export const ChatMessageView = memo(
  ({
    message,
    onCopyCode,
    onCopyMessage,
    onDeleteMessage,
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
      <div
        className={
          message.role === "user"
            ? "CustomAgentChat__chatMessageGroup is-user"
            : "CustomAgentChat__chatMessageGroup"
        }
      >
        <article
          className={
            message.role === "user"
              ? "CustomAgentChat__chatMessage is-user"
              : "CustomAgentChat__chatMessage"
          }
        >
          <div className="CustomAgentChat__messageMeta">
            <strong>
              {message.role === "user"
                ? t("ai.assistant.you")
                : t("ai.assistant.assistant")}
            </strong>
            <span>{formatTime(message.timestamp)}</span>
          </div>
          <div className="CustomAgentChat__messageContent">
            {message.content || t("ai.assistant.thinking")}
          </div>
          {message.codeBlocks?.map((block, index) => (
            <div
              className="CustomAgentChat__codeBlock"
              key={`${block.code}-${index}`}
            >
              <pre>{block.code}</pre>
              <div>
                <button type="button" onClick={() => onCopyCode(block.code)}>
                  {t("ai.assistant.copyCode")}
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
              {t("ai.assistant.sendToWorkbench")}
            </button>
          )}
          {canvasText && (
            <button
              className="CustomAgentChat__inlineAction"
              type="button"
              disabled={!canInsertToCanvas}
              title={
                canInsertToCanvas
                  ? t("ai.assistant.insertAssistantTextTitle")
                  : t("ai.assistant.canvasUnavailable")
              }
              onClick={() => onInsertTextToCanvas(canvasText)}
            >
              {t("ai.assistant.insertTextToCanvas")}
            </button>
          )}
          {mermaidDefinition && (
            <button
              className="CustomAgentChat__inlineAction"
              type="button"
              disabled={!canInsertToCanvas}
              title={
                canInsertToCanvas
                  ? t("ai.assistant.insertMermaidTitle")
                  : t("ai.assistant.canvasUnavailable")
              }
              onClick={() => onInsertMermaid(mermaidDefinition)}
            >
              {t("ai.assistant.insertMermaidToCanvas")}
            </button>
          )}
        </article>
        {message.content && (
          <div className="CustomAgentChat__messageActions">
            <button
              type="button"
              className="CustomAgentChat__messageActionButton"
              title={t("ai.assistant.deleteMessage")}
              aria-label={t("ai.assistant.deleteMessage")}
              onClick={() => onDeleteMessage(message.id)}
            >
              {trashIcon}
            </button>
            <button
              type="button"
              className="CustomAgentChat__messageActionButton CustomAgentChat__messageCopyButton"
              title={t("ai.assistant.copyMessage")}
              aria-label={t("ai.assistant.copyMessage")}
              onClick={() => onCopyMessage(message.content)}
            >
              {copyIcon}
            </button>
          </div>
        )}
      </div>
    );
  },
);

ChatMessageView.displayName = "ChatMessageView";

type AssistantT = typeof t;

const getAgentLabel = (
  config: AIAgentConfig,
  agentId: string,
  t: AssistantT,
) => {
  const agent = config.llmAgents.find((item) => item.id === agentId);

  return agent ? agent.name : t("ai.assistant.missingAgent");
};

const getConversationTitle = (
  conversation: ChatConversation,
  t: AssistantT,
) => {
  if (!conversation.messages.length && conversation.title === "New chat") {
    return t("ai.assistant.newChat");
  }

  return conversation.title;
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

const formatRelativeTime = (timestamp: number, t: AssistantT) => {
  const diff = Date.now() - timestamp;

  if (diff < 60 * 1000) {
    return t("ai.assistant.justNow");
  }

  if (diff < 60 * 60 * 1000) {
    return t("ai.assistant.minutesAgo", {
      count: Math.floor(diff / (60 * 1000)),
    });
  }

  if (diff < 24 * 60 * 60 * 1000) {
    return t("ai.assistant.hoursAgo", {
      count: Math.floor(diff / (60 * 60 * 1000)),
    });
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
    message: t("ai.assistant.messages.insertedAssistantText"),
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
