import {
  createChatMessage,
  createConversation,
  generateConversationTitle,
  loadChatHistory,
  normalizeChatHistory,
  saveChatHistory,
  updateConversationTitle,
} from "./chatHistory";

import {
  H3_PROMPT_SKILL_ID,
  SEEDANCE20_PROMPT_SKILL_ID,
  SEEDANCE25_PROMPT_SKILL_ID,
} from "./skillPresets";

import type { ChatConversation, CustomAgentChatHistory } from "./types";

describe("chatHistory", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("creates conversations and messages", () => {
    const conversation = createConversation("agent-1");
    const message = createChatMessage(
      "assistant",
      "```\nA cat, realistic photo, soft lighting, 4k quality\n```",
      "agent-1",
    );

    expect(conversation.id).toMatch(/^conv-/);
    expect(conversation.mode).toBe("agent");
    expect(message.id).toMatch(/^msg-/);
    expect(message.codeBlocks).toHaveLength(1);
    expect(message.detectedPrompt?.text).toContain("realistic photo");
  });

  it("saves and loads normalized chat history", () => {
    const conversation = createConversation("agent-1");
    const history: CustomAgentChatHistory = {
      conversations: [conversation],
      activeConversationId: conversation.id,
    };

    saveChatHistory(history);

    expect(loadChatHistory()).toEqual(history);
  });

  it.each([
    H3_PROMPT_SKILL_ID,
    SEEDANCE20_PROMPT_SKILL_ID,
    SEEDANCE25_PROMPT_SKILL_ID,
  ])("restores %s and drops unsupported persisted IDs", (skillId) => {
    const conversation = {
      ...createConversation("agent-1"),
      activeSkillId: skillId,
    };
    saveChatHistory({
      conversations: [conversation],
      activeConversationId: conversation.id,
    });
    expect(loadChatHistory().conversations[0].activeSkillId).toBe(skillId);
    expect(
      normalizeChatHistory({
        conversations: [{ ...conversation, activeSkillId: "untrusted" }],
      }).conversations[0].activeSkillId,
    ).toBeUndefined();
  });

  it("generates and updates conversation title", () => {
    const conversation: ChatConversation = {
      ...createConversation("agent-1"),
      messages: [
        createChatMessage(
          "user",
          "Please optimize this orange cat prompt for an image model",
          "agent-1",
        ),
      ],
    };

    expect(generateConversationTitle("short title")).toBe("short title");
    expect(updateConversationTitle(conversation).title).toBe(
      "Please optimize...",
    );
  });

  it("normalizes invalid conversations", () => {
    const history = normalizeChatHistory({
      conversations: [{ id: "conv-1", agentId: "agent-1" } as any],
      activeConversationId: "missing",
    });

    expect(history.conversations).toHaveLength(1);
    expect(history.activeConversationId).toBe("conv-1");
  });

  it("keeps empty assistant messages while dropping empty user messages", () => {
    const history = normalizeChatHistory({
      conversations: [
        {
          ...createConversation("agent-1"),
          messages: [
            createChatMessage("assistant", "", "agent-1"),
            createChatMessage("user", "", "agent-1"),
          ],
        },
      ],
    });

    expect(history.conversations[0].messages).toHaveLength(1);
    expect(history.conversations[0].messages[0].role).toBe("assistant");
  });
});
