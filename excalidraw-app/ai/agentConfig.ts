import { STORAGE_KEYS } from "../app_constants";

import type {
  AIAgent,
  AIAgentConfig,
  AIAgentProvider,
  AIAgentType,
  AISkill,
  CustomAIAgent,
} from "./types";

export const AI_AGENT_CONFIG_UPDATED_EVENT = "excalidraw-ai-agent-config";

export const AI_AGENT_PROVIDERS: AIAgentProvider[] = [
  "openai",
  "anthropic",
  "gemini",
  "deepseek",
  "openai-compatible",
];

export const DEFAULT_AI_AGENT_CONFIG: AIAgentConfig = {
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
};
const AI_AGENT_CONFIG_STORE_VERSION = 1;

export const createAIAgentId = (type: AIAgentType = "text") => {
  return `ai-agent-${type}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
};

export const createCustomAgentId = () => {
  return `custom-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

export const createSkillId = () => {
  return `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

export const isAIAgentProvider = (value: string): value is AIAgentProvider => {
  return AI_AGENT_PROVIDERS.includes(value as AIAgentProvider);
};

const normalizeAgent = (
  value: unknown,
  expectedType: AIAgentType,
): AIAgent | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const agent = value as Partial<AIAgent>;
  const id = typeof agent.id === "string" ? agent.id.trim() : "";
  const model = typeof agent.model === "string" ? agent.model.trim() : "";
  const provider =
    typeof agent.provider === "string" && isAIAgentProvider(agent.provider)
      ? agent.provider
      : null;

  if (!id || !model || !provider) {
    return null;
  }

  return {
    id,
    name:
      typeof agent.name === "string" && agent.name.trim()
        ? agent.name.trim()
        : model,
    type: expectedType,
    provider,
    baseURL: typeof agent.baseURL === "string" ? agent.baseURL.trim() : "",
    apiKey: typeof agent.apiKey === "string" ? agent.apiKey : "",
    model,
    systemPrompt:
      typeof agent.systemPrompt === "string" && agent.systemPrompt.trim()
        ? agent.systemPrompt.trim()
        : undefined,
  };
};

const normalizeCustomAgent = (
  value: unknown,
  llmAgents: readonly AIAgent[],
): CustomAIAgent | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const customAgent = value as Partial<CustomAIAgent>;
  const id = typeof customAgent.id === "string" ? customAgent.id.trim() : "";
  const name =
    typeof customAgent.name === "string" ? customAgent.name.trim() : "";
  const baseLLMAgentId =
    typeof customAgent.baseLLMAgentId === "string"
      ? customAgent.baseLLMAgentId.trim()
      : "";
  const systemPrompt =
    typeof customAgent.systemPrompt === "string"
      ? customAgent.systemPrompt.trim()
      : "";

  if (
    !id ||
    !name ||
    !baseLLMAgentId ||
    !systemPrompt ||
    !llmAgents.some((agent) => agent.id === baseLLMAgentId)
  ) {
    return null;
  }

  return {
    id,
    name,
    description:
      typeof customAgent.description === "string"
        ? customAgent.description.trim()
        : "",
    icon:
      typeof customAgent.icon === "string" && customAgent.icon.trim()
        ? customAgent.icon.trim()
        : "AI",
    baseLLMAgentId,
    systemPrompt,
  };
};

const normalizeSkill = (value: unknown): AISkill | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const skill = value as Partial<AISkill>;
  const id = typeof skill.id === "string" ? skill.id.trim() : "";
  const name = typeof skill.name === "string" ? skill.name.trim() : "";

  if (!id || !name) {
    return null;
  }

  const triggers = Array.isArray(skill.triggers)
    ? skill.triggers
        .map((trigger) => (typeof trigger === "string" ? trigger.trim() : ""))
        .filter(Boolean)
    : [];
  const initialPrompt =
    typeof skill.initialPrompt === "string" && skill.initialPrompt.trim()
      ? skill.initialPrompt.trim()
      : undefined;

  return {
    id,
    name,
    icon:
      typeof skill.icon === "string" && skill.icon.trim()
        ? skill.icon.trim()
        : "AI",
    description:
      typeof skill.description === "string" ? skill.description.trim() : "",
    triggers: triggers.length ? triggers : undefined,
    initialPrompt,
  };
};

const getValidDefaultAgentId = (
  agents: readonly AIAgent[],
  defaultAgentId: unknown,
) => {
  const id =
    typeof defaultAgentId === "string" && defaultAgentId.trim()
      ? defaultAgentId.trim()
      : null;

  return id && agents.some((agent) => agent.id === id)
    ? id
    : agents[0]?.id || null;
};

const getValidDefaultCustomAgentId = (
  customAgents: readonly CustomAIAgent[],
  defaultAgentId: unknown,
) => {
  const id =
    typeof defaultAgentId === "string" && defaultAgentId.trim()
      ? defaultAgentId.trim()
      : null;

  return id && customAgents.some((agent) => agent.id === id)
    ? id
    : customAgents[0]?.id || null;
};

export const normalizeAIAgentConfig = (
  config: Partial<AIAgentConfig> | null | undefined,
): AIAgentConfig => {
  const textAgents = Array.isArray(config?.textAgents)
    ? config.textAgents
        .map((agent) => normalizeAgent(agent, "text"))
        .filter((agent): agent is AIAgent => !!agent)
    : [];
  const visionAgents = Array.isArray(config?.visionAgents)
    ? config.visionAgents
        .map((agent) => normalizeAgent(agent, "vision"))
        .filter((agent): agent is AIAgent => !!agent)
    : [];
  const llmAgents = Array.isArray(config?.llmAgents)
    ? config.llmAgents
        .map((agent) => normalizeAgent(agent, "llm"))
        .filter((agent): agent is AIAgent => !!agent)
    : [];
  const customAgents = Array.isArray(config?.customAgents)
    ? config.customAgents
        .map((agent) => normalizeCustomAgent(agent, llmAgents))
        .filter((agent): agent is CustomAIAgent => !!agent)
    : [];
  const skills = Array.isArray(config?.skills)
    ? config.skills
        .map((skill) => normalizeSkill(skill))
        .filter((skill): skill is AISkill => !!skill)
    : [];

  return {
    textAgents,
    visionAgents,
    llmAgents,
    customAgents,
    skills,
    defaultTextAgentId: getValidDefaultAgentId(
      textAgents,
      config?.defaultTextAgentId,
    ),
    defaultVisionAgentId: getValidDefaultAgentId(
      visionAgents,
      config?.defaultVisionAgentId,
    ),
    defaultLLMAgentId: getValidDefaultAgentId(
      llmAgents,
      config?.defaultLLMAgentId,
    ),
    defaultCustomAgentId: getValidDefaultCustomAgentId(
      customAgents,
      config?.defaultCustomAgentId,
    ),
    useTextAgentForVision: false,
  };
};

const migrateAIAgentConfigStore = (value: unknown) => {
  if (value && typeof value === "object" && "version" in value) {
    return normalizeAIAgentConfig(value as Partial<AIAgentConfig>);
  }

  return normalizeAIAgentConfig(value as Partial<AIAgentConfig>);
};

export const loadAIAgentConfig = (): AIAgentConfig => {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_AI_AGENT);

    if (!raw) {
      return DEFAULT_AI_AGENT_CONFIG;
    }

    return migrateAIAgentConfigStore(JSON.parse(raw));
  } catch (error: any) {
    console.error(error);
    return DEFAULT_AI_AGENT_CONFIG;
  }
};

export const saveAIAgentConfig = (config: AIAgentConfig) => {
  const normalizedConfig = normalizeAIAgentConfig(config);

  localStorage.setItem(
    STORAGE_KEYS.LOCAL_STORAGE_AI_AGENT,
    JSON.stringify({
      version: AI_AGENT_CONFIG_STORE_VERSION,
      ...normalizedConfig,
    }),
  );

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(AI_AGENT_CONFIG_UPDATED_EVENT, {
        detail: normalizedConfig,
      }),
    );
  }

  return normalizedConfig;
};

export const getDefaultTextAgent = (config: AIAgentConfig): AIAgent | null => {
  return (
    config.textAgents.find((agent) => agent.id === config.defaultTextAgentId) ||
    config.textAgents[0] ||
    null
  );
};

export const getDefaultVisionAgent = (
  config: AIAgentConfig,
): AIAgent | null => {
  return (
    config.visionAgents.find(
      (agent) => agent.id === config.defaultVisionAgentId,
    ) ||
    config.visionAgents[0] ||
    null
  );
};

export const getDefaultLLMAgent = (config: AIAgentConfig): AIAgent | null => {
  return (
    config.llmAgents.find((agent) => agent.id === config.defaultLLMAgentId) ||
    config.llmAgents[0] ||
    null
  );
};

export const getDefaultCustomAgent = (
  config: AIAgentConfig,
): CustomAIAgent | null => {
  return (
    config.customAgents.find(
      (agent) => agent.id === config.defaultCustomAgentId,
    ) ||
    config.customAgents[0] ||
    null
  );
};

const getAgentConfigKey = (type: AIAgentType) => {
  return type === "text"
    ? "textAgents"
    : type === "vision"
    ? "visionAgents"
    : "llmAgents";
};

const getAgentDefaultConfigKey = (type: AIAgentType) => {
  return type === "text"
    ? "defaultTextAgentId"
    : type === "vision"
    ? "defaultVisionAgentId"
    : "defaultLLMAgentId";
};

export const upsertAIAgent = (
  config: AIAgentConfig,
  agent: AIAgent,
  setAsDefault = false,
): AIAgentConfig => {
  const key = getAgentConfigKey(agent.type);
  const defaultKey = getAgentDefaultConfigKey(agent.type);
  const agents = config[key];
  const existingIndex = agents.findIndex((item) => item.id === agent.id);
  const nextAgents =
    existingIndex === -1
      ? [agent, ...agents]
      : agents.map((item, index) => (index === existingIndex ? agent : item));

  return normalizeAIAgentConfig({
    ...config,
    [key]: nextAgents,
    [defaultKey]:
      setAsDefault || !config[defaultKey] ? agent.id : config[defaultKey],
  });
};

export const deleteAIAgent = (
  config: AIAgentConfig,
  agent: AIAgent,
): AIAgentConfig => {
  const key = getAgentConfigKey(agent.type);

  return normalizeAIAgentConfig({
    ...config,
    [key]: config[key].filter((item) => item.id !== agent.id),
  });
};

export const setDefaultAIAgent = (
  config: AIAgentConfig,
  agent: AIAgent,
): AIAgentConfig => {
  return normalizeAIAgentConfig({
    ...config,
    [getAgentDefaultConfigKey(agent.type)]: agent.id,
  });
};

export const upsertCustomAgent = (
  config: AIAgentConfig,
  agent: CustomAIAgent,
  setAsDefault = false,
): AIAgentConfig => {
  const existingIndex = config.customAgents.findIndex(
    (item) => item.id === agent.id,
  );
  const customAgents =
    existingIndex === -1
      ? [agent, ...config.customAgents]
      : config.customAgents.map((item, index) =>
          index === existingIndex ? agent : item,
        );

  return normalizeAIAgentConfig({
    ...config,
    customAgents,
    defaultCustomAgentId:
      setAsDefault || !config.defaultCustomAgentId
        ? agent.id
        : config.defaultCustomAgentId,
  });
};

export const deleteCustomAgent = (
  config: AIAgentConfig,
  agent: CustomAIAgent,
): AIAgentConfig => {
  return normalizeAIAgentConfig({
    ...config,
    customAgents: config.customAgents.filter((item) => item.id !== agent.id),
  });
};

export const setDefaultCustomAgent = (
  config: AIAgentConfig,
  agent: CustomAIAgent,
): AIAgentConfig => {
  return normalizeAIAgentConfig({
    ...config,
    defaultCustomAgentId: agent.id,
  });
};

export const upsertSkill = (
  config: AIAgentConfig,
  skill: AISkill,
): AIAgentConfig => {
  const existingIndex = config.skills.findIndex((item) => item.id === skill.id);
  const skills =
    existingIndex === -1
      ? [skill, ...config.skills]
      : config.skills.map((item, index) =>
          index === existingIndex ? skill : item,
        );

  return normalizeAIAgentConfig({
    ...config,
    skills,
  });
};

export const deleteSkill = (
  config: AIAgentConfig,
  skill: AISkill,
): AIAgentConfig => {
  return normalizeAIAgentConfig({
    ...config,
    skills: config.skills.filter((item) => item.id !== skill.id),
  });
};

export const getCustomAgentLLM = (
  config: AIAgentConfig,
  customAgentId: string,
): AIAgent | null => {
  const customAgent = config.customAgents.find(
    (agent) => agent.id === customAgentId,
  );

  if (!customAgent) {
    return null;
  }

  return (
    config.llmAgents.find((agent) => agent.id === customAgent.baseLLMAgentId) ||
    null
  );
};

export const renderSkillInitialPrompt = (skill: AISkill, userInput: string) => {
  return (skill.initialPrompt || "").replaceAll("{user_input}", userInput);
};
