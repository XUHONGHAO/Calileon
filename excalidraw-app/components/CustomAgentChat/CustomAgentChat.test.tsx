import React from "react";
import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { STORAGE_KEYS } from "../../app_constants";
import { saveAIAgentConfig } from "../../ai/agentConfig";
import { loadChatHistory } from "../../ai/chatHistory";
import { sendMessageToCustomAgent } from "../../ai/customAgentAdapter";

import {
  ChatMessageView,
  CustomAgentChat,
  formatAssistantCanvasText,
  insertAssistantTextToCanvas,
} from "./CustomAgentChat";

import type { ChatMessage } from "../../ai/types";

vi.mock("../../ai/customAgentAdapter", () => ({
  sendMessageToCustomAgent: vi.fn(),
}));

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
        onInsertMermaid={vi.fn()}
        onInsertTextToCanvas={vi.fn()}
        onSendPromptToWorkbench={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy Code" }));

    expect(onCopyCode).toHaveBeenCalledTimes(1);
    expect(onCopyCode).toHaveBeenCalledWith("copyable prompt fragment");
  });

  it("exposes assistant text output as a canvas insertion action", () => {
    const onInsertTextToCanvas = vi.fn();

    render(
      <ChatMessageView
        message={createAssistantMessage({
          content: "Turn these notes into a board-ready action list.",
        })}
        onCopyCode={vi.fn()}
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
    vi.mocked(sendMessageToCustomAgent).mockReset();
    saveAIAgentConfig({
      textAgents: [],
      visionAgents: [],
      llmAgents: [
        {
          id: "llm-agent",
          name: "LLM Agent",
          type: "llm",
          provider: "openai",
          baseURL: "",
          apiKey: "",
          model: "gpt-4o-mini",
        },
      ],
      customAgents: [
        {
          id: "custom-agent",
          name: "Prompt Coach",
          description: "",
          icon: "AI",
          baseLLMAgentId: "llm-agent",
          systemPrompt: "Help refine creative prompts.",
        },
      ],
      skills: [],
      defaultTextAgentId: null,
      defaultVisionAgentId: null,
      defaultLLMAgentId: "llm-agent",
      defaultCustomAgentId: "custom-agent",
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
  });

  it("loads assistant skills selected from workflow commands", async () => {
    const skill = {
      id: "skill-storyboard",
      name: "Storyboard Coach",
      icon: "AI",
      description: "Storyboard planning",
      triggers: ["storyboard"],
      agentId: "custom-agent",
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
          name: "LLM Agent",
          type: "llm",
          provider: "openai",
          baseURL: "",
          apiKey: "",
          model: "gpt-4o-mini",
        },
      ],
      customAgents: [
        {
          id: "custom-agent",
          name: "Prompt Coach",
          description: "",
          icon: "AI",
          baseLLMAgentId: "llm-agent",
          systemPrompt: "Help refine creative prompts.",
        },
      ],
      skills: [skill, secondSkill],
      defaultTextAgentId: null,
      defaultVisionAgentId: null,
      defaultLLMAgentId: "llm-agent",
      defaultCustomAgentId: "custom-agent",
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
  });

  it("does not persist chat history for every streamed chunk", async () => {
    vi.mocked(sendMessageToCustomAgent).mockImplementation(
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
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

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

  it("keeps partial assistant output when generation is canceled", async () => {
    vi.mocked(sendMessageToCustomAgent).mockImplementation(
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
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Cancel" }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

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

  it("keeps the chat history empty after clearing all conversations", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<CustomAgentChat excalidrawAPI={null} />);

    await waitFor(() => {
      expect(loadChatHistory().conversations).toHaveLength(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Clear chats" }));

    await waitFor(() => {
      expect(loadChatHistory().conversations).toHaveLength(0);
    });
    expect(screen.getByRole("status")).toHaveTextContent("All chats cleared.");
  });
});
