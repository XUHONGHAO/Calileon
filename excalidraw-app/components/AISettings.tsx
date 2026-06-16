import { useCallback, useMemo, useRef, useState } from "react";
import { Button } from "@excalidraw/excalidraw/components/Button";

import {
  createAIAgentId,
  createCustomAgentId,
  createSkillId,
  deleteAIAgent,
  deleteCustomAgent,
  deleteSkill,
  loadAIAgentConfig,
  saveAIAgentConfig,
  setDefaultAIAgent,
  setDefaultCustomAgent,
  upsertAIAgent,
  upsertCustomAgent,
  upsertSkill,
} from "../ai/agentConfig";
import {
  AI_AGENT_PROVIDER_PRESETS,
  getAIAgentProviderPreset,
} from "../ai/agentProviderPresets";
import {
  AI_MODEL_MEDIA_TYPES,
  createAIModelConfigId,
  DEFAULT_AI_MODEL_PROVIDER_PRESETS,
  DEFAULT_AI_IMAGE_REQUEST_TIMEOUT_SECONDS,
  getDefaultCapabilitiesForMediaType,
  loadAIImageConfig,
  MODEL_CAPABILITY_OPTIONS,
  normalizeAIImageEndpoints,
  normalizeAIImageFieldMapping,
  parseModelIdListInput,
  saveAIImageConfig,
} from "../ai/config";
import {
  cloneAIImageEndpoints,
  cloneAIImageFieldMapping,
  ENDPOINT_PRESETS,
  getPresetById,
  getPresetIdForConfig,
  OPENAI_STANDARD_ENDPOINTS,
} from "../ai/endpointPresets";
import {
  AI_IMAGE_NATIVE_MODEL_OPTIONS,
  DEFAULT_AI_IMAGE_NATIVE_MODEL,
} from "../ai/imageDimensions";
import {
  BUILT_IN_TEMPLATES,
  deleteCustomPromptTemplate,
  loadCustomPromptTemplates,
  parsePromptTemplateImport,
  saveCustomPromptTemplates,
  serializePromptTemplates,
  upsertCustomPromptTemplate,
} from "../ai/promptTemplates";

import "./AISettings.scss";

import type { AIModelProviderPreset } from "../ai/config";
import type {
  AIAgent,
  AIAgentConfig,
  AIAgentProvider,
  AIAgentType,
  AISkill,
  CustomAIAgent,
} from "../ai/types";
import type {
  AIImageEndpointConfig,
  AIImageEndpoints,
  AIImageFieldMapping,
  AIImageModel,
  AIImageModelCapability,
  AIImageNativeModel,
  AIImageProviderConfig,
  AIModelMediaType,
  PromptTemplate,
  PromptTemplateCategory,
  PromptTemplateLanguage,
  AIImageGenerationMode,
} from "../ai/types";
import type { EndpointPresetId } from "../ai/endpointPresets";

const MEDIA_TYPE_LABELS: Record<AIModelMediaType, string> = {
  image: "Image",
  video: "Video",
  audio: "Audio",
};

const ENDPOINT_FORM_FIELDS: Array<{
  key: keyof AIImageEndpoints;
  label: string;
  placeholder: string;
}> = [
  {
    key: "textToImage",
    label: "Text-to-image",
    placeholder: "/images/generations",
  },
  {
    key: "imageToImage",
    label: "Image-to-image",
    placeholder: "/images/edits",
  },
  {
    key: "inpaint",
    label: "Inpaint",
    placeholder: "/images/edits",
  },
];

const FIELD_MAPPING_FORM_FIELDS: Array<{
  key: keyof AIImageFieldMapping;
  label: string;
  placeholder: string;
}> = [
  { key: "prompt", label: "Prompt field", placeholder: "prompt" },
  {
    key: "negativePrompt",
    label: "Negative prompt field",
    placeholder: "negative_prompt",
  },
  { key: "model", label: "Model field", placeholder: "model" },
  { key: "image", label: "Image field", placeholder: "image" },
  { key: "mask", label: "Mask field", placeholder: "mask" },
  { key: "size", label: "Size field", placeholder: "size" },
  { key: "n", label: "Count field", placeholder: "n" },
];

type EditorState =
  | { mode: "list" }
  | { mode: "create"; draft: AIModelDraft }
  | { mode: "edit"; draft: AIModelDraft; indexes: number[] };

type AIModelDraft = Omit<AIImageModel, "requestTimeoutSeconds"> & {
  requestTimeoutSeconds: string;
  endpointPresetId: EndpointPresetId;
};

type AIModelGroup = {
  key: string;
  model: AIImageModel;
  models: AIImageModel[];
  indexes: number[];
};

type AISettingsTab = "models" | "agents" | "templates";
type AgentSettingsSubTab = "base" | "custom" | "skills";

type AgentEditorState =
  | { mode: "list" }
  | { mode: "create"; draft: AIAgent }
  | { mode: "edit"; draft: AIAgent };

type CustomAgentEditorState =
  | { mode: "list" }
  | { mode: "create"; draft: CustomAIAgent }
  | { mode: "edit"; draft: CustomAIAgent };

type SkillDraft = Omit<AISkill, "triggers"> & {
  triggers: string;
};

type SkillEditorState =
  | { mode: "list" }
  | { mode: "create"; draft: SkillDraft }
  | { mode: "edit"; draft: SkillDraft };

type TemplateEditorState =
  | { mode: "list" }
  | { mode: "create"; draft: PromptTemplateDraft }
  | { mode: "edit"; draft: PromptTemplateDraft; templateId: string };

type PromptTemplateDraft = {
  label: string;
  template: string;
  modes: AIImageGenerationMode[];
  category: PromptTemplateCategory;
  language: PromptTemplateLanguage;
};

const TEMPLATE_MODE_OPTIONS: Array<{
  value: AIImageGenerationMode;
  label: string;
}> = [
  { value: "text-to-image", label: "Text-to-image" },
  { value: "image-to-image", label: "Image-to-image" },
  { value: "inpaint", label: "Inpaint" },
];

const TEMPLATE_CATEGORY_OPTIONS: Array<{
  value: PromptTemplateCategory;
  label: string;
}> = [
  { value: "composition", label: "Composition" },
  { value: "style", label: "Style" },
  { value: "editing", label: "Editing" },
  { value: "custom", label: "Custom" },
];

const TEMPLATE_LANGUAGE_OPTIONS: Array<{
  value: PromptTemplateLanguage;
  label: string;
}> = [
  { value: "en", label: "English" },
  { value: "zh", label: "中文" },
  { value: "multi", label: "Multilingual" },
];

const AGENT_PROVIDER_OPTIONS: Array<{
  value: AIAgentProvider;
  label: string;
}> = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic (Claude)" },
  { value: "gemini", label: "Gemini (Google)" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "openai-compatible", label: "OpenAI-Compatible" },
];

const AGENT_TYPE_LABELS: Record<AIAgentType, string> = {
  text: "Text",
  vision: "Vision",
  llm: "LLM",
};

const AGENT_RECOMMENDATIONS: Record<AIAgentType, string[]> = {
  text: [
    "GPT-4o-mini for cost-effective Mermaid generation.",
    "Claude 3.5 Sonnet for strong code-oriented diagrams.",
    "Gemini 1.5 Flash for fast text generation.",
  ],
  vision: [
    "GPT-4o for strong wireframe understanding.",
    "Claude 3.5 Sonnet for vision plus code generation.",
    "Gemini 1.5 Pro for multimodal prompts.",
  ],
  llm: [
    "GPT-4o-mini for general assistant tasks.",
    "Claude 3.5 Sonnet for deeper writing and reasoning.",
    "OpenAI-Compatible for proxy APIs and custom model names.",
  ],
};

const ICON_OPTIONS = ["AI", "🎨", "💡", "🎬", "🌈", "🧠", "✍️", "⚙️"];

const createAgentDraft = (type: AIAgentType): AIAgent => ({
  id: createAIAgentId(type),
  name: "",
  type,
  provider: "openai-compatible",
  baseURL: "",
  apiKey: "",
  model: "",
  systemPrompt: "",
});

const createAgentDraftFromProviderPreset = (
  provider: AIAgentProvider,
  type: AIAgentType,
  currentDraft?: AIAgent,
): AIAgent => {
  const preset = getAIAgentProviderPreset(provider);
  const recommendedModel =
    type === "vision"
      ? preset?.recommendedVisionModel || ""
      : preset?.recommendedTextModel || "";
  const presetSystemPrompt =
    type === "llm" ? "" : preset?.defaultSystemPrompts[type] || "";

  return {
    ...(currentDraft || createAgentDraft(type)),
    provider,
    baseURL: preset?.baseURL || "",
    model: recommendedModel || "",
    name:
      provider === "openai-compatible"
        ? currentDraft?.name || ""
        : `${recommendedModel || preset?.name || "Agent"} (${preset?.name})`,
    systemPrompt: currentDraft?.systemPrompt || presetSystemPrompt,
  };
};

const normalizeAgentDraftForSave = (draft: AIAgent): AIAgent => ({
  ...draft,
  name: draft.name.trim() || draft.model.trim(),
  baseURL: draft.baseURL.trim(),
  model: draft.model.trim(),
  systemPrompt: draft.systemPrompt?.trim() || undefined,
});

const createCustomAgentDraft = (config: AIAgentConfig): CustomAIAgent => ({
  id: createCustomAgentId(),
  name: "",
  description: "",
  icon: "AI",
  baseLLMAgentId: config.defaultLLMAgentId || config.llmAgents[0]?.id || "",
  systemPrompt: "",
});

const normalizeCustomAgentDraftForSave = (
  draft: CustomAIAgent,
): CustomAIAgent => ({
  ...draft,
  name: draft.name.trim(),
  description: draft.description.trim(),
  icon: draft.icon.trim() || "AI",
  baseLLMAgentId: draft.baseLLMAgentId.trim(),
  systemPrompt: draft.systemPrompt.trim(),
});

const createSkillDraft = (config: AIAgentConfig): SkillDraft => ({
  id: createSkillId(),
  name: "",
  icon: "AI",
  description: "",
  triggers: "",
  agentId: config.defaultCustomAgentId || config.customAgents[0]?.id || "",
  initialPrompt: "",
});

const createSkillDraftFromSkill = (skill: AISkill): SkillDraft => ({
  ...skill,
  triggers: skill.triggers?.join(", ") || "",
  initialPrompt: skill.initialPrompt || "",
});

const normalizeSkillDraftForSave = (draft: SkillDraft): AISkill => {
  const triggers = draft.triggers
    .split(",")
    .map((trigger) => trigger.trim())
    .filter(Boolean);

  return {
    id: draft.id,
    name: draft.name.trim(),
    icon: draft.icon.trim() || "AI",
    description: draft.description.trim(),
    triggers: triggers.length ? triggers : undefined,
    agentId: draft.agentId.trim(),
    initialPrompt: draft.initialPrompt?.trim() || undefined,
  };
};

const createPromptTemplateDraft = (): PromptTemplateDraft => ({
  label: "",
  template: "",
  modes: ["text-to-image", "image-to-image"],
  category: "custom",
  language: "multi",
});

const createPromptTemplateDraftFromTemplate = (
  template: PromptTemplate,
): PromptTemplateDraft => ({
  label: template.label,
  template: template.template,
  modes: template.modes,
  category: template.category || "custom",
  language: template.language || "multi",
});

const createModelDraft = (mediaType: AIModelMediaType): AIModelDraft => ({
  id: createAIModelConfigId(),
  siteName: "",
  baseURL: "",
  apiKey: "",
  model: "",
  label: "",
  mediaType,
  nativeModel:
    mediaType === "image" ? DEFAULT_AI_IMAGE_NATIVE_MODEL : undefined,
  capabilities: getDefaultCapabilitiesForMediaType(mediaType),
  endpoints: cloneAIImageEndpoints(OPENAI_STANDARD_ENDPOINTS),
  endpointPresetId: "openai-standard",
  requestTimeoutSeconds: String(DEFAULT_AI_IMAGE_REQUEST_TIMEOUT_SECONDS),
});

const createModelDraftFromProviderPreset = (
  preset: AIModelProviderPreset,
  currentDraft?: AIModelDraft,
): AIModelDraft => ({
  ...(currentDraft || createModelDraft(preset.mediaType)),
  siteName: preset.siteName,
  baseURL: preset.baseURL,
  model: preset.model,
  label: preset.label,
  mediaType: preset.mediaType,
  nativeModel:
    preset.mediaType === "image"
      ? preset.nativeModel || DEFAULT_AI_IMAGE_NATIVE_MODEL
      : undefined,
  capabilities: [...preset.capabilities],
  endpoints: cloneAIImageEndpoints(preset.endpoints),
  fieldMapping: cloneAIImageFieldMapping(preset.fieldMapping),
  endpointPresetId: preset.endpointPresetId,
});

const createModelDraftFromSavedModels = (
  models: AIImageModel[],
): AIModelDraft => {
  const model = models[0];
  const endpoints = normalizeAIImageEndpoints(model.endpoints);
  const fieldMapping = normalizeAIImageFieldMapping(model.fieldMapping);

  return {
    ...model,
    model: models.map((savedModel) => savedModel.model).join("\n"),
    label: models.map((savedModel) => savedModel.model).join("\n"),
    endpoints,
    fieldMapping,
    endpointPresetId: getPresetIdForConfig(endpoints, fieldMapping),
    requestTimeoutSeconds: String(
      model.requestTimeoutSeconds || DEFAULT_AI_IMAGE_REQUEST_TIMEOUT_SECONDS,
    ),
  };
};

const getModelProviderGroupKey = (model: AIImageModel) => {
  return JSON.stringify({
    siteName: model.siteName,
    baseURL: model.baseURL,
    apiKey: model.apiKey,
    mediaType: model.mediaType,
    nativeModel: model.nativeModel,
    capabilities: model.capabilities,
    endpoints: model.endpoints,
    fieldMapping: model.fieldMapping,
    requestTimeoutSeconds: model.requestTimeoutSeconds,
  });
};

const groupModelsByProvider = (
  models: AIImageModel[],
  mediaType: AIModelMediaType,
): AIModelGroup[] => {
  const groups = new Map<string, AIModelGroup>();

  models.forEach((model, index) => {
    if (model.mediaType !== mediaType) {
      return;
    }

    const key = getModelProviderGroupKey(model);
    const group = groups.get(key);

    if (group) {
      group.models.push(model);
      group.indexes.push(index);
    } else {
      groups.set(key, {
        key,
        model,
        models: [model],
        indexes: [index],
      });
    }
  });

  return Array.from(groups.values());
};

const normalizeRequestTimeoutSeconds = (value: string | number) => {
  const numericValue = typeof value === "number" ? value : Number(value.trim());

  return Number.isFinite(numericValue) && numericValue > 0
    ? Math.round(numericValue)
    : DEFAULT_AI_IMAGE_REQUEST_TIMEOUT_SECONDS;
};

const getSavedModels = (
  draft: AIModelDraft,
  existingModels: AIImageModel[] = [],
): AIImageModel[] => {
  const {
    endpointPresetId: _endpointPresetId,
    requestTimeoutSeconds,
    endpoints: draftEndpoints,
    fieldMapping: draftFieldMapping,
    ...modelDraft
  } = draft;
  const modelNames = parseModelIdListInput(draft.model);
  const fieldMapping = normalizeAIImageFieldMapping(draftFieldMapping);

  return modelNames.map((modelName, index): AIImageModel => {
    const existingModel = existingModels.find(
      (model) => model.model === modelName,
    );
    const savedModel: AIImageModel = {
      ...modelDraft,
      id:
        existingModel?.id ||
        (index === 0 && modelDraft.id) ||
        createAIModelConfigId(),
      siteName: modelDraft.siteName.trim(),
      baseURL: modelDraft.baseURL.trim(),
      apiKey: modelDraft.apiKey,
      model: modelName,
      label: modelName,
      nativeModel:
        modelDraft.mediaType === "image"
          ? modelDraft.nativeModel || DEFAULT_AI_IMAGE_NATIVE_MODEL
          : undefined,
      capabilities: modelDraft.capabilities.length
        ? modelDraft.capabilities
        : getDefaultCapabilitiesForMediaType(modelDraft.mediaType),
      endpoints: normalizeAIImageEndpoints(draftEndpoints),
      requestTimeoutSeconds: normalizeRequestTimeoutSeconds(
        requestTimeoutSeconds,
      ),
    };

    if (fieldMapping) {
      savedModel.fieldMapping = fieldMapping;
    }

    return savedModel;
  });
};

export const AISettings = ({
  initialTab = "models",
}: {
  initialTab?: AISettingsTab;
}) => {
  const [config, setConfig] =
    useState<AIImageProviderConfig>(loadAIImageConfig);
  const [agentConfig, setAgentConfig] =
    useState<AIAgentConfig>(loadAIAgentConfig);
  const [activeSettingsTab, setActiveSettingsTab] =
    useState<AISettingsTab>(initialTab);
  const [activeAgentSubTab, setActiveAgentSubTab] =
    useState<AgentSettingsSubTab>("base");
  const [activeMediaType, setActiveMediaType] =
    useState<AIModelMediaType>("image");
  const [editorState, setEditorState] = useState<EditorState>({
    mode: "list",
  });
  const [templateEditorState, setTemplateEditorState] =
    useState<TemplateEditorState>({ mode: "list" });
  const [agentEditorState, setAgentEditorState] = useState<AgentEditorState>({
    mode: "list",
  });
  const [customAgentEditorState, setCustomAgentEditorState] =
    useState<CustomAgentEditorState>({
      mode: "list",
    });
  const [skillEditorState, setSkillEditorState] = useState<SkillEditorState>({
    mode: "list",
  });
  const [customTemplates, setCustomTemplates] = useState<PromptTemplate[]>(
    loadCustomPromptTemplates,
  );
  const [setAsDefault, setSetAsDefault] = useState(false);
  const [setAgentAsDefault, setSetAgentAsDefault] = useState(false);
  const [setCustomAgentAsDefault, setSetCustomAgentAsDefault] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const templateImportInputRef = useRef<HTMLInputElement | null>(null);

  const visibleModelGroups = useMemo(
    () => groupModelsByProvider(config.models, activeMediaType),
    [activeMediaType, config.models],
  );
  const allTemplates = useMemo(
    () => [...BUILT_IN_TEMPLATES, ...customTemplates],
    [customTemplates],
  );

  const persistConfig = useCallback(
    (nextConfig: AIImageProviderConfig, message: string) => {
      try {
        const savedConfig = saveAIImageConfig(nextConfig);
        setConfig(savedConfig);
        setStatusMessage(message);
        setErrorMessage("");
        return savedConfig;
      } catch (error: any) {
        setErrorMessage(error.message || "Could not save AI settings.");
        setStatusMessage("");
        return null;
      }
    },
    [],
  );

  const persistAgentConfig = useCallback(
    (nextConfig: AIAgentConfig, message: string) => {
      try {
        const savedConfig = saveAIAgentConfig(nextConfig);
        setAgentConfig(savedConfig);
        setStatusMessage(message);
        setErrorMessage("");
        return savedConfig;
      } catch (error: any) {
        setErrorMessage(error.message || "Could not save AI agent settings.");
        setStatusMessage("");
        return null;
      }
    },
    [],
  );

  const openCreateModel = useCallback(() => {
    setEditorState({
      mode: "create",
      draft: createModelDraft(activeMediaType),
    });
    setSetAsDefault(!config.defaultModel);
    setStatusMessage("");
    setErrorMessage("");
  }, [activeMediaType, config.defaultModel]);

  const openEditModelGroup = useCallback(
    (group: AIModelGroup) => {
      if (!group.models.length) {
        return;
      }

      setEditorState({
        mode: "edit",
        draft: createModelDraftFromSavedModels(group.models),
        indexes: group.indexes,
      });
      setSetAsDefault(
        group.models.some((model) => config.defaultModel === model.id),
      );
      setStatusMessage("");
      setErrorMessage("");
    },
    [config.defaultModel],
  );

  const closeEditor = useCallback(() => {
    setEditorState({ mode: "list" });
    setErrorMessage("");
  }, []);

  const updateDraft = useCallback((patch: Partial<AIModelDraft>) => {
    setEditorState((current) => {
      if (current.mode === "list") {
        return current;
      }

      const nextMediaType = patch.mediaType || current.draft.mediaType;
      const shouldResetCapabilities =
        !!patch.mediaType && patch.mediaType !== current.draft.mediaType;
      const nativeModel =
        nextMediaType === "image"
          ? patch.nativeModel ||
            current.draft.nativeModel ||
            DEFAULT_AI_IMAGE_NATIVE_MODEL
          : undefined;

      return {
        ...current,
        draft: {
          ...current.draft,
          ...patch,
          mediaType: nextMediaType,
          nativeModel,
          capabilities: shouldResetCapabilities
            ? getDefaultCapabilitiesForMediaType(nextMediaType)
            : patch.capabilities || current.draft.capabilities,
        },
      };
    });
    setStatusMessage("");
    setErrorMessage("");
  }, []);

  const applyProviderPreset = useCallback((preset: AIModelProviderPreset) => {
    setEditorState((current) => {
      if (current.mode === "list") {
        return current;
      }

      return {
        ...current,
        draft: createModelDraftFromProviderPreset(preset, current.draft),
      };
    });
    setActiveMediaType(preset.mediaType);
    setStatusMessage(`${preset.name} defaults applied. Add your API key.`);
    setErrorMessage("");
  }, []);

  const toggleCapability = useCallback(
    (
      model: Pick<AIImageModel, "capabilities">,
      capability: AIImageModelCapability,
    ): AIImageModelCapability[] => {
      if (model.capabilities.includes(capability)) {
        return model.capabilities.filter((item) => item !== capability);
      }

      return [...model.capabilities, capability];
    },
    [],
  );

  const removeModelGroup = useCallback(
    (indexes: number[]) => {
      const removedIndexSet = new Set(indexes);
      const removedModels = config.models.filter((_, modelIndex) =>
        removedIndexSet.has(modelIndex),
      );
      const models = config.models.filter(
        (_, modelIndex) => !removedIndexSet.has(modelIndex),
      );
      const defaultModel = removedModels.some(
        (model) => model.id === config.defaultModel,
      )
        ? models[0]?.id || ""
        : config.defaultModel;
      const savedConfig = persistConfig(
        {
          ...config,
          defaultModel,
          models,
        },
        "Models removed.",
      );

      if (savedConfig) {
        setActiveMediaType(removedModels[0]?.mediaType || activeMediaType);
        setEditorState({ mode: "list" });
      }
    },
    [activeMediaType, config, persistConfig],
  );

  const makeDefaultModelGroup = useCallback(
    (group: AIModelGroup) => {
      const defaultModel = group.models[0];

      if (!defaultModel) {
        return;
      }

      persistConfig(
        {
          ...config,
          defaultModel: defaultModel.id,
        },
        `${defaultModel.siteName} is now the default model.`,
      );
    },
    [config, persistConfig],
  );

  const submitDraft = useCallback(() => {
    if (editorState.mode === "list") {
      return;
    }

    const existingModels =
      editorState.mode === "edit"
        ? config.models.filter((_, index) =>
            editorState.indexes.includes(index),
          )
        : [];
    const savedModels = getSavedModels(editorState.draft, existingModels);
    const draft = savedModels[0];

    if (!editorState.draft.siteName.trim()) {
      setErrorMessage("Site name is required.");
      setStatusMessage("");
      return;
    }

    if (!editorState.draft.baseURL.trim()) {
      setErrorMessage("Base URL is required.");
      setStatusMessage("");
      return;
    }

    if (!savedModels.length || !draft) {
      setErrorMessage("At least one Model ID is required.");
      setStatusMessage("");
      return;
    }

    const models = (() => {
      if (editorState.mode === "create") {
        return [...savedModels, ...config.models];
      }

      const replacedIndexSet = new Set(editorState.indexes);
      const insertionIndex = Math.min(...editorState.indexes);
      const nextModels: AIImageModel[] = [];

      config.models.forEach((model, index) => {
        if (index === insertionIndex) {
          nextModels.push(...savedModels);
        }

        if (!replacedIndexSet.has(index)) {
          nextModels.push(model);
        }
      });

      return nextModels;
    })();

    const removedDefaultModel =
      editorState.mode === "edit" &&
      editorState.indexes.some(
        (index) => config.models[index]?.id === config.defaultModel,
      );
    const defaultModel =
      setAsDefault || !config.defaultModel || removedDefaultModel
        ? draft.id
        : config.defaultModel;
    const savedConfig = persistConfig(
      {
        ...config,
        defaultModel,
        models,
      },
      editorState.mode === "edit" ? "Models saved." : "Models created.",
    );

    if (savedConfig) {
      setActiveMediaType(draft.mediaType);
      setEditorState({ mode: "list" });
    }
  }, [config, editorState, persistConfig, setAsDefault]);

  const openCreateAgent = useCallback(
    (type: AIAgentType, provider: AIAgentProvider = "openai-compatible") => {
      setActiveAgentSubTab("base");
      setAgentEditorState({
        mode: "create",
        draft: createAgentDraftFromProviderPreset(provider, type),
      });
      setSetAgentAsDefault(
        type === "text"
          ? !agentConfig.defaultTextAgentId
          : type === "vision"
          ? !agentConfig.defaultVisionAgentId
          : !agentConfig.defaultLLMAgentId,
      );
      setStatusMessage("");
      setErrorMessage("");
    },
    [
      agentConfig.defaultLLMAgentId,
      agentConfig.defaultTextAgentId,
      agentConfig.defaultVisionAgentId,
    ],
  );

  const openEditAgent = useCallback(
    (agent: AIAgent) => {
      setActiveAgentSubTab("base");
      setAgentEditorState({
        mode: "edit",
        draft: { ...agent, systemPrompt: agent.systemPrompt || "" },
      });
      setSetAgentAsDefault(
        agent.type === "text"
          ? agent.id === agentConfig.defaultTextAgentId
          : agent.type === "vision"
          ? agent.id === agentConfig.defaultVisionAgentId
          : agent.id === agentConfig.defaultLLMAgentId,
      );
      setStatusMessage("");
      setErrorMessage("");
    },
    [
      agentConfig.defaultLLMAgentId,
      agentConfig.defaultTextAgentId,
      agentConfig.defaultVisionAgentId,
    ],
  );

  const closeAgentEditor = useCallback(() => {
    setAgentEditorState({ mode: "list" });
    setErrorMessage("");
  }, []);

  const updateAgentDraft = useCallback((patch: Partial<AIAgent>) => {
    setAgentEditorState((current) => {
      if (current.mode === "list") {
        return current;
      }

      return {
        ...current,
        draft: {
          ...current.draft,
          ...patch,
        },
      };
    });
    setStatusMessage("");
    setErrorMessage("");
  }, []);

  const applyAgentProviderPreset = useCallback((provider: AIAgentProvider) => {
    setAgentEditorState((current) => {
      if (current.mode === "list") {
        return current;
      }

      return {
        ...current,
        draft: createAgentDraftFromProviderPreset(
          provider,
          current.draft.type,
          current.draft,
        ),
      };
    });
    setStatusMessage(
      `${
        AGENT_PROVIDER_OPTIONS.find((option) => option.value === provider)
          ?.label
      } defaults applied.`,
    );
    setErrorMessage("");
  }, []);

  const submitAgentDraft = useCallback(() => {
    if (agentEditorState.mode === "list") {
      return;
    }

    const draft = normalizeAgentDraftForSave(agentEditorState.draft);

    if (!draft.name.trim()) {
      setErrorMessage("Agent name is required.");
      setStatusMessage("");
      return;
    }

    if (!draft.baseURL.trim()) {
      setErrorMessage("Base URL is required.");
      setStatusMessage("");
      return;
    }

    if (!draft.model.trim()) {
      setErrorMessage("Model is required.");
      setStatusMessage("");
      return;
    }

    const savedConfig = persistAgentConfig(
      upsertAIAgent(agentConfig, draft, setAgentAsDefault),
      agentEditorState.mode === "edit" ? "Agent saved." : "Agent created.",
    );

    if (savedConfig) {
      setAgentEditorState({ mode: "list" });
    }
  }, [agentConfig, agentEditorState, persistAgentConfig, setAgentAsDefault]);

  const removeAgent = useCallback(
    (agent: AIAgent) => {
      if (!window.confirm(`Delete agent "${agent.name}"?`)) {
        return;
      }

      const savedConfig = persistAgentConfig(
        deleteAIAgent(agentConfig, agent),
        "Agent deleted.",
      );

      if (savedConfig) {
        setAgentEditorState({ mode: "list" });
      }
    },
    [agentConfig, persistAgentConfig],
  );

  const makeDefaultAgent = useCallback(
    (agent: AIAgent) => {
      persistAgentConfig(
        setDefaultAIAgent(agentConfig, agent),
        `${agent.name} is now the default ${AGENT_TYPE_LABELS[
          agent.type
        ].toLowerCase()} agent.`,
      );
    },
    [agentConfig, persistAgentConfig],
  );

  const updateUseTextAgentForVision = useCallback(
    (useTextAgentForVision: boolean) => {
      persistAgentConfig(
        {
          ...agentConfig,
          useTextAgentForVision,
        },
        useTextAgentForVision
          ? "Vision tasks will use the default Text Agent."
          : "Vision tasks will use Vision Agents.",
      );
    },
    [agentConfig, persistAgentConfig],
  );

  const openCreateCustomAgent = useCallback(() => {
    if (!agentConfig.llmAgents.length) {
      setErrorMessage("Create an LLM Agent before adding a Custom Agent.");
      setStatusMessage("");
      setActiveAgentSubTab("base");
      return;
    }

    setActiveAgentSubTab("custom");
    setCustomAgentEditorState({
      mode: "create",
      draft: createCustomAgentDraft(agentConfig),
    });
    setSetCustomAgentAsDefault(!agentConfig.defaultCustomAgentId);
    setStatusMessage("");
    setErrorMessage("");
  }, [agentConfig]);

  const openEditCustomAgent = useCallback(
    (agent: CustomAIAgent) => {
      setActiveAgentSubTab("custom");
      setCustomAgentEditorState({
        mode: "edit",
        draft: agent,
      });
      setSetCustomAgentAsDefault(agent.id === agentConfig.defaultCustomAgentId);
      setStatusMessage("");
      setErrorMessage("");
    },
    [agentConfig.defaultCustomAgentId],
  );

  const closeCustomAgentEditor = useCallback(() => {
    setCustomAgentEditorState({ mode: "list" });
    setErrorMessage("");
  }, []);

  const updateCustomAgentDraft = useCallback(
    (patch: Partial<CustomAIAgent>) => {
      setCustomAgentEditorState((current) => {
        if (current.mode === "list") {
          return current;
        }

        return {
          ...current,
          draft: {
            ...current.draft,
            ...patch,
          },
        };
      });
      setStatusMessage("");
      setErrorMessage("");
    },
    [],
  );

  const submitCustomAgentDraft = useCallback(() => {
    if (customAgentEditorState.mode === "list") {
      return;
    }

    const draft = normalizeCustomAgentDraftForSave(
      customAgentEditorState.draft,
    );

    if (!draft.name) {
      setErrorMessage("Custom Agent name is required.");
      setStatusMessage("");
      return;
    }

    if (
      agentConfig.customAgents.some(
        (agent) =>
          agent.id !== draft.id &&
          agent.name.toLowerCase() === draft.name.toLowerCase(),
      )
    ) {
      setErrorMessage("Custom Agent name must be unique.");
      setStatusMessage("");
      return;
    }

    if (!draft.description) {
      setErrorMessage("Custom Agent description is required.");
      setStatusMessage("");
      return;
    }

    if (
      !draft.baseLLMAgentId ||
      !agentConfig.llmAgents.some((agent) => agent.id === draft.baseLLMAgentId)
    ) {
      setErrorMessage("Select an LLM Agent for this Custom Agent.");
      setStatusMessage("");
      return;
    }

    if (!draft.systemPrompt) {
      setErrorMessage("System Prompt is required.");
      setStatusMessage("");
      return;
    }

    const savedConfig = persistAgentConfig(
      upsertCustomAgent(agentConfig, draft, setCustomAgentAsDefault),
      customAgentEditorState.mode === "edit"
        ? "Custom Agent saved."
        : "Custom Agent created.",
    );

    if (savedConfig) {
      setCustomAgentEditorState({ mode: "list" });
    }
  }, [
    agentConfig,
    customAgentEditorState,
    persistAgentConfig,
    setCustomAgentAsDefault,
  ]);

  const removeCustomAgent = useCallback(
    (agent: CustomAIAgent) => {
      const linkedSkillCount = agentConfig.skills.filter(
        (skill) => skill.agentId === agent.id,
      ).length;
      const suffix = linkedSkillCount
        ? ` This will also remove ${linkedSkillCount} linked skill${
            linkedSkillCount === 1 ? "" : "s"
          }.`
        : "";

      if (!window.confirm(`Delete Custom Agent "${agent.name}"?${suffix}`)) {
        return;
      }

      const savedConfig = persistAgentConfig(
        deleteCustomAgent(agentConfig, agent),
        "Custom Agent deleted.",
      );

      if (savedConfig) {
        setCustomAgentEditorState({ mode: "list" });
      }
    },
    [agentConfig, persistAgentConfig],
  );

  const makeDefaultCustomAgent = useCallback(
    (agent: CustomAIAgent) => {
      persistAgentConfig(
        setDefaultCustomAgent(agentConfig, agent),
        `${agent.name} is now the default Custom Agent.`,
      );
    },
    [agentConfig, persistAgentConfig],
  );

  const openCreateSkill = useCallback(() => {
    if (!agentConfig.customAgents.length) {
      setErrorMessage("Create a Custom Agent before adding a Skill.");
      setStatusMessage("");
      setActiveAgentSubTab("custom");
      return;
    }

    setActiveAgentSubTab("skills");
    setSkillEditorState({
      mode: "create",
      draft: createSkillDraft(agentConfig),
    });
    setStatusMessage("");
    setErrorMessage("");
  }, [agentConfig]);

  const openEditSkill = useCallback((skill: AISkill) => {
    setActiveAgentSubTab("skills");
    setSkillEditorState({
      mode: "edit",
      draft: createSkillDraftFromSkill(skill),
    });
    setStatusMessage("");
    setErrorMessage("");
  }, []);

  const closeSkillEditor = useCallback(() => {
    setSkillEditorState({ mode: "list" });
    setErrorMessage("");
  }, []);

  const updateSkillDraft = useCallback((patch: Partial<SkillDraft>) => {
    setSkillEditorState((current) => {
      if (current.mode === "list") {
        return current;
      }

      return {
        ...current,
        draft: {
          ...current.draft,
          ...patch,
        },
      };
    });
    setStatusMessage("");
    setErrorMessage("");
  }, []);

  const submitSkillDraft = useCallback(() => {
    if (skillEditorState.mode === "list") {
      return;
    }

    const draft = normalizeSkillDraftForSave(skillEditorState.draft);

    if (!draft.name) {
      setErrorMessage("Skill name is required.");
      setStatusMessage("");
      return;
    }

    if (
      agentConfig.skills.some(
        (skill) =>
          skill.id !== draft.id &&
          skill.name.toLowerCase() === draft.name.toLowerCase(),
      )
    ) {
      setErrorMessage("Skill name must be unique.");
      setStatusMessage("");
      return;
    }

    if (!draft.description) {
      setErrorMessage("Skill description is required.");
      setStatusMessage("");
      return;
    }

    if (
      !draft.agentId ||
      !agentConfig.customAgents.some((agent) => agent.id === draft.agentId)
    ) {
      setErrorMessage("Select a Custom Agent for this Skill.");
      setStatusMessage("");
      return;
    }

    const savedConfig = persistAgentConfig(
      upsertSkill(agentConfig, draft),
      skillEditorState.mode === "edit" ? "Skill saved." : "Skill created.",
    );

    if (savedConfig) {
      setSkillEditorState({ mode: "list" });
    }
  }, [agentConfig, persistAgentConfig, skillEditorState]);

  const removeSkill = useCallback(
    (skill: AISkill) => {
      if (!window.confirm(`Delete Skill "${skill.name}"?`)) {
        return;
      }

      const savedConfig = persistAgentConfig(
        deleteSkill(agentConfig, skill),
        "Skill deleted.",
      );

      if (savedConfig) {
        setSkillEditorState({ mode: "list" });
      }
    },
    [agentConfig, persistAgentConfig],
  );

  const openCreateTemplate = useCallback(() => {
    setTemplateEditorState({
      mode: "create",
      draft: createPromptTemplateDraft(),
    });
    setStatusMessage("");
    setErrorMessage("");
  }, []);

  const openEditTemplate = useCallback((template: PromptTemplate) => {
    if (template.isBuiltIn) {
      return;
    }

    setTemplateEditorState({
      mode: "edit",
      templateId: template.id,
      draft: createPromptTemplateDraftFromTemplate(template),
    });
    setStatusMessage("");
    setErrorMessage("");
  }, []);

  const closeTemplateEditor = useCallback(() => {
    setTemplateEditorState({ mode: "list" });
    setErrorMessage("");
  }, []);

  const updateTemplateDraft = useCallback(
    (patch: Partial<PromptTemplateDraft>) => {
      setTemplateEditorState((current) => {
        if (current.mode === "list") {
          return current;
        }

        return {
          ...current,
          draft: {
            ...current.draft,
            ...patch,
          },
        };
      });
      setStatusMessage("");
      setErrorMessage("");
    },
    [],
  );

  const toggleTemplateMode = useCallback((mode: AIImageGenerationMode) => {
    setTemplateEditorState((current) => {
      if (current.mode === "list") {
        return current;
      }

      const modes = current.draft.modes.includes(mode)
        ? current.draft.modes.filter((item) => item !== mode)
        : [...current.draft.modes, mode];

      return {
        ...current,
        draft: {
          ...current.draft,
          modes,
        },
      };
    });
    setStatusMessage("");
    setErrorMessage("");
  }, []);

  const submitTemplateDraft = useCallback(() => {
    if (templateEditorState.mode === "list") {
      return;
    }

    const draft = templateEditorState.draft;

    if (!draft.label.trim()) {
      setErrorMessage("Template label is required.");
      setStatusMessage("");
      return;
    }

    if (!draft.template.trim()) {
      setErrorMessage("Template content is required.");
      setStatusMessage("");
      return;
    }

    if (!draft.modes.length) {
      setErrorMessage("Select at least one applicable mode.");
      setStatusMessage("");
      return;
    }

    upsertCustomPromptTemplate({
      id:
        templateEditorState.mode === "edit"
          ? templateEditorState.templateId
          : undefined,
      label: draft.label.trim(),
      template: draft.template.trim(),
      modes: draft.modes,
      category: draft.category,
      language: draft.language,
    });
    setCustomTemplates(loadCustomPromptTemplates());
    setTemplateEditorState({ mode: "list" });
    setStatusMessage(
      templateEditorState.mode === "edit"
        ? "Template saved."
        : "Template created.",
    );
    setErrorMessage("");
  }, [templateEditorState]);

  const removeTemplate = useCallback((template: PromptTemplate) => {
    if (
      template.isBuiltIn ||
      !window.confirm(`Delete template "${template.label}"?`)
    ) {
      return;
    }

    deleteCustomPromptTemplate(template.id);
    setCustomTemplates(loadCustomPromptTemplates());
    setStatusMessage("Template deleted.");
    setErrorMessage("");
  }, []);

  const exportTemplates = useCallback(() => {
    const blob = new Blob([serializePromptTemplates(customTemplates)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "prompt-templates.json";
    link.click();
    URL.revokeObjectURL(url);
  }, [customTemplates]);

  const importTemplates = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      const importedTemplates = parsePromptTemplateImport(text);
      const mergedTemplates = [
        ...importedTemplates,
        ...loadCustomPromptTemplates().filter(
          (template) =>
            !importedTemplates.some(
              (importedTemplate) => importedTemplate.id === template.id,
            ),
        ),
      ];

      saveCustomPromptTemplates(mergedTemplates);
      setCustomTemplates(loadCustomPromptTemplates());
      setStatusMessage(`${importedTemplates.length} templates imported.`);
      setErrorMessage("");
    } catch (error: any) {
      setErrorMessage(error?.message || "Could not import templates.");
      setStatusMessage("");
    }
  }, []);

  const renderList = () => (
    <>
      <div className="AISettings__toolbar">
        <span>Models</span>
        <span className="AISettings__toolbarActions">
          <button type="button" onClick={openCreateModel}>
            Add model
          </button>
        </span>
      </div>

      <div className="AISettings__tabs" role="tablist" aria-label="AI models">
        {AI_MODEL_MEDIA_TYPES.map((mediaType) => (
          <button
            key={mediaType}
            type="button"
            role="tab"
            aria-selected={activeMediaType === mediaType}
            className={
              activeMediaType === mediaType
                ? "AISettings__tab is-selected"
                : "AISettings__tab"
            }
            onClick={() => setActiveMediaType(mediaType)}
          >
            {MEDIA_TYPE_LABELS[mediaType]}
          </button>
        ))}
      </div>

      <div className="AISettings__models">
        {visibleModelGroups.length === 0 && (
          <div className="AISettings__emptyState">
            No {activeMediaType} models.
          </div>
        )}

        {visibleModelGroups.map((group) => {
          const isDefault = group.models.some(
            (model) => config.defaultModel === model.id,
          );

          return (
            <div className="AISettings__modelPreviewCard" key={group.key}>
              <div className="AISettings__agentCardHeader">
                <strong>{group.model.siteName}</strong>
                <span className="AISettings__templateMeta">
                  <span>{MEDIA_TYPE_LABELS[group.model.mediaType]}</span>
                  {group.models.length > 1 && (
                    <span>{group.models.length} models</span>
                  )}
                  {isDefault && <span>Default</span>}
                </span>
              </div>

              <div className="AISettings__agentMeta">
                <span>Models: {formatModelGroupNames(group.models)}</span>
                <span>Base URL: {group.model.baseURL}</span>
                {group.model.mediaType === "image" && (
                  <span>
                    Native model:{" "}
                    {group.model.nativeModel || DEFAULT_AI_IMAGE_NATIVE_MODEL}
                  </span>
                )}
              </div>

              <div className="AISettings__agentActions">
                <button type="button" onClick={() => openEditModelGroup(group)}>
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => removeModelGroup(group.indexes)}
                >
                  Delete
                </button>
                <button
                  type="button"
                  disabled={isDefault}
                  onClick={() => makeDefaultModelGroup(group)}
                >
                  Set as Default
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );

  const renderAgentSubTabs = () => (
    <div
      className="AISettings__tabs AISettings__tabs--agents"
      role="tablist"
      aria-label="AI agent sections"
    >
      {[
        { id: "base", label: "Base Agents" },
        { id: "custom", label: "Custom Agents" },
        { id: "skills", label: "Skills" },
      ].map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={activeAgentSubTab === tab.id}
          className={
            activeAgentSubTab === tab.id
              ? "AISettings__tab is-selected"
              : "AISettings__tab"
          }
          onClick={() => {
            setActiveAgentSubTab(tab.id as AgentSettingsSubTab);
            setStatusMessage("");
            setErrorMessage("");
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );

  const renderBaseAgentsList = () => (
    <>
      <div className="AISettings__toolbar">
        <span>Base Agent Configuration</span>
        <span className="AISettings__toolbarActions">
          <button type="button" onClick={() => openCreateAgent("text")}>
            Add Text Agent
          </button>
          <button type="button" onClick={() => openCreateAgent("vision")}>
            Add Vision Agent
          </button>
          <button type="button" onClick={() => openCreateAgent("llm")}>
            Add LLM Agent
          </button>
        </span>
      </div>

      <div className="AISettings__agentIntro">
        Configure base agents for text-to-diagram, diagram-to-code, and Custom
        Agent model access. Create multiple agents and switch defaults per task.
      </div>

      <div className="AISettings__agentSections">
        {renderAgentSection(
          "Text Agents",
          "for Text-to-Diagram",
          agentConfig.textAgents,
          agentConfig.defaultTextAgentId,
          "text",
        )}
        {renderAgentSection(
          "Vision Agents",
          "for Diagram-to-Code",
          agentConfig.visionAgents,
          agentConfig.defaultVisionAgentId,
          "vision",
        )}
        {renderAgentSection(
          "LLM Agents",
          "for Custom Agents",
          agentConfig.llmAgents,
          agentConfig.defaultLLMAgentId,
          "llm",
        )}

        <label className="AISettings__agentToggle">
          <input
            type="checkbox"
            checked={agentConfig.useTextAgentForVision}
            onChange={(event) =>
              updateUseTextAgentForVision(event.target.checked)
            }
          />
          <span>
            Use default Text Agent for vision tasks
            <small>
              When enabled, Diagram-to-Code uses the default Text Agent instead
              of Vision Agents.
            </small>
          </span>
        </label>
      </div>
    </>
  );

  const renderCustomAgentsList = () => (
    <>
      <div className="AISettings__toolbar">
        <span>Custom Agents</span>
        <span className="AISettings__toolbarActions">
          <button
            type="button"
            disabled={!agentConfig.llmAgents.length}
            onClick={openCreateCustomAgent}
          >
            Add Custom Agent
          </button>
        </span>
      </div>

      <div className="AISettings__agentIntro">
        Define reusable assistant roles with their own System Prompt. Each
        Custom Agent uses one LLM Agent as its base model.
      </div>

      {!agentConfig.llmAgents.length && (
        <div className="AISettings__emptyState">
          Add an LLM Agent before creating Custom Agents.
        </div>
      )}

      <div className="AISettings__agentSections AISettings__agentSections--single">
        <div className="AISettings__agentSection">
          {agentConfig.customAgents.length === 0 && (
            <div className="AISettings__emptyState">
              No Custom Agents yet. Add one to create reusable assistant roles.
            </div>
          )}

          <div className="AISettings__agentList">
            {agentConfig.customAgents.map((agent) => {
              const llmAgent = agentConfig.llmAgents.find(
                (item) => item.id === agent.baseLLMAgentId,
              );
              const isDefault = agent.id === agentConfig.defaultCustomAgentId;

              return (
                <div className="AISettings__agentCard" key={agent.id}>
                  <div className="AISettings__agentCardHeader">
                    <strong>
                      <span className="AISettings__iconBadge">
                        {agent.icon}
                      </span>
                      {agent.name}
                    </strong>
                    <span className="AISettings__templateMeta">
                      {isDefault && <span>Default</span>}
                    </span>
                  </div>
                  <p className="AISettings__agentDescription">
                    {agent.description}
                  </p>
                  <div className="AISettings__agentMeta">
                    <span>Model: {llmAgent?.name || "Missing LLM Agent"}</span>
                  </div>
                  <div className="AISettings__agentActions">
                    <button
                      type="button"
                      onClick={() => openEditCustomAgent(agent)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => removeCustomAgent(agent)}
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      disabled={isDefault}
                      onClick={() => makeDefaultCustomAgent(agent)}
                    >
                      Set as Default
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );

  const renderSkillsList = () => (
    <>
      <div className="AISettings__toolbar">
        <span>Skills</span>
        <span className="AISettings__toolbarActions">
          <button
            type="button"
            disabled={!agentConfig.customAgents.length}
            onClick={openCreateSkill}
          >
            Add Skill
          </button>
        </span>
      </div>

      <div className="AISettings__agentIntro">
        Create quick-start scenarios that select a Custom Agent and optionally
        provide an initial prompt template with {"{user_input}"}.
      </div>

      {!agentConfig.customAgents.length && (
        <div className="AISettings__emptyState">
          Add a Custom Agent before creating Skills.
        </div>
      )}

      <div className="AISettings__agentSections AISettings__agentSections--single">
        <div className="AISettings__agentSection">
          {agentConfig.skills.length === 0 && (
            <div className="AISettings__emptyState">
              No Skills yet. Add one to create a reusable start template.
            </div>
          )}

          <div className="AISettings__agentList">
            {agentConfig.skills.map((skill) => {
              const customAgent = agentConfig.customAgents.find(
                (agent) => agent.id === skill.agentId,
              );

              return (
                <div className="AISettings__agentCard" key={skill.id}>
                  <div className="AISettings__agentCardHeader">
                    <strong>
                      <span className="AISettings__iconBadge">
                        {skill.icon}
                      </span>
                      {skill.name}
                    </strong>
                  </div>
                  <p className="AISettings__agentDescription">
                    {skill.description}
                  </p>
                  <div className="AISettings__agentMeta">
                    <span>
                      Agent: {customAgent?.name || "Missing Custom Agent"}
                    </span>
                    <span>
                      Trigger: {skill.triggers?.join(", ") || "Not configured"}
                    </span>
                  </div>
                  <div className="AISettings__agentActions">
                    <button type="button" onClick={() => openEditSkill(skill)}>
                      Edit
                    </button>
                    <button type="button" onClick={() => removeSkill(skill)}>
                      Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );

  const renderAgentsList = () => (
    <>
      {renderAgentSubTabs()}
      {activeAgentSubTab === "base" && renderBaseAgentsList()}
      {activeAgentSubTab === "custom" && renderCustomAgentsList()}
      {activeAgentSubTab === "skills" && renderSkillsList()}
    </>
  );

  const renderAgentSection = (
    title: string,
    subtitle: string,
    agents: AIAgent[],
    defaultAgentId: string | null,
    type: AIAgentType,
  ) => (
    <div className="AISettings__agentSection">
      <div className="AISettings__sectionHeader">
        <h4>
          {title} <span>{subtitle}</span>
        </h4>
        <button type="button" onClick={() => openCreateAgent(type)}>
          Add {AGENT_TYPE_LABELS[type]} Agent
        </button>
      </div>

      {agents.length === 0 && (
        <div className="AISettings__emptyState">
          No {AGENT_TYPE_LABELS[type].toLowerCase()} agents yet. Add one to
          enable{" "}
          {type === "text"
            ? "Text-to-Diagram"
            : type === "vision"
            ? "Diagram-to-Code"
            : "Custom Agents"}
          .
        </div>
      )}

      <div className="AISettings__agentList">
        {agents.map((agent) => {
          const providerLabel =
            AGENT_PROVIDER_OPTIONS.find(
              (option) => option.value === agent.provider,
            )?.label || agent.provider;
          const isDefault = agent.id === defaultAgentId;

          return (
            <div className="AISettings__agentCard" key={agent.id}>
              <div className="AISettings__agentCardHeader">
                <strong>{agent.name}</strong>
                <span className="AISettings__templateMeta">
                  <span>{providerLabel}</span>
                  {isDefault && <span>Default</span>}
                </span>
              </div>
              <div className="AISettings__agentMeta">
                <span>Model: {agent.model}</span>
                <span>Base URL: {agent.baseURL}</span>
              </div>
              <div className="AISettings__agentActions">
                <button type="button" onClick={() => openEditAgent(agent)}>
                  Edit
                </button>
                <button type="button" onClick={() => removeAgent(agent)}>
                  Delete
                </button>
                <button
                  type="button"
                  disabled={isDefault}
                  onClick={() => makeDefaultAgent(agent)}
                >
                  Set as Default
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );

  const renderAgentEditor = () => {
    if (agentEditorState.mode === "list") {
      return null;
    }

    const { draft } = agentEditorState;
    const providerPreset = getAIAgentProviderPreset(draft.provider);

    return (
      <>
        <div className="AISettings__editorHeader">
          <button
            className="AISettings__textButton"
            type="button"
            onClick={closeAgentEditor}
          >
            Back
          </button>
          <h3>
            {agentEditorState.mode === "edit" ? "Edit" : "Add"}{" "}
            {AGENT_TYPE_LABELS[draft.type]} Agent
          </h3>
        </div>

        <div className="AISettings__providerPresets">
          <span className="AISettings__providerPresetsLabel">
            Default configs
          </span>
          <div className="AISettings__providerPresetList AISettings__providerPresetList--agents">
            {AI_AGENT_PROVIDER_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                title={preset.description}
                onClick={() => applyAgentProviderPreset(preset.id)}
              >
                <strong>{preset.name}</strong>
                <span>
                  {draft.type === "text"
                    ? preset.recommendedTextModel || "Custom model"
                    : draft.type === "vision"
                    ? preset.recommendedVisionModel || "Custom model"
                    : preset.recommendedTextModel || "Custom model"}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="AISettings__editorBody AISettings__editorBody--single">
          <div className="AISettings__formSection AISettings__formSection--wide">
            <div className="AISettings__modelGrid">
              <label className="AISettings__field">
                <span>Agent Name</span>
                <input
                  value={draft.name}
                  placeholder="My GPT-4o-mini"
                  onChange={(event) =>
                    updateAgentDraft({ name: event.target.value })
                  }
                />
                <span className="AISettings__fieldHint">
                  Displayed in the agent list.
                </span>
              </label>

              <label className="AISettings__field">
                <span>Provider</span>
                <select
                  value={draft.provider}
                  onChange={(event) =>
                    applyAgentProviderPreset(
                      event.target.value as AIAgentProvider,
                    )
                  }
                >
                  {AGENT_PROVIDER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {providerPreset?.description && (
                  <span className="AISettings__fieldHint">
                    {providerPreset.description}
                  </span>
                )}
              </label>

              <label className="AISettings__field">
                <span>Base URL</span>
                <input
                  value={draft.baseURL}
                  placeholder="https://api.example.com/v1"
                  onChange={(event) =>
                    updateAgentDraft({ baseURL: event.target.value })
                  }
                />
              </label>

              <label className="AISettings__field">
                <span>API Key</span>
                <input
                  value={draft.apiKey}
                  type="password"
                  autoComplete="off"
                  onChange={(event) =>
                    updateAgentDraft({ apiKey: event.target.value })
                  }
                />
                <span className="AISettings__fieldHint">
                  Stored locally in this browser.
                </span>
              </label>

              <label className="AISettings__field">
                <span>Model</span>
                <input
                  value={draft.model}
                  placeholder={
                    draft.type === "vision" ? "gpt-4o" : "gpt-4o-mini"
                  }
                  onChange={(event) =>
                    updateAgentDraft({ model: event.target.value })
                  }
                />
              </label>

              <label className="AISettings__defaultField">
                <input
                  type="checkbox"
                  checked={setAgentAsDefault}
                  onChange={(event) =>
                    setSetAgentAsDefault(event.target.checked)
                  }
                />
                <span>Default {AGENT_TYPE_LABELS[draft.type]} Agent</span>
              </label>
            </div>

            <label className="AISettings__field">
              <span>System Prompt (optional)</span>
              <textarea
                value={draft.systemPrompt || ""}
                rows={4}
                placeholder={
                  providerPreset?.defaultSystemPrompts[draft.type] || ""
                }
                onChange={(event) =>
                  updateAgentDraft({ systemPrompt: event.target.value })
                }
              />
              <span className="AISettings__fieldHint">
                Leave empty to use the provider default prompt.
              </span>
            </label>

            <div className="AISettings__agentRecommendations">
              <strong>
                Recommended for{" "}
                {draft.type === "text"
                  ? "TTD"
                  : draft.type === "vision"
                  ? "D2C"
                  : "Custom Agents"}
              </strong>
              {AGENT_RECOMMENDATIONS[draft.type].map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
          </div>
        </div>

        <div className="AISettings__editorActions">
          {agentEditorState.mode === "edit" && (
            <button
              className="AISettings__dangerButton"
              type="button"
              onClick={() => removeAgent(agentEditorState.draft)}
            >
              Remove
            </button>
          )}

          <Button
            className="AISettings__saveButton"
            onSelect={submitAgentDraft}
          >
            {agentEditorState.mode === "edit" ? "Save agent" : "Create agent"}
          </Button>
        </div>
      </>
    );
  };

  const renderIconSelect = (
    value: string,
    onChange: (value: string) => void,
  ) => (
    <label className="AISettings__field">
      <span>Icon</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {ICON_OPTIONS.map((icon) => (
          <option key={icon} value={icon}>
            {icon}
          </option>
        ))}
      </select>
    </label>
  );

  const renderCustomAgentEditor = () => {
    if (customAgentEditorState.mode === "list") {
      return null;
    }

    const { draft } = customAgentEditorState;

    return (
      <>
        <div className="AISettings__editorHeader">
          <button
            className="AISettings__textButton"
            type="button"
            onClick={closeCustomAgentEditor}
          >
            Back
          </button>
          <h3>
            {customAgentEditorState.mode === "edit" ? "Edit" : "Create"} Custom
            Agent
          </h3>
        </div>

        <div className="AISettings__editorBody AISettings__editorBody--single">
          <div className="AISettings__formSection AISettings__formSection--wide">
            <div className="AISettings__modelGrid">
              <label className="AISettings__field">
                <span>Name</span>
                <input
                  value={draft.name}
                  placeholder="Prompt optimization expert"
                  onChange={(event) =>
                    updateCustomAgentDraft({ name: event.target.value })
                  }
                />
              </label>

              {renderIconSelect(draft.icon, (icon) =>
                updateCustomAgentDraft({ icon }),
              )}

              <label className="AISettings__field">
                <span>Description</span>
                <input
                  value={draft.description}
                  placeholder="Helps optimize image generation prompts"
                  onChange={(event) =>
                    updateCustomAgentDraft({
                      description: event.target.value,
                    })
                  }
                />
              </label>

              <label className="AISettings__field">
                <span>Model</span>
                <select
                  value={draft.baseLLMAgentId}
                  onChange={(event) =>
                    updateCustomAgentDraft({
                      baseLLMAgentId: event.target.value,
                    })
                  }
                >
                  <option value="">Select an LLM Agent</option>
                  {agentConfig.llmAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
                <span className="AISettings__fieldHint">
                  Custom Agents use LLM Agents as their base model.
                </span>
              </label>

              <label className="AISettings__defaultField">
                <input
                  type="checkbox"
                  checked={setCustomAgentAsDefault}
                  onChange={(event) =>
                    setSetCustomAgentAsDefault(event.target.checked)
                  }
                />
                <span>Default Custom Agent</span>
              </label>
            </div>

            <label className="AISettings__field">
              <span>System Prompt</span>
              <textarea
                value={draft.systemPrompt}
                rows={8}
                placeholder="You are an expert prompt engineer. Help users improve prompts with concrete, useful suggestions."
                onChange={(event) =>
                  updateCustomAgentDraft({ systemPrompt: event.target.value })
                }
              />
            </label>
          </div>
        </div>

        <div className="AISettings__editorActions">
          {customAgentEditorState.mode === "edit" && (
            <button
              className="AISettings__dangerButton"
              type="button"
              onClick={() => removeCustomAgent(customAgentEditorState.draft)}
            >
              Remove
            </button>
          )}

          <Button
            className="AISettings__saveButton"
            onSelect={submitCustomAgentDraft}
          >
            {customAgentEditorState.mode === "edit"
              ? "Save agent"
              : "Create agent"}
          </Button>
        </div>
      </>
    );
  };

  const renderSkillEditor = () => {
    if (skillEditorState.mode === "list") {
      return null;
    }

    const { draft } = skillEditorState;

    return (
      <>
        <div className="AISettings__editorHeader">
          <button
            className="AISettings__textButton"
            type="button"
            onClick={closeSkillEditor}
          >
            Back
          </button>
          <h3>{skillEditorState.mode === "edit" ? "Edit" : "Create"} Skill</h3>
        </div>

        <div className="AISettings__editorBody AISettings__editorBody--single">
          <div className="AISettings__formSection AISettings__formSection--wide">
            <div className="AISettings__modelGrid">
              <label className="AISettings__field">
                <span>Skill Name</span>
                <input
                  value={draft.name}
                  placeholder="Image prompt optimization"
                  onChange={(event) =>
                    updateSkillDraft({ name: event.target.value })
                  }
                />
              </label>

              {renderIconSelect(draft.icon, (icon) =>
                updateSkillDraft({ icon }),
              )}

              <label className="AISettings__field">
                <span>Description</span>
                <input
                  value={draft.description}
                  placeholder="Quickly improve image generation prompts"
                  onChange={(event) =>
                    updateSkillDraft({ description: event.target.value })
                  }
                />
              </label>

              <label className="AISettings__field">
                <span>Custom Agent</span>
                <select
                  value={draft.agentId}
                  onChange={(event) =>
                    updateSkillDraft({ agentId: event.target.value })
                  }
                >
                  <option value="">Select a Custom Agent</option>
                  {agentConfig.customAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.icon} {agent.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="AISettings__field">
                <span>Triggers (optional)</span>
                <input
                  value={draft.triggers}
                  placeholder="optimize prompt, image prompt"
                  onChange={(event) =>
                    updateSkillDraft({ triggers: event.target.value })
                  }
                />
                <span className="AISettings__fieldHint">
                  Separate multiple triggers with commas.
                </span>
              </label>
            </div>

            <label className="AISettings__field">
              <span>Initial Prompt (optional)</span>
              <textarea
                value={draft.initialPrompt || ""}
                rows={7}
                placeholder="I need to optimize this image prompt: {user_input}"
                onChange={(event) =>
                  updateSkillDraft({ initialPrompt: event.target.value })
                }
              />
              <span className="AISettings__fieldHint">
                Leave empty to only switch agents. {"{user_input}"} is replaced
                with the user's input.
              </span>
            </label>
          </div>
        </div>

        <div className="AISettings__editorActions">
          {skillEditorState.mode === "edit" && (
            <button
              className="AISettings__dangerButton"
              type="button"
              onClick={() =>
                removeSkill(normalizeSkillDraftForSave(skillEditorState.draft))
              }
            >
              Remove
            </button>
          )}

          <Button
            className="AISettings__saveButton"
            onSelect={submitSkillDraft}
          >
            {skillEditorState.mode === "edit" ? "Save skill" : "Create skill"}
          </Button>
        </div>
      </>
    );
  };

  const renderTemplatesList = () => {
    const builtInTemplates = allTemplates.filter(
      (template) => template.isBuiltIn,
    );
    const savedCustomTemplates = allTemplates.filter(
      (template) => !template.isBuiltIn,
    );

    return (
      <>
        <div className="AISettings__toolbar">
          <span>Prompt Templates</span>
          <span className="AISettings__toolbarActions">
            <button
              type="button"
              onClick={() => templateImportInputRef.current?.click()}
            >
              Import
            </button>
            <button
              type="button"
              disabled={!customTemplates.length}
              onClick={exportTemplates}
            >
              Export
            </button>
            <button type="button" onClick={openCreateTemplate}>
              Add template
            </button>
          </span>
        </div>

        <input
          ref={templateImportInputRef}
          className="AISettings__visuallyHidden"
          type="file"
          accept="application/json,.json"
          onChange={(event) => {
            const file = event.target.files?.[0];

            if (file) {
              importTemplates(file);
            }
            event.target.value = "";
          }}
        />

        <div className="AISettings__templateSections">
          {renderTemplateSection("Built-in Templates", builtInTemplates)}
          {renderTemplateSection("Custom Templates", savedCustomTemplates)}
        </div>
      </>
    );
  };

  const renderTemplateSection = (
    title: string,
    templates: PromptTemplate[],
  ) => (
    <div className="AISettings__templateSection">
      <div className="AISettings__sectionHeader">
        <h4>{title}</h4>
        <span className="AISettings__summaryBadge">{templates.length}</span>
      </div>
      {templates.length === 0 && (
        <div className="AISettings__emptyState">No templates yet.</div>
      )}
      <div className="AISettings__templateList">
        {templates.map((template) => (
          <div className="AISettings__templateCard" key={template.id}>
            <div className="AISettings__templateCardHeader">
              <strong>{template.label}</strong>
              {!template.isBuiltIn && (
                <span className="AISettings__templateActions">
                  <button
                    type="button"
                    onClick={() => openEditTemplate(template)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => removeTemplate(template)}
                  >
                    Delete
                  </button>
                </span>
              )}
            </div>
            <div className="AISettings__templateMeta">
              <span>{formatTemplateModes(template.modes)}</span>
              <span>{template.category || "custom"}</span>
              <span>{template.language || "multi"}</span>
            </div>
            <p>{template.template}</p>
          </div>
        ))}
      </div>
    </div>
  );

  const renderTemplateEditor = () => {
    if (templateEditorState.mode === "list") {
      return null;
    }

    const { draft } = templateEditorState;

    return (
      <>
        <div className="AISettings__editorHeader">
          <button
            className="AISettings__textButton"
            type="button"
            onClick={closeTemplateEditor}
          >
            Back
          </button>
          <h3>
            {templateEditorState.mode === "edit"
              ? "Edit template"
              : "New template"}
          </h3>
        </div>

        <div className="AISettings__editorBody AISettings__editorBody--single">
          <div className="AISettings__formSection AISettings__formSection--wide">
            <label className="AISettings__field">
              <span>Label</span>
              <input
                value={draft.label}
                onChange={(event) =>
                  updateTemplateDraft({ label: event.target.value })
                }
              />
            </label>

            <label className="AISettings__field">
              <span>Template Content</span>
              <textarea
                value={draft.template}
                rows={5}
                onChange={(event) =>
                  updateTemplateDraft({ template: event.target.value })
                }
              />
            </label>

            <div className="AISettings__templateModeGrid">
              {TEMPLATE_MODE_OPTIONS.map((option) => (
                <label key={option.value}>
                  <input
                    type="checkbox"
                    checked={draft.modes.includes(option.value)}
                    onChange={() => toggleTemplateMode(option.value)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>

            <div className="AISettings__modelGrid">
              <label className="AISettings__field">
                <span>Category</span>
                <select
                  value={draft.category}
                  onChange={(event) =>
                    updateTemplateDraft({
                      category: event.target.value as PromptTemplateCategory,
                    })
                  }
                >
                  {TEMPLATE_CATEGORY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="AISettings__field">
                <span>Language</span>
                <select
                  value={draft.language}
                  onChange={(event) =>
                    updateTemplateDraft({
                      language: event.target.value as PromptTemplateLanguage,
                    })
                  }
                >
                  {TEMPLATE_LANGUAGE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="AISettings__fieldHint">
              Supported placeholders: #1, #2, #N and [text].
            </div>
          </div>
        </div>

        <div className="AISettings__editorActions">
          <Button
            className="AISettings__saveButton"
            onSelect={submitTemplateDraft}
          >
            {templateEditorState.mode === "edit"
              ? "Save template"
              : "Create template"}
          </Button>
        </div>
      </>
    );
  };

  const renderEditor = () => {
    if (editorState.mode === "list") {
      return null;
    }

    const { draft } = editorState;
    const selectedPreset = getPresetById(draft.endpointPresetId);
    const fieldMappingCount = Object.values(draft.fieldMapping || {}).filter(
      Boolean,
    ).length;
    const capabilityCount = draft.capabilities.length;
    const updateEndpoint = (
      endpointKey: keyof AIImageEndpoints,
      patch: Partial<AIImageEndpointConfig>,
    ) => {
      updateDraft({
        endpointPresetId: "custom",
        endpoints: {
          ...draft.endpoints,
          [endpointKey]: {
            ...draft.endpoints[endpointKey],
            ...patch,
          },
        },
      });
    };
    const updateFieldMapping = (
      fieldKey: keyof AIImageFieldMapping,
      value: string,
    ) => {
      const nextFieldMapping: AIImageFieldMapping = {
        ...(draft.fieldMapping || {}),
      };
      const trimmedValue = value.trim();

      if (trimmedValue) {
        nextFieldMapping[fieldKey] = trimmedValue;
      } else {
        delete nextFieldMapping[fieldKey];
      }

      updateDraft({
        endpointPresetId: "custom",
        fieldMapping: Object.keys(nextFieldMapping).length
          ? nextFieldMapping
          : undefined,
      });
    };

    return (
      <>
        <div className="AISettings__editorHeader">
          <button
            className="AISettings__textButton"
            type="button"
            onClick={closeEditor}
          >
            Back
          </button>
          <h3>{editorState.mode === "edit" ? "Edit model" : "New model"}</h3>
        </div>

        <div className="AISettings__providerPresets">
          <span className="AISettings__providerPresetsLabel">
            Quick presets
          </span>
          <div className="AISettings__providerPresetList">
            {DEFAULT_AI_MODEL_PROVIDER_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                title={preset.description}
                onClick={() => applyProviderPreset(preset)}
              >
                <strong>{preset.name}</strong>
                <span>{preset.model}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="AISettings__editorBody">
          <div className="AISettings__formSection">
            <div className="AISettings__sectionHeader">
              <h4>Connection</h4>
            </div>

            <div className="AISettings__connectionGrid">
              <label className="AISettings__field">
                <span>Site name</span>
                <input
                  value={draft.siteName}
                  onChange={(event) =>
                    updateDraft({ siteName: event.target.value })
                  }
                />
              </label>

              <label className="AISettings__field">
                <span>Base URL</span>
                <input
                  value={draft.baseURL}
                  onChange={(event) =>
                    updateDraft({ baseURL: event.target.value })
                  }
                  placeholder="https://api.example.com/v1"
                />
              </label>

              <label className="AISettings__field">
                <span>API Key</span>
                <input
                  value={draft.apiKey}
                  type="password"
                  autoComplete="off"
                  onChange={(event) =>
                    updateDraft({ apiKey: event.target.value })
                  }
                />
              </label>
            </div>
          </div>

          <div className="AISettings__formSection">
            <div className="AISettings__sectionHeader">
              <h4>Model</h4>
              <label className="AISettings__defaultField">
                <input
                  type="checkbox"
                  checked={setAsDefault}
                  onChange={(event) => setSetAsDefault(event.target.checked)}
                />
                <span>Default model</span>
              </label>
            </div>

            <div className="AISettings__modelGrid">
              <label className="AISettings__field AISettings__modelIdsField">
                <span>Model IDs</span>
                <textarea
                  value={draft.model}
                  rows={4}
                  onChange={(event) =>
                    updateDraft({ model: event.target.value })
                  }
                />
                <span className="AISettings__fieldHint">
                  One model per line, or separated by commas/semicolons.
                </span>
              </label>

              {draft.mediaType === "image" && (
                <label className="AISettings__field AISettings__modelRightField1">
                  <span>Native model</span>
                  <select
                    value={draft.nativeModel || DEFAULT_AI_IMAGE_NATIVE_MODEL}
                    onChange={(event) =>
                      updateDraft({
                        nativeModel: event.target.value as AIImageNativeModel,
                      })
                    }
                  >
                    {AI_IMAGE_NATIVE_MODEL_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label
                className={
                  draft.mediaType === "image"
                    ? "AISettings__field AISettings__modelRightField2"
                    : "AISettings__field AISettings__modelRightField1"
                }
              >
                <span>Type</span>
                <select
                  value={draft.mediaType}
                  onChange={(event) =>
                    updateDraft({
                      mediaType: event.target.value as AIModelMediaType,
                    })
                  }
                >
                  {AI_MODEL_MEDIA_TYPES.map((mediaType) => (
                    <option key={mediaType} value={mediaType}>
                      {MEDIA_TYPE_LABELS[mediaType]}
                    </option>
                  ))}
                </select>
              </label>

              <label
                className={
                  draft.mediaType === "image"
                    ? "AISettings__field AISettings__modelRightField3"
                    : "AISettings__field AISettings__modelRightField2"
                }
              >
                <span>Timeout (seconds)</span>
                <input
                  inputMode="numeric"
                  pattern="[0-9]*"
                  type="text"
                  value={draft.requestTimeoutSeconds}
                  onChange={(event) => {
                    const nextValue = event.target.value.trim();

                    if (/^\d*$/.test(nextValue)) {
                      updateDraft({
                        requestTimeoutSeconds: nextValue,
                      });
                    }
                  }}
                  onBlur={() =>
                    updateDraft({
                      requestTimeoutSeconds: String(
                        normalizeRequestTimeoutSeconds(
                          draft.requestTimeoutSeconds,
                        ),
                      ),
                    })
                  }
                />
              </label>
            </div>
          </div>

          {draft.mediaType === "image" && (
            <div className="AISettings__formSection AISettings__formSection--wide">
              <div className="AISettings__sectionHeader">
                <h4>API configuration</h4>
              </div>

              <label className="AISettings__field AISettings__presetField">
                <span>Endpoint preset</span>
                <select
                  value={draft.endpointPresetId}
                  onChange={(event) => {
                    const preset = getPresetById(event.target.value);

                    if (!preset) {
                      return;
                    }

                    updateDraft({
                      endpointPresetId: preset.id,
                      endpoints: cloneAIImageEndpoints(preset.endpoints),
                      fieldMapping: cloneAIImageFieldMapping(
                        preset.fieldMapping,
                      ),
                    });
                  }}
                >
                  {ENDPOINT_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                    </option>
                  ))}
                </select>
                {selectedPreset?.description && (
                  <span className="AISettings__fieldHint">
                    {selectedPreset.description}
                  </span>
                )}
              </label>

              <div className="AISettings__endpointMatrix">
                <div className="AISettings__endpointHeader" aria-hidden="true">
                  <span>Mode</span>
                  <span>Path</span>
                  <span>Format</span>
                </div>

                {ENDPOINT_FORM_FIELDS.map((endpointField) => {
                  const endpoint = draft.endpoints[endpointField.key];

                  return (
                    <div
                      className="AISettings__endpointRow"
                      key={endpointField.key}
                    >
                      <span className="AISettings__endpointLabel">
                        {endpointField.label}
                      </span>
                      <label className="AISettings__field">
                        <span className="AISettings__visuallyHidden">
                          {endpointField.label} path
                        </span>
                        <input
                          value={endpoint.path}
                          placeholder={endpointField.placeholder}
                          onChange={(event) =>
                            updateEndpoint(endpointField.key, {
                              path: event.target.value,
                            })
                          }
                        />
                      </label>

                      <label className="AISettings__field">
                        <span className="AISettings__visuallyHidden">
                          {endpointField.label} format
                        </span>
                        <select
                          value={endpoint.format}
                          onChange={(event) =>
                            updateEndpoint(endpointField.key, {
                              format: event.target
                                .value as AIImageEndpointConfig["format"],
                            })
                          }
                        >
                          <option value="json">JSON</option>
                          <option value="form">FormData</option>
                          <option value="gemini">Gemini JSON</option>
                        </select>
                      </label>
                    </div>
                  );
                })}
              </div>

              <details className="AISettings__advanced">
                <summary>
                  <span>Advanced field mapping</span>
                  {fieldMappingCount > 0 && (
                    <span className="AISettings__summaryBadge">
                      {fieldMappingCount}
                    </span>
                  )}
                </summary>
                <div className="AISettings__fieldMappingGrid">
                  {FIELD_MAPPING_FORM_FIELDS.map((field) => (
                    <label className="AISettings__field" key={field.key}>
                      <span>{field.label}</span>
                      <input
                        value={draft.fieldMapping?.[field.key] || ""}
                        placeholder={field.placeholder}
                        onChange={(event) =>
                          updateFieldMapping(field.key, event.target.value)
                        }
                      />
                    </label>
                  ))}
                </div>
              </details>
            </div>
          )}

          <div className="AISettings__formSection AISettings__formSection--wide">
            <div className="AISettings__sectionHeader">
              <h4>Capabilities</h4>
            </div>

            <details className="AISettings__advanced AISettings__capabilitiesDetails">
              <summary>
                <span>Enabled capabilities</span>
                <span className="AISettings__summaryBadge">
                  {capabilityCount}
                </span>
              </summary>

              <div className="AISettings__capabilities">
                {MODEL_CAPABILITY_OPTIONS[draft.mediaType].map((option) => (
                  <label key={option.value}>
                    <input
                      type="checkbox"
                      checked={draft.capabilities.includes(option.value)}
                      onChange={() =>
                        updateDraft({
                          capabilities: toggleCapability(draft, option.value),
                        })
                      }
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            </details>
          </div>
        </div>

        <div className="AISettings__editorActions">
          {editorState.mode === "edit" && (
            <button
              className="AISettings__dangerButton"
              type="button"
              onClick={() => removeModelGroup(editorState.indexes)}
            >
              Remove
            </button>
          )}

          <Button className="AISettings__saveButton" onSelect={submitDraft}>
            {editorState.mode === "edit" ? "Save model" : "Create model"}
          </Button>
        </div>
      </>
    );
  };

  const renderAgentSettings = () => {
    if (agentEditorState.mode !== "list") {
      return renderAgentEditor();
    }

    if (customAgentEditorState.mode !== "list") {
      return renderCustomAgentEditor();
    }

    if (skillEditorState.mode !== "list") {
      return renderSkillEditor();
    }

    return renderAgentsList();
  };

  return (
    <div className="AISettings">
      <div
        className="AISettings__tabs AISettings__tabs--top"
        role="tablist"
        aria-label="AI settings"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeSettingsTab === "models"}
          className={
            activeSettingsTab === "models"
              ? "AISettings__tab is-selected"
              : "AISettings__tab"
          }
          onClick={() => setActiveSettingsTab("models")}
        >
          Models
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeSettingsTab === "agents"}
          className={
            activeSettingsTab === "agents"
              ? "AISettings__tab is-selected"
              : "AISettings__tab"
          }
          onClick={() => setActiveSettingsTab("agents")}
        >
          AI Agent
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeSettingsTab === "templates"}
          className={
            activeSettingsTab === "templates"
              ? "AISettings__tab is-selected"
              : "AISettings__tab"
          }
          onClick={() => setActiveSettingsTab("templates")}
        >
          Prompt Templates
        </button>
      </div>

      {activeSettingsTab === "models" &&
        (editorState.mode === "list" ? renderList() : renderEditor())}
      {activeSettingsTab === "agents" && renderAgentSettings()}
      {activeSettingsTab === "templates" &&
        (templateEditorState.mode === "list"
          ? renderTemplatesList()
          : renderTemplateEditor())}

      {(statusMessage || errorMessage) && (
        <div
          className={
            errorMessage
              ? "AISettings__message is-error"
              : "AISettings__message"
          }
        >
          {errorMessage || statusMessage}
        </div>
      )}
    </div>
  );
};

const formatTemplateModes = (modes: readonly AIImageGenerationMode[]) => {
  const labels: Record<AIImageGenerationMode, string> = {
    "text-to-image": "Text",
    "image-to-image": "Reference",
    inpaint: "Inpaint",
  };

  return modes.map((mode) => labels[mode]).join(", ");
};

const formatModelGroupNames = (models: readonly AIImageModel[]) => {
  const modelNames = models.map((model) => model.model);
  const visibleNames = modelNames.slice(0, 3).join(", ");
  const remainingCount = modelNames.length - 3;

  return remainingCount > 0
    ? `${visibleNames}, +${remainingCount}`
    : visibleNames;
};
