import React from "react";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { STORAGE_KEYS } from "../../app_constants";
import { saveAIAgentConfig } from "../../ai/agentConfig";
import { loadChatHistory } from "../../ai/chatHistory";
import { sendMessageToGeneralAgent } from "../../ai/customAgentAdapter";
import { AI_OPEN_SETTINGS_EVENT } from "../../ai/workflowEvents";

import {
  ChatMessageView,
  CustomAgentChat,
  formatAssistantCanvasText,
  insertAssistantTextToCanvas,
} from "./CustomAgentChat";

import type { ChatMessage } from "../../ai/types";

vi.mock("../../ai/customAgentAdapter", () => ({
  sendMessageToGeneralAgent: vi.fn(),
}));

// jsdom has no layout: give the list fixed metrics and a writable scrollTop.
const mockScrollMetrics = (
  element: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number },
) => {
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => metrics.scrollHeight,
  });
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: () => metrics.clientHeight,
  });
  Object.defineProperty(element, "scrollTop", {
    configurable: true,
    writable: true,
    value: 0,
  });
};

const typeAndSend = (text: string) => {
  fireEvent.change(screen.getByLabelText("Message"), {
    target: { value: text },
  });
  fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
};

const createAssistantMessage = (
  overrides: Partial<ChatMessage> = {},
): ChatMessage => ({
  id: "assistant-message",
  role: "assistant",
  content: "Use this prompt for the next concept.",
  agentId: "agent-1",
  timestamp: 0,
  ...overrides,
});

describe("ChatMessageView", () => {
  it("sends detected assistant prompts to the AI Workbench", () => {
    const onSendPromptToWorkbench = vi.fn();

    render(
      <ChatMessageView
        message={createAssistantMessage({
          detectedPrompt: {
            text: "A polished office whiteboard hero image",
            confidence: 0.92,
          },
        })}
        onCopyCode={vi.fn()}
        onCopyMessage={vi.fn()}
        onDeleteMessage={vi.fn()}
        onInsertMermaid={vi.fn()}
        onInsertTextToCanvas={vi.fn()}
        onSendPromptToWorkbench={onSendPromptToWorkbench}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Send to Workbench" }));

    expect(onSendPromptToWorkbench).toHaveBeenCalledTimes(1);
    expect(onSendPromptToWorkbench).toHaveBeenCalledWith(
      "A polished office whiteboard hero image",
    );
  });

  it("exposes assistant Mermaid output as a canvas insertion action", () => {
    const onInsertMermaid = vi.fn();
    const mermaidDefinition = "flowchart TD\n  A[Idea] --> B[Canvas]";

    render(
      <ChatMessageView
        message={createAssistantMessage({
          content: `Here is a diagram:\n\`\`\`mermaid\n${mermaidDefinition}\n\`\`\``,
          codeBlocks: [
            {
              language: "mermaid",
              code: mermaidDefinition,
            },
          ],
        })}
        onCopyCode={vi.fn()}
        onCopyMessage={vi.fn()}
        onDeleteMessage={vi.fn()}
        onInsertMermaid={onInsertMermaid}
        onInsertTextToCanvas={vi.fn()}
        onSendPromptToWorkbench={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Insert Mermaid to Canvas" }),
    );

    expect(onInsertMermaid).toHaveBeenCalledTimes(1);
    expect(onInsertMermaid).toHaveBeenCalledWith(mermaidDefinition);
  });

  it("copies assistant code blocks", () => {
    const onCopyCode = vi.fn();

    render(
      <ChatMessageView
        message={createAssistantMessage({
          codeBlocks: [
            {
              language: "text",
              code: "copyable prompt fragment",
            },
          ],
        })}
        onCopyCode={onCopyCode}
        onCopyMessage={vi.fn()}
        onDeleteMessage={vi.fn()}
        onInsertMermaid={vi.fn()}
        onInsertTextToCanvas={vi.fn()}
        onSendPromptToWorkbench={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy Code" }));

    expect(onCopyCode).toHaveBeenCalledTimes(1);
    expect(onCopyCode).toHaveBeenCalledWith("copyable prompt fragment");
  });

  it("copies full chat message content", () => {
    const onCopyMessage = vi.fn();

    render(
      <ChatMessageView
        message={createAssistantMessage({
          content: "Copy this full assistant response.",
        })}
        onCopyCode={vi.fn()}
        onCopyMessage={onCopyMessage}
        onDeleteMessage={vi.fn()}
        onInsertMermaid={vi.fn()}
        onInsertTextToCanvas={vi.fn()}
        onSendPromptToWorkbench={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));

    expect(onCopyMessage).toHaveBeenCalledTimes(1);
    expect(onCopyMessage).toHaveBeenCalledWith(
      "Copy this full assistant response.",
    );
  });

  it("deletes a single chat message", () => {
    const onDeleteMessage = vi.fn();

    render(
      <ChatMessageView
        message={createAssistantMessage({
          id: "message-to-delete",
          content: "Remove this from context.",
        })}
        onCopyCode={vi.fn()}
        onCopyMessage={vi.fn()}
        onDeleteMessage={onDeleteMessage}
        onInsertMermaid={vi.fn()}
        onInsertTextToCanvas={vi.fn()}
        onSendPromptToWorkbench={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete message" }));

    expect(onDeleteMessage).toHaveBeenCalledTimes(1);
    expect(onDeleteMessage).toHaveBeenCalledWith("message-to-delete");
  });

  it("exposes assistant text output as a canvas insertion action", () => {
    const onInsertTextToCanvas = vi.fn();

    render(
      <ChatMessageView
        message={createAssistantMessage({
          content: "Turn these notes into a board-ready action list.",
        })}
        onCopyCode={vi.fn()}
        onCopyMessage={vi.fn()}
        onDeleteMessage={vi.fn()}
        onInsertMermaid={vi.fn()}
        onInsertTextToCanvas={onInsertTextToCanvas}
        onSendPromptToWorkbench={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Insert text to Canvas" }),
    );

    expect(onInsertTextToCanvas).toHaveBeenCalledTimes(1);
    expect(onInsertTextToCanvas).toHaveBeenCalledWith(
      "Turn these notes into a board-ready action list.",
    );
  });

  it("formats assistant canvas text without fenced code blocks", () => {
    expect(
      formatAssistantCanvasText(
        "Use this summary on the board.\n```mermaid\nflowchart TD\nA-->B\n```",
      ),
    ).toBe("Use this summary on the board.");
    expect(formatAssistantCanvasText("```text\nonly code\n```")).toBeNull();
  });

  it("inserts formatted assistant text into the canvas", () => {
    const existingElement = {
      id: "existing",
      type: "rectangle",
      isDeleted: false,
    };
    const excalidrawAPI = {
      getAppState: () => ({
        width: 1000,
        height: 700,
        scrollX: 0,
        scrollY: 0,
        zoom: { value: 1 },
      }),
      getSceneElementsIncludingDeleted: () => [existingElement],
      updateScene: vi.fn(),
      scrollToContent: vi.fn(),
      setToast: vi.fn(),
    } as unknown as ExcalidrawImperativeAPI;

    expect(
      insertAssistantTextToCanvas(
        excalidrawAPI,
        "First board note\n```text\nskip this code\n```",
      ),
    ).toBe(true);

    expect(excalidrawAPI.updateScene).toHaveBeenCalledTimes(1);
    const update = vi.mocked(excalidrawAPI.updateScene).mock.calls[0][0];
    const insertedElement = update.elements?.[1];

    expect(update.captureUpdate).toBe(CaptureUpdateAction.IMMEDIATELY);
    expect(update.elements?.[0]).toBe(existingElement);
    expect(insertedElement).toMatchObject({
      type: "text",
      text: "First board note",
      fontSize: 20,
    });
    expect(update.appState?.selectedElementIds).toEqual({
      [insertedElement!.id]: true,
    });
    expect(excalidrawAPI.scrollToContent).toHaveBeenCalledWith(
      [insertedElement],
      { fitToContent: true },
    );
    expect(excalidrawAPI.setToast).toHaveBeenCalledWith({
      message: "Inserted assistant text.",
      duration: 3000,
    });
  });
});

describe("CustomAgentChat", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(sendMessageToGeneralAgent).mockReset();
    saveAIAgentConfig({
      textAgents: [],
      visionAgents: [],
      llmAgents: [
        {
          id: "llm-agent",
          name: "General Agent",
          type: "llm",
          provider: "openai",
          baseURL: "",
          apiKey: "",
          model: "gpt-4o-mini",
        },
      ],
      customAgents: [],
      skills: [],
      defaultTextAgentId: null,
      defaultVisionAgentId: null,
      defaultLLMAgentId: "llm-agent",
      defaultCustomAgentId: null,
      useTextAgentForVision: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads incoming Workbench prompts into the assistant composer", async () => {
    render(
      <CustomAgentChat
        excalidrawAPI={null}
        incomingPrompt={{
          id: 1,
          prompt: "Refine this office whiteboard concept",
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Message")).toHaveValue(
        "Refine this office whiteboard concept",
      );
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Prompt loaded from AI Workbench.",
    );
    expect(screen.getByLabelText("Message")).toHaveAttribute(
      "placeholder",
      "Describe what you need... (Shift+Enter for new line)",
    );
  });

  it("loads assistant skills selected from workflow commands", async () => {
    const skill = {
      id: "skill-storyboard",
      name: "Storyboard Coach",
      icon: "AI",
      description: "Storyboard planning",
      triggers: ["storyboard"],
      initialPrompt: "Turn {user_input} into a storyboard.",
    };
    const secondSkill = {
      ...skill,
      id: "skill-critic",
      name: "Prompt Critic",
      initialPrompt: "Critique {user_input}.",
    };
    saveAIAgentConfig({
      textAgents: [],
      visionAgents: [],
      llmAgents: [
        {
          id: "llm-agent",
          name: "General Agent",
          type: "llm",
          provider: "openai",
          baseURL: "",
          apiKey: "",
          model: "gpt-4o-mini",
        },
      ],
      customAgents: [],
      skills: [skill, secondSkill],
      defaultTextAgentId: null,
      defaultVisionAgentId: null,
      defaultLLMAgentId: "llm-agent",
      defaultCustomAgentId: null,
      useTextAgentForVision: false,
    });

    const { rerender } = render(
      <CustomAgentChat
        excalidrawAPI={null}
        incomingSkill={{
          id: 1,
          skill,
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Storyboard Coach selected. Type your input to start.",
      );
    });
    expect(screen.getByLabelText("Message")).toHaveAttribute(
      "placeholder",
      "Type the input for this Skill...",
    );
    expect(loadChatHistory().conversations[0]).toMatchObject({
      agentId: "llm-agent",
      pendingSkillId: "skill-storyboard",
    });

    rerender(
      <CustomAgentChat
        excalidrawAPI={null}
        incomingSkill={{
          id: 2,
          skill: secondSkill,
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Prompt Critic selected. Type your input to start.",
      );
    });
    expect(loadChatHistory().conversations[0]).toMatchObject({
      agentId: "llm-agent",
      pendingSkillId: "skill-critic",
    });
  });

  it("dismisses the agent, skills and history popups with Escape or an outside click", async () => {
    render(<CustomAgentChat excalidrawAPI={null} />);

    const agentButton = screen.getByRole("button", { name: "Agent" });
    await waitFor(() => expect(agentButton).toBeEnabled());
    fireEvent.click(agentButton);
    const agentMenu = screen.getByRole("menu", { name: "Agent" });
    expect(
      screen.getByRole("menuitemradio", { name: "General Agent" }),
    ).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(agentMenu, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(agentButton).toHaveAttribute("aria-expanded", "false");

    const skillsButton = screen.getByRole("button", { name: "Skills" });
    fireEvent.click(skillsButton);
    expect(skillsButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu", { name: "Skills" })).toHaveTextContent(
      "No Skills configured.",
    );
    fireEvent.pointerDown(screen.getByLabelText("Message"));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Recent chats" }));
    const historyPanel = screen.getByRole("dialog", { name: "Recent chats" });
    const search = screen.getByRole("searchbox", { name: "Search history" });
    expect(document.activeElement).toBe(search);
    fireEvent.keyDown(search, { key: "Escape" });
    expect(historyPanel).not.toBeInTheDocument();
  });

  it("does not persist chat history for every streamed chunk", async () => {
    vi.mocked(sendMessageToGeneralAgent).mockImplementation(
      async ({ onChunk }) => {
        onChunk?.("Hel");
        onChunk?.("lo");

        return {
          content: "Hello",
          error: null,
        };
      },
    );
    const setItemSpy = vi.spyOn(localStorage, "setItem");

    render(<CustomAgentChat excalidrawAPI={null} />);

    await waitFor(() => {
      expect(loadChatHistory().conversations).toHaveLength(1);
    });

    setItemSpy.mockClear();
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Draft a concise prompt" },
    });
    fireEvent.keyDown(screen.getByLabelText("Message"), {
      key: "Enter",
      code: "Enter",
    });

    await waitFor(() => {
      expect(screen.getByText("Hello")).toBeInTheDocument();
    });

    const chatHistoryWrites = setItemSpy.mock.calls.filter(
      ([key]) => key === STORAGE_KEYS.LOCAL_STORAGE_CUSTOM_AGENT_CHAT,
    );
    expect(chatHistoryWrites).toHaveLength(2);
    expect(loadChatHistory().conversations[0].messages.at(-1)?.content).toBe(
      "Hello",
    );
  });

  it("scrolls the message list to the latest message after sending", async () => {
    vi.mocked(sendMessageToGeneralAgent).mockResolvedValue({
      content: "Auto scrolled response",
      error: null,
    });

    const { container } = render(<CustomAgentChat excalidrawAPI={null} />);
    const list = container.querySelector<HTMLElement>(
      ".CustomAgentChat__messages",
    )!;
    mockScrollMetrics(list, { scrollHeight: 900, clientHeight: 300 });

    await waitFor(() => {
      expect(loadChatHistory().conversations).toHaveLength(1);
    });
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Keep latest visible" },
    });
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByText("Auto scrolled response")).toBeInTheDocument();
    });
    expect(list.scrollTop).toBe(900);
  });

  it("does not pull the reader down while streaming once they scrolled up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let emit: (chunk: string) => void = () => {};
    vi.mocked(sendMessageToGeneralAgent).mockImplementation(({ onChunk }) => {
      emit = (chunk) => onChunk?.(chunk);
      return new Promise(() => {});
    });

    try {
      const { container } = render(<CustomAgentChat excalidrawAPI={null} />);
      const list = container.querySelector<HTMLElement>(
        ".CustomAgentChat__messages",
      )!;
      mockScrollMetrics(list, { scrollHeight: 900, clientHeight: 300 });

      fireEvent.change(screen.getByLabelText("Message"), {
        target: { value: "Long answer please" },
      });
      fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
      await screen.findByRole("button", { name: "Stop generating" });
      expect(list.scrollTop).toBe(900);

      // The reader scrolls up to re-read something.
      list.scrollTop = 100;
      fireEvent.scroll(list);
      emit("More streamed text");
      await vi.advanceTimersByTimeAsync(150);
      await screen.findByText("More streamed text");
      expect(list.scrollTop).toBe(100);

      // Back near the bottom: following resumes.
      list.scrollTop = 580;
      fireEvent.scroll(list);
      emit(" and more");
      await vi.advanceTimersByTimeAsync(150);
      await screen.findByText("More streamed text and more");
      expect(list.scrollTop).toBe(900);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes a chat message from the next agent context", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    vi.mocked(sendMessageToGeneralAgent)
      .mockResolvedValueOnce({
        content: "Invalid context",
        error: null,
      })
      .mockResolvedValueOnce({
        content: "Next response",
        error: null,
      });

    render(<CustomAgentChat excalidrawAPI={null} />);

    await waitFor(() => {
      expect(loadChatHistory().conversations).toHaveLength(1);
    });

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "First question" },
    });
    fireEvent.keyDown(screen.getByLabelText("Message"), {
      key: "Enter",
      code: "Enter",
    });

    await waitFor(() => {
      expect(screen.getByText("Invalid context")).toBeInTheDocument();
    });

    const deleteButtons = screen.getAllByRole("button", {
      name: "Delete message",
    });
    fireEvent.click(deleteButtons[deleteButtons.length - 1]);

    await waitFor(() => {
      expect(screen.queryByText("Invalid context")).not.toBeInTheDocument();
    });
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(
      loadChatHistory().conversations[0].messages.some(
        (message) => message.content === "Invalid context",
      ),
    ).toBe(false);

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Second question" },
    });
    fireEvent.keyDown(screen.getByLabelText("Message"), {
      key: "Enter",
      code: "Enter",
    });

    await waitFor(() => {
      expect(screen.getByText("Next response")).toBeInTheDocument();
    });

    const secondRequestMessages = vi.mocked(sendMessageToGeneralAgent).mock
      .calls[1][0].messages;
    expect(
      secondRequestMessages.some(
        (message) => message.content === "Invalid context",
      ),
    ).toBe(false);
  });

  it("keeps partial assistant output when generation is canceled", async () => {
    vi.mocked(sendMessageToGeneralAgent).mockImplementation(
      ({ onChunk, signal }) => {
        onChunk?.("Partial answer");

        return new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            resolve({
              content: "",
              error: Object.assign(new Error("Request aborted"), {
                status: 499,
              }),
            });
          });
        });
      },
    );

    render(<CustomAgentChat excalidrawAPI={null} />);

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Explain this board" },
    });
    fireEvent.keyDown(screen.getByLabelText("Message"), {
      key: "Enter",
      code: "Enter",
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Stop generating" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop generating" }));

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Response canceled.",
      );
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Partial answer")).toBeInTheDocument();
    expect(loadChatHistory().conversations[0].messages.at(-1)?.content).toBe(
      "Partial answer",
    );
  });

  it("drops an empty reply bubble when canceled before any output", async () => {
    vi.mocked(sendMessageToGeneralAgent).mockImplementation(
      ({ signal }) =>
        new Promise((resolve) => {
          signal?.addEventListener("abort", () => {
            resolve({
              content: "",
              error: Object.assign(new Error("Request aborted"), {
                status: 499,
              }),
            });
          });
        }),
    );

    render(<CustomAgentChat excalidrawAPI={null} />);
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Explain this board" },
    });
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    fireEvent.click(
      await screen.findByRole("button", { name: "Stop generating" }),
    );

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Response canceled.",
      );
    });
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
    expect(
      loadChatHistory().conversations[0].messages.map((m) => m.role),
    ).toEqual(["user"]);
  });

  it("saves the streamed part of a reply when unmounted mid-stream", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const signals: AbortSignal[] = [];
    vi.mocked(sendMessageToGeneralAgent).mockImplementation(
      ({ onChunk, signal }) => {
        signals.push(signal!);
        onChunk?.("Half an ans");
        return new Promise(() => {});
      },
    );

    try {
      const { unmount } = render(<CustomAgentChat excalidrawAPI={null} />);
      fireEvent.change(screen.getByLabelText("Message"), {
        target: { value: "Explain this board" },
      });
      fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
      await screen.findByRole("button", { name: "Stop generating" });

      // Before the 100 ms preview flush: the chunk only lives in a ref.
      unmount();

      expect(signals[0]?.aborted).toBe(true);
      expect(loadChatHistory().conversations[0].messages.at(-1)?.content).toBe(
        "Half an ans",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Shift+Enter available for multiline input", async () => {
    render(<CustomAgentChat excalidrawAPI={null} />);

    await waitFor(() => {
      expect(loadChatHistory().conversations).toHaveLength(1);
    });

    const textarea = screen.getByLabelText("Message");
    fireEvent.change(textarea, {
      target: { value: "First line\nSecond line" },
    });
    fireEvent.keyDown(textarea, {
      key: "Enter",
      code: "Enter",
      shiftKey: true,
    });

    expect(sendMessageToGeneralAgent).not.toHaveBeenCalled();
  });

  it("keeps the chat history empty after clearing all conversations", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<CustomAgentChat excalidrawAPI={null} />);

    await waitFor(() => {
      expect(loadChatHistory().conversations).toHaveLength(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Clear history" }));

    await waitFor(() => {
      expect(loadChatHistory().conversations).toHaveLength(0);
    });
    expect(screen.getByRole("status")).toHaveTextContent("All chats cleared.");
  });
  it("puts the text back and offers Retry when a request fails", async () => {
    vi.mocked(sendMessageToGeneralAgent)
      .mockResolvedValueOnce({
        content: "",
        error: new Error("Upstream exploded"),
      })
      .mockResolvedValueOnce({ content: "Second try worked", error: null });

    render(<CustomAgentChat excalidrawAPI={null} />);
    await waitFor(() => {
      expect(loadChatHistory().conversations).toHaveLength(1);
    });
    typeAndSend("Summarise the board");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Upstream exploded",
    );
    expect(screen.getByLabelText("Message")).toHaveValue("Summarise the board");
    // The failed turn is not left in the history (Retry would duplicate it).
    expect(loadChatHistory().conversations[0].messages).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Second try worked");
    expect(
      loadChatHistory().conversations[0].messages.map((m) => [
        m.role,
        m.content,
      ]),
    ).toEqual([
      ["user", "Summarise the board"],
      ["assistant", "Second try worked"],
    ]);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("has a visible Send button that turns into Stop while generating", async () => {
    let finish: () => void = () => {};
    vi.mocked(sendMessageToGeneralAgent).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ content: "Done", error: null });
        }),
    );
    render(<CustomAgentChat excalidrawAPI={null} />);

    const send = await screen.findByRole("button", { name: "Send message" });
    expect(send).toHaveTextContent("Send");
    expect(send).toHaveClass("UiButton--primary");
    expect(send).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Click to send" },
    });
    expect(send).toBeEnabled();
    fireEvent.click(send);

    const stop = await screen.findByRole("button", { name: "Stop generating" });
    expect(stop).toHaveTextContent("Stop");
    expect(stop).toHaveClass("UiButton--danger");
    expect(sendMessageToGeneralAgent).toHaveBeenCalledTimes(1);

    finish();
    await screen.findByText("Done");
    expect(
      screen.getByRole("button", { name: "Send message" }),
    ).toBeInTheDocument();
  });

  it("can send again right after Stop, before the adapter settles", async () => {
    vi.mocked(sendMessageToGeneralAgent)
      // Ignores the abort signal: never settles.
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ content: "Fresh answer", error: null });

    render(<CustomAgentChat excalidrawAPI={null} />);
    typeAndSend("First");
    fireEvent.click(
      await screen.findByRole("button", { name: "Stop generating" }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Response canceled.");

    typeAndSend("Second");
    await screen.findByText("Fresh answer");
    expect(sendMessageToGeneralAgent).toHaveBeenCalledTimes(2);
  });

  it("asks before deleting a message and keeps it when declined", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    vi.mocked(sendMessageToGeneralAgent).mockResolvedValue({
      content: "Keep me",
      error: null,
    });
    render(<CustomAgentChat excalidrawAPI={null} />);
    typeAndSend("Question");
    await screen.findByText("Keep me");

    const deleteButtons = screen.getAllByRole("button", {
      name: "Delete message",
    });
    fireEvent.click(deleteButtons[deleteButtons.length - 1]);

    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(confirmSpy.mock.calls[0][0]).toMatch(/Delete this message/);
    expect(screen.getByText("Keep me")).toBeInTheDocument();
    expect(loadChatHistory().conversations[0].messages).toHaveLength(2);
  });

  it("asks before deleting a chat from the history list", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    render(<CustomAgentChat excalidrawAPI={null} />);
    await waitFor(() => {
      expect(loadChatHistory().conversations).toHaveLength(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Recent chats" }));
    const deleteChat = screen.getByRole("button", {
      name: "Delete chat New chat",
    });
    fireEvent.click(deleteChat);
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(loadChatHistory().conversations).toHaveLength(1);

    confirmSpy.mockReturnValueOnce(true);
    fireEvent.click(deleteChat);
    await waitFor(() => {
      expect(loadChatHistory().conversations).toHaveLength(0);
    });
  });

  it("links the no-agent notice to the agents tab of AI settings", async () => {
    saveAIAgentConfig({
      textAgents: [],
      visionAgents: [],
      llmAgents: [],
      customAgents: [],
      skills: [],
      defaultTextAgentId: null,
      defaultVisionAgentId: null,
      defaultLLMAgentId: null,
      defaultCustomAgentId: null,
      useTextAgentForVision: false,
    });
    const onOpen = vi.fn();
    window.addEventListener(AI_OPEN_SETTINGS_EVENT, onOpen);

    try {
      render(<CustomAgentChat excalidrawAPI={null} />);
      fireEvent.click(screen.getByRole("button", { name: "Open AI Settings" }));
      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(onOpen.mock.calls[0][0].detail).toEqual({ tab: "agents" });
    } finally {
      window.removeEventListener(AI_OPEN_SETTINGS_EVENT, onOpen);
    }
  });
});
