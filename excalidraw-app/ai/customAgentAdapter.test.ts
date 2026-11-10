import { vi } from "vitest";

import {
  DEFAULT_AI_AGENT_CONFIG,
  loadAIAgentConfig,
  saveAIAgentConfig,
} from "./agentConfig";
import { sendMessageToGeneralAgent } from "./customAgentAdapter";
import {
  getSkillSystemPrompt,
  H3_PROMPT_SKILL_ID,
  SEEDANCE20_PROMPT_SKILL_ID,
  SEEDANCE25_PROMPT_SKILL_ID,
} from "./skillPresets";
import { submitTextAgent } from "./textAgentAdapter";

vi.mock("./textAgentAdapter", () => ({ submitTextAgent: vi.fn() }));

it.each([
  H3_PROMPT_SKILL_ID,
  SEEDANCE20_PROMPT_SKILL_ID,
  SEEDANCE25_PROMPT_SKILL_ID,
])(
  "uses %s without changing the user's model or saved role",
  async (skillId) => {
    localStorage.clear();
    const agent = {
      id: "llm",
      name: "LLM",
      type: "llm" as const,
      provider: "openai-compatible" as const,
      baseURL: "https://relay.example/v1",
      apiKey: "local-key",
      model: "writer",
      systemPrompt: "My saved role",
    };
    saveAIAgentConfig({ ...DEFAULT_AI_AGENT_CONFIG, llmAgents: [agent] });
    vi.mocked(submitTextAgent).mockResolvedValue({
      generatedResponse: "<Picture 1>",
      error: null,
    });
    await expect(
      sendMessageToGeneralAgent({
        agentId: "llm",
        messages: [],
        activeSkillId: skillId,
      }),
    ).resolves.toEqual({ content: "<Picture 1>", error: null });
    expect(submitTextAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agent,
        systemPrompt: getSkillSystemPrompt(skillId),
      }),
    );
    expect(loadAIAgentConfig().llmAgents[0]).toEqual(agent);
    await sendMessageToGeneralAgent({ agentId: "llm", messages: [] });
    expect(submitTextAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ systemPrompt: undefined }),
    );
  },
);
