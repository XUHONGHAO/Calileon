import { useCallback, useMemo, useRef, useState } from "react";
import { Button } from "@excalidraw/excalidraw/components/Button";
import { t } from "@excalidraw/excalidraw/i18n";

import {
  createAIAgentId,
  createSkillId,
  deleteAIAgent,
  deleteSkill,
  loadAIAgentConfig,
  saveAIAgentConfig,
  setDefaultAIAgent,
  upsertAIAgent,
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

const ENDPOINT_FORM_FIELDS: Array<{
  key: keyof AIImageEndpoints;
  labelKey: Parameters<typeof t>[0];
  placeholder: string;
}> = [
  {
    key: "textToImage",
    labelKey: "ai.settings.endpointFields.textToImage",
    placeholder: "/images/generations",
  },
  {
    key: "imageToImage",
    labelKey: "ai.settings.endpointFields.imageToImage",
    placeholder: "/images/edits",
  },
  {
    key: "inpaint",
    labelKey: "ai.settings.endpointFields.inpaint",
    placeholder: "/images/edits",
  },
];

const FIELD_MAPPING_FORM_FIELDS: Array<{
  key: keyof AIImageFieldMapping;
  labelKey: Parameters<typeof t>[0];
  placeholder: string;
}> = [
  {
    key: "prompt",
    labelKey: "ai.settings.fieldMapping.prompt",
    placeholder: "prompt",
  },
  {
    key: "negativePrompt",
    labelKey: "ai.settings.fieldMapping.negativePrompt",
    placeholder: "negative_prompt",
  },
  {
    key: "model",
    labelKey: "ai.settings.fieldMapping.model",
    placeholder: "model",
  },
  {
    key: "image",
    labelKey: "ai.settings.fieldMapping.image",
    placeholder: "image",
  },
  {
    key: "mask",
    labelKey: "ai.settings.fieldMapping.mask",
    placeholder: "mask",
  },
  {
    key: "size",
    labelKey: "ai.settings.fieldMapping.size",
    placeholder: "size",
  },
  { key: "n", labelKey: "ai.settings.fieldMapping.n", placeholder: "n" },
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
type AgentSettingsSubTab = "base" | "skills";

type AgentEditorState =
  | { mode: "list" }
  | { mode: "create"; draft: AIAgent }
  | { mode: "edit"; draft: AIAgent };

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
  labelKey: Parameters<typeof t>[0];
}> = [
  { value: "text-to-image", labelKey: "ai.settings.options.textToImage" },
  { value: "image-to-image", labelKey: "ai.settings.options.imageToImage" },
  { value: "inpaint", labelKey: "ai.settings.options.inpaint" },
];

const TEMPLATE_CATEGORY_OPTIONS: Array<{
  value: PromptTemplateCategory;
  labelKey: Parameters<typeof t>[0];
}> = [
  { value: "composition", labelKey: "ai.settings.options.composition" },
  { value: "style", labelKey: "ai.settings.options.style" },
  { value: "editing", labelKey: "ai.settings.options.editing" },
  { value: "custom", labelKey: "ai.settings.options.custom" },
];

const TEMPLATE_LANGUAGE_OPTIONS: Array<{
  value: PromptTemplateLanguage;
  labelKey: Parameters<typeof t>[0];
}> = [
  { value: "en", labelKey: "ai.common.english" },
  { value: "zh", labelKey: "ai.common.chinese" },
  { value: "multi", labelKey: "ai.common.multilingual" },
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

const createSkillDraft = (): SkillDraft => ({
  id: createSkillId(),
  name: "",
  icon: "AI",
  description: "",
  triggers: "",
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
  const [skillEditorState, setSkillEditorState] = useState<SkillEditorState>({
    mode: "list",
  });
  const [customTemplates, setCustomTemplates] = useState<PromptTemplate[]>(
    loadCustomPromptTemplates,
  );
  const [setAsDefault, setSetAsDefault] = useState(false);
  const [setAgentAsDefault, setSetAgentAsDefault] = useState(false);
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
        setErrorMessage(
          error.message || t("ai.settings.messages.couldNotSaveSettings"),
        );
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
        setErrorMessage(
          error.message || t("ai.settings.messages.couldNotSaveAgents"),
        );
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
    setStatusMessage(
      t("ai.settings.messages.defaultsApplied", { name: preset.name }),
    );
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
        t("ai.settings.messages.modelsRemoved"),
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
        t("ai.settings.messages.modelDefault", {
          name: defaultModel.siteName,
        }),
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
      setErrorMessage(t("ai.settings.messages.siteNameRequired"));
      setStatusMessage("");
      return;
    }

    if (!editorState.draft.baseURL.trim()) {
      setErrorMessage(t("ai.settings.messages.baseURLRequired"));
      setStatusMessage("");
      return;
    }

    if (!savedModels.length || !draft) {
      setErrorMessage(t("ai.settings.messages.modelIdsRequired"));
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
      editorState.mode === "edit"
        ? t("ai.settings.messages.modelsSaved")
        : t("ai.settings.messages.modelsCreated"),
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
      t("ai.settings.messages.defaultsApplied", {
        name:
          AGENT_PROVIDER_OPTIONS.find((option) => option.value === provider)
            ?.label || provider,
      }),
    );
    setErrorMessage("");
  }, []);

  const submitAgentDraft = useCallback(() => {
    if (agentEditorState.mode === "list") {
      return;
    }

    const draft = normalizeAgentDraftForSave(agentEditorState.draft);

    if (!draft.name.trim()) {
      setErrorMessage(t("ai.settings.messages.agentNameRequired"));
      setStatusMessage("");
      return;
    }

    if (!draft.baseURL.trim()) {
      setErrorMessage(t("ai.settings.messages.baseURLRequired"));
      setStatusMessage("");
      return;
    }

    if (!draft.model.trim()) {
      setErrorMessage(t("ai.settings.messages.modelRequired"));
      setStatusMessage("");
      return;
    }

    const savedConfig = persistAgentConfig(
      upsertAIAgent(agentConfig, draft, setAgentAsDefault),
      agentEditorState.mode === "edit"
        ? t("ai.settings.messages.agentSaved", {
            type: getAgentTypeLabel(draft.type, t),
          })
        : t("ai.settings.messages.agentCreated", {
            type: getAgentTypeLabel(draft.type, t),
          }),
    );

    if (savedConfig) {
      setAgentEditorState({ mode: "list" });
    }
  }, [agentConfig, agentEditorState, persistAgentConfig, setAgentAsDefault]);

  const removeAgent = useCallback(
    (agent: AIAgent) => {
      if (
        !window.confirm(
          t("ai.settings.messages.deleteAgentConfirm", {
            type: getAgentTypeLabel(agent.type, t),
            name: agent.name,
            suffix: "",
          }),
        )
      ) {
        return;
      }

      const savedConfig = persistAgentConfig(
        deleteAIAgent(agentConfig, agent),
        t("ai.settings.messages.agentDeleted", {
          type: getAgentTypeLabel(agent.type, t),
        }),
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
        t("ai.settings.messages.agentDefault", {
          name: agent.name,
          type: getAgentTypeLabel(agent.type, t).toLowerCase(),
        }),
      );
    },
    [agentConfig, persistAgentConfig],
  );

  const openCreateSkill = useCallback(() => {
    setActiveAgentSubTab("skills");
    setSkillEditorState({
      mode: "create",
      draft: createSkillDraft(),
    });
    setStatusMessage("");
    setErrorMessage("");
  }, []);

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
      setErrorMessage(t("ai.settings.messages.skillNameRequired"));
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
      setErrorMessage(t("ai.settings.messages.skillNameUnique"));
      setStatusMessage("");
      return;
    }

    if (!draft.description) {
      setErrorMessage(t("ai.settings.messages.skillDescriptionRequired"));
      setStatusMessage("");
      return;
    }

    const savedConfig = persistAgentConfig(
      upsertSkill(agentConfig, draft),
      skillEditorState.mode === "edit"
        ? t("ai.settings.messages.skillSaved")
        : t("ai.settings.messages.skillCreated"),
    );

    if (savedConfig) {
      setSkillEditorState({ mode: "list" });
    }
  }, [agentConfig, persistAgentConfig, skillEditorState]);

  const removeSkill = useCallback(
    (skill: AISkill) => {
      if (
        !window.confirm(
          t("ai.settings.messages.deleteSkillConfirm", { name: skill.name }),
        )
      ) {
        return;
      }

      const savedConfig = persistAgentConfig(
        deleteSkill(agentConfig, skill),
        t("ai.settings.messages.skillDeleted"),
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
      setErrorMessage(t("ai.settings.messages.templateLabelRequired"));
      setStatusMessage("");
      return;
    }

    if (!draft.template.trim()) {
      setErrorMessage(t("ai.settings.messages.templateContentRequired"));
      setStatusMessage("");
      return;
    }

    if (!draft.modes.length) {
      setErrorMessage(t("ai.settings.messages.templateModeRequired"));
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
        ? t("ai.settings.messages.templateSaved")
        : t("ai.settings.messages.templateCreated"),
    );
    setErrorMessage("");
  }, [templateEditorState]);

  const removeTemplate = useCallback((template: PromptTemplate) => {
    if (
      template.isBuiltIn ||
      !window.confirm(
        t("ai.settings.messages.deleteTemplateConfirm", {
          label: template.label,
        }),
      )
    ) {
      return;
    }

    deleteCustomPromptTemplate(template.id);
    setCustomTemplates(loadCustomPromptTemplates());
    setStatusMessage(t("ai.settings.messages.templateDeleted"));
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
      setStatusMessage(
        t("ai.settings.messages.templatesImportedCount", {
          count: importedTemplates.length,
        }),
      );
      setErrorMessage("");
    } catch (error: any) {
      setErrorMessage(
        error?.message || t("ai.settings.messages.templateImportFailed"),
      );
      setStatusMessage("");
    }
  }, []);

  const renderList = () => (
    <>
      <div className="AISettings__toolbar">
        <span>{t("ai.settings.modelList.title")}</span>
        <span className="AISettings__toolbarActions">
          <button type="button" onClick={openCreateModel}>
            {t("ai.settings.modelList.addModel")}
          </button>
        </span>
      </div>

      <div
        className="AISettings__tabs"
        role="tablist"
        aria-label={t("ai.settings.modelList.ariaLabel")}
      >
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
            {getMediaTypeLabel(mediaType, t)}
          </button>
        ))}
      </div>

      <div className="AISettings__models">
        {visibleModelGroups.length === 0 && (
          <div className="AISettings__emptyState">
            <span>
              {t("ai.settings.modelList.empty", {
                mediaType: getMediaTypeInlineLabel(activeMediaType, t),
              })}
            </span>
            <button
              type="button"
              className="AISettings__textButton"
              onClick={openCreateModel}
            >
              {t("ai.settings.modelList.addMediaModel", {
                mediaType: getMediaTypeInlineLabel(activeMediaType, t),
              })}
            </button>
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
                  <span>{getMediaTypeLabel(group.model.mediaType, t)}</span>
                  {group.models.length > 1 && (
                    <span>
                      {t("ai.settings.modelList.modelCount", {
                        count: group.models.length,
                      })}
                    </span>
                  )}
                  {isDefault && <span>{t("ai.common.default")}</span>}
                </span>
              </div>

              <div className="AISettings__agentMeta">
                <span>
                  {t("ai.settings.modelList.modelsPrefix")}{" "}
                  {formatModelGroupNames(group.models)}
                </span>
                <span>
                  {t("ai.settings.modelList.baseURLPrefix")}{" "}
                  {group.model.baseURL}
                </span>
                {group.model.mediaType === "image" && (
                  <span>
                    {t("ai.settings.modelList.nativeModelPrefix")}{" "}
                    {group.model.nativeModel || DEFAULT_AI_IMAGE_NATIVE_MODEL}
                  </span>
                )}
              </div>

              <div className="AISettings__agentActions">
                <button type="button" onClick={() => openEditModelGroup(group)}>
                  {t("ai.common.edit")}
                </button>
                <button
                  type="button"
                  onClick={() => removeModelGroup(group.indexes)}
                >
                  {t("ai.common.delete")}
                </button>
                <button
                  type="button"
                  disabled={isDefault}
                  onClick={() => makeDefaultModelGroup(group)}
                >
                  {t("ai.settings.modelList.setAsDefault")}
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
      aria-label={t("ai.settings.agents.sectionsAriaLabel")}
    >
      {[
        { id: "base", label: t("ai.settings.agents.base") },
        { id: "skills", label: t("ai.settings.agents.skills") },
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
        <span>{t("ai.settings.agents.baseConfiguration")}</span>
        <span className="AISettings__toolbarActions">
          <button type="button" onClick={() => openCreateAgent("text")}>
            {t("ai.settings.agents.addTextAgent")}
          </button>
          <button type="button" onClick={() => openCreateAgent("vision")}>
            {t("ai.settings.agents.addVisionAgent")}
          </button>
          <button type="button" onClick={() => openCreateAgent("llm")}>
            {t("ai.settings.agents.addLLMAgent")}
          </button>
        </span>
      </div>

      <div className="AISettings__agentIntro">
        {t("ai.settings.agents.baseDescription")}
      </div>

      <div className="AISettings__agentSections">
        {renderAgentSection(
          t("ai.settings.agents.textAgents"),
          t("ai.settings.agents.textAgentsSubtitle"),
          agentConfig.textAgents,
          agentConfig.defaultTextAgentId,
          "text",
        )}
        {renderAgentSection(
          t("ai.settings.agents.visionAgents"),
          t("ai.settings.agents.visionAgentsSubtitle"),
          agentConfig.visionAgents,
          agentConfig.defaultVisionAgentId,
          "vision",
        )}
        {renderAgentSection(
          t("ai.settings.agents.llmAgents"),
          t("ai.settings.agents.llmAgentsSubtitle"),
          agentConfig.llmAgents,
          agentConfig.defaultLLMAgentId,
          "llm",
        )}
      </div>
    </>
  );

  const renderSkillsList = () => (
    <>
      <div className="AISettings__toolbar">
        <span>{t("ai.settings.agents.skillsTitle")}</span>
        <span className="AISettings__toolbarActions">
          <button type="button" onClick={openCreateSkill}>
            {t("ai.settings.agents.addSkill")}
          </button>
        </span>
      </div>

      <div className="AISettings__agentIntro">
        {t("ai.settings.agents.skillsDescription", {
          placeholder: "{user_input}",
        })}
      </div>

      <div className="AISettings__agentSections AISettings__agentSections--single">
        <div className="AISettings__agentSection">
          {agentConfig.skills.length === 0 && (
            <div className="AISettings__emptyState">
              {t("ai.settings.agents.emptySkills")}
            </div>
          )}

          <div className="AISettings__agentList">
            {agentConfig.skills.map((skill) => {
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
                      {t("ai.settings.agents.triggerPrefix")}{" "}
                      {skill.triggers?.join(", ") ||
                        t("ai.settings.agents.notConfigured")}
                    </span>
                  </div>
                  <div className="AISettings__agentActions">
                    <button type="button" onClick={() => openEditSkill(skill)}>
                      {t("ai.common.edit")}
                    </button>
                    <button type="button" onClick={() => removeSkill(skill)}>
                      {t("ai.common.delete")}
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
          {t("ai.settings.agentEditor.heading", {
            mode: `${t("ai.common.add")} ${getAgentTypeLabel(type, t)}`,
          })}
        </button>
      </div>

      {agents.length === 0 && (
        <div className="AISettings__emptyState">
          {t("ai.settings.agents.emptyBaseAgent", {
            type: getAgentTypeLabel(type, t).toLowerCase(),
            target: getAgentTargetLabel(type, t),
          })}
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
                  {isDefault && <span>{t("ai.common.default")}</span>}
                </span>
              </div>
              <div className="AISettings__agentMeta">
                <span>
                  {t("ai.settings.agents.modelPrefix")} {agent.model}
                </span>
                <span>
                  {t("ai.settings.modelList.baseURLPrefix")} {agent.baseURL}
                </span>
              </div>
              <div className="AISettings__agentActions">
                <button type="button" onClick={() => openEditAgent(agent)}>
                  {t("ai.common.edit")}
                </button>
                <button type="button" onClick={() => removeAgent(agent)}>
                  {t("ai.common.delete")}
                </button>
                <button
                  type="button"
                  disabled={isDefault}
                  onClick={() => makeDefaultAgent(agent)}
                >
                  {t("ai.settings.modelList.setAsDefault")}
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
            {t("ai.common.back")}
          </button>
          <h3>
            {t("ai.settings.agentEditor.heading", {
              mode: `${
                agentEditorState.mode === "edit"
                  ? t("ai.common.edit")
                  : t("ai.common.add")
              } ${getAgentTypeLabel(draft.type, t)}`,
            })}
          </h3>
        </div>

        <div className="AISettings__providerPresets">
          <span className="AISettings__providerPresetsLabel">
            {t("ai.settings.agentEditor.defaultConfigs")}
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
                    ? preset.recommendedTextModel ||
                      t("ai.settings.agentEditor.customModel")
                    : draft.type === "vision"
                    ? preset.recommendedVisionModel ||
                      t("ai.settings.agentEditor.customModel")
                    : preset.recommendedTextModel ||
                      t("ai.settings.agentEditor.customModel")}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="AISettings__editorBody AISettings__editorBody--single">
          <div className="AISettings__formSection AISettings__formSection--wide">
            <div className="AISettings__modelGrid">
              <label className="AISettings__field">
                <span>{t("ai.settings.agentEditor.agentName")}</span>
                <input
                  value={draft.name}
                  placeholder={t(
                    "ai.settings.agentEditor.agentNamePlaceholder",
                  )}
                  onChange={(event) =>
                    updateAgentDraft({ name: event.target.value })
                  }
                />
                <span className="AISettings__fieldHint">
                  {t("ai.settings.agentEditor.agentNameHint")}
                </span>
              </label>

              <label className="AISettings__field">
                <span>{t("ai.settings.agentEditor.provider")}</span>
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
                <span>{t("ai.settings.agentEditor.baseURL")}</span>
                <input
                  value={draft.baseURL}
                  placeholder="https://api.example.com/v1"
                  onChange={(event) =>
                    updateAgentDraft({ baseURL: event.target.value })
                  }
                />
              </label>

              <label className="AISettings__field">
                <span>{t("ai.settings.agentEditor.apiKey")}</span>
                <input
                  value={draft.apiKey}
                  type="password"
                  autoComplete="off"
                  onChange={(event) =>
                    updateAgentDraft({ apiKey: event.target.value })
                  }
                />
                <span className="AISettings__fieldHint">
                  {t("ai.settings.agentEditor.plainTextStorage")}
                </span>
              </label>

              <label className="AISettings__field">
                <span>{t("ai.settings.agentEditor.model")}</span>
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
                <span>
                  {t("ai.settings.agentEditor.defaultAgent", {
                    type: getAgentTypeLabel(draft.type, t),
                  })}
                </span>
              </label>
            </div>

            <label className="AISettings__field">
              <span>{t("ai.settings.agentEditor.systemPromptOptional")}</span>
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
                {t("ai.settings.agentEditor.systemPromptHint")}
              </span>
            </label>

            <div className="AISettings__agentRecommendations">
              <strong>
                {t("ai.settings.agentEditor.recommendedFor", {
                  type: getAgentTargetShortLabel(draft.type, t),
                })}
              </strong>
              {getAgentRecommendations(draft.type, t).map((item) => (
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
              {t("ai.common.remove")}
            </button>
          )}

          <Button
            className="AISettings__saveButton"
            onSelect={submitAgentDraft}
          >
            {agentEditorState.mode === "edit"
              ? t("ai.settings.agentEditor.saveAgent")
              : t("ai.settings.agentEditor.createAgent")}
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
      <span>{t("ai.settings.common.icon")}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {ICON_OPTIONS.map((icon) => (
          <option key={icon} value={icon}>
            {icon}
          </option>
        ))}
      </select>
    </label>
  );

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
            {t("ai.common.back")}
          </button>
          <h3>
            {t("ai.settings.skillEditor.heading", {
              mode:
                skillEditorState.mode === "edit"
                  ? t("ai.common.edit")
                  : t("ai.common.create"),
            })}
          </h3>
        </div>

        <div className="AISettings__editorBody AISettings__editorBody--single">
          <div className="AISettings__formSection AISettings__formSection--wide">
            <div className="AISettings__modelGrid">
              <label className="AISettings__field">
                <span>{t("ai.settings.skillEditor.skillName")}</span>
                <input
                  value={draft.name}
                  placeholder={t(
                    "ai.settings.skillEditor.skillNamePlaceholder",
                  )}
                  onChange={(event) =>
                    updateSkillDraft({ name: event.target.value })
                  }
                />
              </label>

              {renderIconSelect(draft.icon, (icon) =>
                updateSkillDraft({ icon }),
              )}

              <label className="AISettings__field">
                <span>{t("ai.settings.skillEditor.description")}</span>
                <input
                  value={draft.description}
                  placeholder={t(
                    "ai.settings.skillEditor.descriptionPlaceholder",
                  )}
                  onChange={(event) =>
                    updateSkillDraft({ description: event.target.value })
                  }
                />
              </label>

              <label className="AISettings__field">
                <span>{t("ai.settings.skillEditor.triggers")}</span>
                <input
                  value={draft.triggers}
                  placeholder={t("ai.settings.skillEditor.triggersPlaceholder")}
                  onChange={(event) =>
                    updateSkillDraft({ triggers: event.target.value })
                  }
                />
                <span className="AISettings__fieldHint">
                  {t("ai.settings.skillEditor.triggersHint")}
                </span>
              </label>
            </div>

            <label className="AISettings__field">
              <span>{t("ai.settings.skillEditor.initialPrompt")}</span>
              <textarea
                value={draft.initialPrompt || ""}
                rows={7}
                placeholder={t(
                  "ai.settings.skillEditor.initialPromptPlaceholder",
                )}
                onChange={(event) =>
                  updateSkillDraft({ initialPrompt: event.target.value })
                }
              />
              <span className="AISettings__fieldHint">
                {t("ai.settings.skillEditor.initialPromptHint", {
                  placeholder: "{user_input}",
                })}
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
              {t("ai.common.remove")}
            </button>
          )}

          <Button
            className="AISettings__saveButton"
            onSelect={submitSkillDraft}
          >
            {skillEditorState.mode === "edit"
              ? t("ai.settings.skillEditor.saveSkill")
              : t("ai.settings.skillEditor.createSkill")}
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
          <span>{t("ai.settings.templates.title")}</span>
          <span className="AISettings__toolbarActions">
            <button
              type="button"
              onClick={() => templateImportInputRef.current?.click()}
            >
              {t("ai.settings.templates.import")}
            </button>
            <button
              type="button"
              disabled={!customTemplates.length}
              onClick={exportTemplates}
            >
              {t("ai.settings.templates.export")}
            </button>
            <button type="button" onClick={openCreateTemplate}>
              {t("ai.settings.templates.addTemplate")}
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
          {renderTemplateSection(
            t("ai.settings.templates.builtIn"),
            builtInTemplates,
            false,
          )}
          {renderTemplateSection(
            t("ai.settings.templates.custom"),
            savedCustomTemplates,
            true,
          )}
        </div>
      </>
    );
  };

  const renderTemplateSection = (
    title: string,
    templates: PromptTemplate[],
    isCustomSection: boolean,
  ) => (
    <div className="AISettings__templateSection">
      <div className="AISettings__sectionHeader">
        <h4>{title}</h4>
        <span className="AISettings__summaryBadge">{templates.length}</span>
      </div>
      {templates.length === 0 && (
        <div className="AISettings__emptyState">
          <span>{t("ai.settings.templates.empty")}</span>
          {isCustomSection && (
            <button
              type="button"
              className="AISettings__textButton"
              onClick={openCreateTemplate}
            >
              {t("ai.settings.templates.addCustomTemplate")}
            </button>
          )}
        </div>
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
                    {t("ai.common.edit")}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeTemplate(template)}
                  >
                    {t("ai.common.delete")}
                  </button>
                </span>
              )}
            </div>
            <div className="AISettings__templateMeta">
              <span>{formatTemplateModes(template.modes, t)}</span>
              <span>
                {getPromptTemplateCategoryLabel(template.category, t)}
              </span>
              <span>
                {getPromptTemplateLanguageLabel(template.language, t)}
              </span>
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
            {t("ai.common.back")}
          </button>
          <h3>
            {templateEditorState.mode === "edit"
              ? t("ai.settings.templates.editTemplate")
              : t("ai.settings.templates.newTemplate")}
          </h3>
        </div>

        <div className="AISettings__editorBody AISettings__editorBody--single">
          <div className="AISettings__formSection AISettings__formSection--wide">
            <label className="AISettings__field">
              <span>{t("ai.settings.templates.label")}</span>
              <input
                value={draft.label}
                onChange={(event) =>
                  updateTemplateDraft({ label: event.target.value })
                }
              />
            </label>

            <label className="AISettings__field">
              <span>{t("ai.settings.templates.content")}</span>
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
                  <span>{t(option.labelKey)}</span>
                </label>
              ))}
            </div>

            <div className="AISettings__modelGrid">
              <label className="AISettings__field">
                <span>{t("ai.settings.templates.category")}</span>
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
                      {t(option.labelKey)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="AISettings__field">
                <span>{t("ai.settings.templates.language")}</span>
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
                      {t(option.labelKey)}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="AISettings__fieldHint">
              {t("ai.settings.templates.placeholderHint")}
            </div>
          </div>
        </div>

        <div className="AISettings__editorActions">
          <Button
            className="AISettings__saveButton"
            onSelect={submitTemplateDraft}
          >
            {templateEditorState.mode === "edit"
              ? t("ai.settings.templates.saveTemplate")
              : t("ai.settings.templates.createTemplate")}
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
            {t("ai.common.back")}
          </button>
          <h3>
            {editorState.mode === "edit"
              ? t("ai.settings.modelEditor.editModel")
              : t("ai.settings.modelEditor.newModel")}
          </h3>
        </div>

        <div className="AISettings__providerPresets">
          <span className="AISettings__providerPresetsLabel">
            {t("ai.settings.modelEditor.quickPresets")}
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
              <h4>{t("ai.settings.modelEditor.connection")}</h4>
            </div>

            <div className="AISettings__connectionGrid">
              <label className="AISettings__field">
                <span>{t("ai.settings.modelEditor.siteName")}</span>
                <input
                  value={draft.siteName}
                  onChange={(event) =>
                    updateDraft({ siteName: event.target.value })
                  }
                />
              </label>

              <label className="AISettings__field">
                <span>{t("ai.settings.modelEditor.baseURL")}</span>
                <input
                  value={draft.baseURL}
                  onChange={(event) =>
                    updateDraft({ baseURL: event.target.value })
                  }
                  placeholder="https://api.example.com/v1"
                />
              </label>

              <label className="AISettings__field">
                <span>{t("ai.settings.modelEditor.apiKey")}</span>
                <input
                  value={draft.apiKey}
                  type="password"
                  autoComplete="off"
                  onChange={(event) =>
                    updateDraft({ apiKey: event.target.value })
                  }
                />
                <span className="AISettings__fieldHint">
                  {t("ai.settings.modelEditor.plainTextStorage")}
                </span>
              </label>
            </div>
          </div>

          <div className="AISettings__formSection">
            <div className="AISettings__sectionHeader">
              <h4>{t("ai.settings.modelEditor.model")}</h4>
              <label className="AISettings__defaultField">
                <input
                  type="checkbox"
                  checked={setAsDefault}
                  onChange={(event) => setSetAsDefault(event.target.checked)}
                />
                <span>{t("ai.settings.modelEditor.defaultModel")}</span>
              </label>
            </div>

            <div className="AISettings__modelGrid">
              <label className="AISettings__field AISettings__modelIdsField">
                <span>{t("ai.settings.modelEditor.modelIds")}</span>
                <textarea
                  value={draft.model}
                  rows={4}
                  onChange={(event) =>
                    updateDraft({ model: event.target.value })
                  }
                />
                <span className="AISettings__fieldHint">
                  {t("ai.settings.modelEditor.modelIdsHint")}
                </span>
              </label>

              {draft.mediaType === "image" && (
                <label className="AISettings__field AISettings__modelRightField1">
                  <span>{t("ai.settings.modelEditor.nativeModel")}</span>
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
                <span>{t("ai.settings.modelEditor.type")}</span>
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
                      {getMediaTypeLabel(mediaType, t)}
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
                <span>{t("ai.settings.modelEditor.timeoutSeconds")}</span>
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
                <h4>{t("ai.settings.modelEditor.apiConfiguration")}</h4>
              </div>

              <label className="AISettings__field AISettings__presetField">
                <span>{t("ai.settings.modelEditor.endpointPreset")}</span>
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

              <details className="AISettings__advanced">
                <summary>
                  {t("ai.settings.modelEditor.advancedEndpoints")}
                </summary>
                <div className="AISettings__endpointMatrix">
                  <div
                    className="AISettings__endpointHeader"
                    aria-hidden="true"
                  >
                    <span>{t("ai.common.mode")}</span>
                    <span>{t("ai.settings.modelEditor.path")}</span>
                    <span>{t("ai.settings.modelEditor.format")}</span>
                  </div>

                  {ENDPOINT_FORM_FIELDS.map((endpointField) => {
                    const endpoint = draft.endpoints[endpointField.key];
                    const endpointLabel = t(endpointField.labelKey);

                    return (
                      <div
                        className="AISettings__endpointRow"
                        key={endpointField.key}
                      >
                        <span className="AISettings__endpointLabel">
                          {endpointLabel}
                        </span>
                        <label className="AISettings__field">
                          <span className="AISettings__visuallyHidden">
                            {t("ai.settings.modelEditor.endpointPathLabel", {
                              label: endpointLabel,
                            })}
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
                            {t("ai.settings.modelEditor.endpointFormatLabel", {
                              label: endpointLabel,
                            })}
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
              </details>

              <details className="AISettings__advanced">
                <summary>
                  <span>
                    {t("ai.settings.modelEditor.advancedFieldMapping")}
                  </span>
                  {fieldMappingCount > 0 && (
                    <span className="AISettings__summaryBadge">
                      {fieldMappingCount}
                    </span>
                  )}
                </summary>
                <div className="AISettings__fieldMappingGrid">
                  {FIELD_MAPPING_FORM_FIELDS.map((field) => (
                    <label className="AISettings__field" key={field.key}>
                      <span>{t(field.labelKey)}</span>
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
              <h4>{t("ai.settings.modelEditor.capabilities")}</h4>
            </div>

            <details className="AISettings__advanced AISettings__capabilitiesDetails">
              <summary>
                <span>{t("ai.settings.modelEditor.enabledCapabilities")}</span>
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
              {t("ai.common.remove")}
            </button>
          )}

          <Button className="AISettings__saveButton" onSelect={submitDraft}>
            {editorState.mode === "edit"
              ? t("ai.settings.modelEditor.saveModel")
              : t("ai.settings.modelEditor.createModel")}
          </Button>
        </div>
      </>
    );
  };

  const renderAgentSettings = () => {
    if (agentEditorState.mode !== "list") {
      return renderAgentEditor();
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
        aria-label={t("ai.common.settings")}
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
          {t("ai.settings.tabs.models")}
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
          {t("ai.settings.tabs.agents")}
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
          {t("ai.settings.tabs.templates")}
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

type AISettingsT = typeof t;

const getMediaTypeLabel = (mediaType: AIModelMediaType, t: AISettingsT) => {
  if (mediaType === "video") {
    return t("ai.common.video");
  }

  if (mediaType === "audio") {
    return t("ai.common.audio");
  }

  return t("ai.common.image");
};

const getMediaTypeInlineLabel = (
  mediaType: AIModelMediaType,
  t: AISettingsT,
) => {
  const label = getMediaTypeLabel(mediaType, t);

  return /^[A-Z][A-Za-z]+$/.test(label) ? label.toLowerCase() : label;
};

const getAgentTypeLabel = (type: AIAgentType, t: AISettingsT) => {
  if (type === "vision") {
    return t("ai.settings.agentTypes.vision");
  }

  if (type === "llm") {
    return t("ai.settings.agentTypes.llm");
  }

  return t("ai.settings.agentTypes.text");
};

const getAgentTargetLabel = (type: AIAgentType, t: AISettingsT) => {
  if (type === "vision") {
    return t("ai.settings.agentTargets.vision");
  }

  if (type === "llm") {
    return t("ai.settings.agentTargets.llm");
  }

  return t("ai.settings.agentTargets.text");
};

const getAgentTargetShortLabel = (type: AIAgentType, t: AISettingsT) => {
  if (type === "vision") {
    return t("ai.settings.agentTargetsShort.vision");
  }

  if (type === "llm") {
    return t("ai.settings.agentTargetsShort.llm");
  }

  return t("ai.settings.agentTargetsShort.text");
};

const getAgentRecommendations = (type: AIAgentType, t: AISettingsT) => {
  if (type === "vision") {
    return [
      t("ai.settings.agentRecommendations.vision.openai"),
      t("ai.settings.agentRecommendations.vision.claude"),
      t("ai.settings.agentRecommendations.vision.gemini"),
    ];
  }

  if (type === "llm") {
    return [
      t("ai.settings.agentRecommendations.llm.openai"),
      t("ai.settings.agentRecommendations.llm.claude"),
      t("ai.settings.agentRecommendations.llm.compatible"),
    ];
  }

  return [
    t("ai.settings.agentRecommendations.text.openai"),
    t("ai.settings.agentRecommendations.text.claude"),
    t("ai.settings.agentRecommendations.text.gemini"),
  ];
};

const formatTemplateModes = (
  modes: readonly AIImageGenerationMode[],
  t: AISettingsT,
) => {
  const labels = new Map(
    TEMPLATE_MODE_OPTIONS.map((option) => [option.value, t(option.labelKey)]),
  );

  return modes.map((mode) => labels.get(mode) || mode).join(", ");
};

const getPromptTemplateCategoryLabel = (
  category: PromptTemplateCategory | undefined,
  t: AISettingsT,
) => {
  const option =
    TEMPLATE_CATEGORY_OPTIONS.find((item) => item.value === category) ||
    TEMPLATE_CATEGORY_OPTIONS.find((item) => item.value === "custom");

  return option ? t(option.labelKey) : t("ai.common.custom");
};

const getPromptTemplateLanguageLabel = (
  language: PromptTemplateLanguage | undefined,
  t: AISettingsT,
) => {
  const option =
    TEMPLATE_LANGUAGE_OPTIONS.find((item) => item.value === language) ||
    TEMPLATE_LANGUAGE_OPTIONS.find((item) => item.value === "multi");

  return option ? t(option.labelKey) : t("ai.common.multilingual");
};

const formatModelGroupNames = (models: readonly AIImageModel[]) => {
  const modelNames = models.map((model) => model.model);
  const visibleNames = modelNames.slice(0, 3).join(", ");
  const remainingCount = modelNames.length - 3;

  return remainingCount > 0
    ? `${visibleNames}, +${remainingCount}`
    : visibleNames;
};
