import { STORAGE_KEYS } from "../app_constants";

import {
  createAIAgentId,
  createCustomAgentId,
  createSkillId,
  deleteCustomAgent,
  deleteAIAgent,
  deleteSkill,
  getCustomAgentLLM,
  getDefaultCustomAgent,
  getDefaultLLMAgent,
  getDefaultTextAgent,
  getDefaultVisionAgent,
  getSkillAgent,
  loadAIAgentConfig,
  renderSkillInitialPrompt,
  saveAIAgentConfig,
  setDefaultCustomAgent,
  setDefaultAIAgent,
  upsertCustomAgent,
  upsertAIAgent,
  upsertSkill,
} from "./agentConfig";

import type { AIAgent, AIAgentConfig, AISkill, CustomAIAgent } from "./types";

const textAgent: AIAgent = {
  id: "text-1",
  name: "Test Text Agent",
  type: "text",
  provider: "openai",
  baseURL: "https://api.openai.com/v1",
  apiKey: "sk-test",
  model: "gpt-4o-mini",
};

const visionAgent: AIAgent = {
  id: "vision-1",
  name: "Test Vision Agent",
  type: "vision",
  provider: "openai",
  baseURL: "https://api.openai.com/v1",
  apiKey: "sk-test",
  model: "gpt-4o",
};

const llmAgent: AIAgent = {
  id: "llm-1",
  name: "Test LLM Agent",
  type: "llm",
  provider: "openai",
  baseURL: "https://api.openai.com/v1",
  apiKey: "sk-test",
  model: "gpt-4o-mini",
};

const customAgent: CustomAIAgent = {
  id: "custom-1",
  name: "Prompt Expert",
  description: "Optimizes prompts",
  icon: "AI",
  baseLLMAgentId: llmAgent.id,
  systemPrompt: "You are a prompt expert.",
};

const skill: AISkill = {
  id: "skill-1",
  name: "Image Prompt",
  icon: "AI",
  description: "Optimizes image prompts",
  triggers: ["optimize prompt", "image prompt"],
  agentId: customAgent.id,
  initialPrompt: "Improve this prompt: {user_input}",
};

const createConfig = (): AIAgentConfig => ({
  textAgents: [textAgent],
  visionAgents: [visionAgent],
  llmAgents: [llmAgent],
  customAgents: [customAgent],
  skills: [skill],
  defaultTextAgentId: textAgent.id,
  defaultVisionAgentId: visionAgent.id,
  defaultLLMAgentId: llmAgent.id,
  defaultCustomAgentId: customAgent.id,
  useTextAgentForVision: false,
});

describe("AI Agent Configuration", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("saves and loads agent config from localStorage", () => {
    const config = createConfig();

    saveAIAgentConfig(config);

    expect(loadAIAgentConfig()).toEqual(config);
    expect(
      JSON.parse(
        localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_AI_AGENT) || "{}",
      ).version,
    ).toBe(1);
  });

  it("creates unique agent IDs", () => {
    const id1 = createAIAgentId();
    const id2 = createAIAgentId();

    expect(id1).not.toBe(id2);
  });

  it("creates unique custom agent and skill IDs", () => {
    const customId1 = createCustomAgentId();
    const customId2 = createCustomAgentId();
    const skillId1 = createSkillId();
    const skillId2 = createSkillId();

    expect(customId1).not.toBe(customId2);
    expect(customId1).toMatch(/^custom-agent-/);
    expect(skillId1).not.toBe(skillId2);
    expect(skillId1).toMatch(/^skill-/);
  });

  it("returns default text agent", () => {
    expect(getDefaultTextAgent(createConfig())).toEqual(textAgent);
  });

  it("returns default LLM and custom agents", () => {
    expect(getDefaultLLMAgent(createConfig())).toEqual(llmAgent);
    expect(getDefaultCustomAgent(createConfig())).toEqual(customAgent);
  });

  it("uses text agent for vision when enabled", () => {
    expect(
      getDefaultVisionAgent({
        ...createConfig(),
        useTextAgentForVision: true,
      }),
    ).toEqual(textAgent);
  });

  it("upserts, defaults, and deletes agents", () => {
    const secondTextAgent: AIAgent = {
      ...textAgent,
      id: "text-2",
      name: "Second Text Agent",
      model: "claude-3-5-sonnet-20241022",
    };
    const withAgent = upsertAIAgent(createConfig(), secondTextAgent, true);

    expect(withAgent.textAgents[0]).toEqual(secondTextAgent);
    expect(withAgent.defaultTextAgentId).toBe(secondTextAgent.id);

    const withDefault = setDefaultAIAgent(withAgent, textAgent);
    expect(withDefault.defaultTextAgentId).toBe(textAgent.id);

    const withoutDefault = deleteAIAgent(withDefault, textAgent);
    expect(withoutDefault.defaultTextAgentId).toBe(secondTextAgent.id);
  });

  it("gets the LLM agent for a custom agent", () => {
    expect(getCustomAgentLLM(createConfig(), customAgent.id)).toEqual(llmAgent);
    expect(getCustomAgentLLM(createConfig(), "missing")).toBeNull();
  });

  it("gets the custom agent for a skill", () => {
    expect(getSkillAgent(createConfig(), skill.id)).toEqual(customAgent);
    expect(getSkillAgent(createConfig(), "missing")).toBeNull();
  });

  it("upserts, defaults, and deletes custom agents", () => {
    const secondCustomAgent: CustomAIAgent = {
      ...customAgent,
      id: "custom-2",
      name: "Second Custom Agent",
    };
    const withAgent = upsertCustomAgent(
      createConfig(),
      secondCustomAgent,
      true,
    );

    expect(withAgent.customAgents[0]).toEqual(secondCustomAgent);
    expect(withAgent.defaultCustomAgentId).toBe(secondCustomAgent.id);

    const withDefault = setDefaultCustomAgent(withAgent, customAgent);
    expect(withDefault.defaultCustomAgentId).toBe(customAgent.id);

    const withoutCustomAgent = deleteCustomAgent(withDefault, customAgent);
    expect(withoutCustomAgent.defaultCustomAgentId).toBe(secondCustomAgent.id);
    expect(withoutCustomAgent.skills).toEqual([]);
  });

  it("upserts and deletes skills", () => {
    const secondSkill: AISkill = {
      ...skill,
      id: "skill-2",
      name: "Second Skill",
    };
    const withSkill = upsertSkill(createConfig(), secondSkill);

    expect(withSkill.skills[0]).toEqual(secondSkill);

    const withoutSkill = deleteSkill(withSkill, secondSkill);
    expect(withoutSkill.skills.some((item) => item.id === secondSkill.id)).toBe(
      false,
    );
  });

  it("renders skill initial prompt placeholders", () => {
    expect(renderSkillInitialPrompt(skill, "a neon city")).toBe(
      "Improve this prompt: a neon city",
    );
  });
});
