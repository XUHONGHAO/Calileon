import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  AIProxyConfigError,
  AI_PROXY_CONFIG_UPDATED_EVENT,
  DEFAULT_AI_PROXY_CONFIG,
  getAIGatewayEndpoint,
  getRuntimeDefaultAIGatewayEndpoint,
  getRuntimeDefaultAIProxyEndpoint,
  loadAIProxyConfig,
  resetAIProxyConfig,
  saveAIProxyConfig,
  validateAIProxyEndpoint,
} from "../ai/proxyConfig";
import {
  testAIProxyConnection,
  AIProxyTransportError,
} from "../ai/requestTransport";
import { getCloudBackend } from "../data/cloud";
import { createHttpAiGateway } from "../data/cloud/HttpAiGateway";

import "./AISettings.scss";

import {
  ActionMenu,
  Badge,
  Callout,
  confirmAction,
  DialogActions,
  DialogSection,
  Field,
  getTabPanelProps,
  ListRow,
  Select,
  TabList,
  TextArea,
  TextInput,
  UiButton,
} from "./ui";

import type { AIModelProviderPreset } from "../ai/config";
import type {
  AIAgent,
  AIAgentConfig,
  AIAgentProvider,
  AIAgentType,
  AISkill,
} from "../ai/types";
import type { AIProxyConfigV2 } from "../ai/proxyConfig";
import type {
  AIImageEndpointConfig,
  AIImageEndpointMode,
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
import type { AISettingsTab } from "../ai/workflowEvents";
import type { EndpointPresetId } from "../ai/endpointPresets";
import type {
  AiGatewayCatalogEntry,
  AiGatewayAuditRecord,
  AiGatewayQuota,
  AiGatewayUsage,
  AiGateway,
} from "../data/cloud";

const MANAGED_ROUTE_CAPABILITIES = [
  "image-generation",
  "remote-image",
  "video-submit",
  "video-poll",
  "text-agent",
  "vision-agent",
] as const;

const MANAGED_ROUTE_LABELS = {
  "image-generation": "ai.proxy.managedCapabilities.imageGeneration",
  "remote-image": "ai.proxy.managedCapabilities.remoteImage",
  "video-submit": "ai.proxy.managedCapabilities.videoSubmit",
  "video-poll": "ai.proxy.managedCapabilities.videoPoll",
  "text-agent": "ai.proxy.managedCapabilities.textAgent",
  "vision-agent": "ai.proxy.managedCapabilities.visionAgent",
} as const;

/**
 * Resolve the managed gateway through the cloud adapter boundary. A custom
 * endpoint is deliberately constructed with the existing AuthProvider rather
 * than importing a platform SDK here; the default endpoint continues to use
 * the assembled adapter so deployments and tests can provide their own
 * implementation.
 */
const getManagedGateway = (config: AIProxyConfigV2): AiGateway => {
  const backend = getCloudBackend();
  const runtimeEndpoint = String(
    import.meta.env.VITE_APP_AI_GATEWAY_URL || "",
  ).trim();
  if (!config.gatewayEndpoint.trim() && !runtimeEndpoint) {
    return backend.ai;
  }
  return createHttpAiGateway({
    auth: backend.auth,
    baseURL: getAIGatewayEndpoint(config),
  });
};

const ENDPOINT_FORM_FIELDS: Array<{
  key: AIImageEndpointMode;
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

// `baseline` is a snapshot of the draft (plus the "set as default" choice)
// taken when the editor opened; it tells Back/close whether there is anything
// to lose.
type EditorState =
  | { mode: "list" }
  | { mode: "create"; draft: AIModelDraft; baseline: string }
  | {
      mode: "edit";
      draft: AIModelDraft;
      indexes: number[];
      baseline: string;
    };

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

type AgentSettingsSubTab = "base" | "skills";

type AgentEditorState =
  | { mode: "list" }
  | { mode: "create"; draft: AIAgent; baseline: string }
  | { mode: "edit"; draft: AIAgent; baseline: string };

type SkillDraft = Omit<AISkill, "triggers"> & {
  triggers: string;
};

type SkillEditorState =
  | { mode: "list" }
  | { mode: "create"; draft: SkillDraft; baseline: string }
  | { mode: "edit"; draft: SkillDraft; baseline: string };

type TemplateEditorState =
  | { mode: "list" }
  | { mode: "create"; draft: PromptTemplateDraft; baseline: string }
  | {
      mode: "edit";
      draft: PromptTemplateDraft;
      templateId: string;
      baseline: string;
    };

/**
 * Field-level validation errors, keyed `<editor>.<field>`. The matching
 * control carries `data-field="<key>"` so a failed submit can focus it.
 */
type FieldErrorKey =
  | "model.siteName"
  | "model.baseURL"
  | "model.model"
  | "agent.name"
  | "agent.baseURL"
  | "agent.model"
  | "skill.name"
  | "skill.description"
  | "template.label"
  | "template.template"
  | "template.modes"
  | "network.endpoint"
  | "network.gatewayEndpoint";
type FieldErrors = Partial<Record<FieldErrorKey, string>>;

const snapshotDraft = (draft: unknown, extra?: unknown) =>
  JSON.stringify({ draft, extra });

/** Host of a base URL, used to tell whether a saved API key belongs to it. */
const getURLHost = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return new URL(trimmed).host.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
};

/**
 * A key typed for one provider must not silently travel to another host
 * when a preset (or provider) switches the base URL.
 */
const shouldDropAPIKey = (
  previousBaseURL: string,
  nextBaseURL: string,
  apiKey: string,
) =>
  !!apiKey &&
  !!previousBaseURL.trim() &&
  getURLHost(previousBaseURL) !== getURLHost(nextBaseURL);

/** Network draft identity, ignoring whitespace and empty route choices. */
const getProxyConfigSignature = (config: AIProxyConfigV2) =>
  JSON.stringify({
    mode: config.mode,
    endpoint: config.endpoint.trim(),
    accessToken: config.accessToken,
    gatewayEndpoint: config.gatewayEndpoint.trim(),
    managedRoutes: Object.entries(config.managedRoutes || {})
      .filter(([, value]) => !!value)
      .sort(([a], [b]) => a.localeCompare(b)),
  });

/**
 * Shared "discard unsaved changes?" prompt for Back inside the settings and
 * for closing the settings dialog.
 */
export const confirmDiscardAISettingsChanges = () =>
  confirmAction(t("ai.settings.messages.discardChangesConfirm"), {
    title: t("ai.settings.messages.discardChangesTitle"),
    confirmLabel: t("ai.settings.messages.discardChanges"),
    cancelLabel: t("ai.settings.messages.keepEditing"),
    danger: true,
  });

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

  const base = currentDraft || createAgentDraft(type);
  // The generic OpenAI-compatible preset has no URL or model of its own:
  // keep what the user already entered instead of blanking it.
  const baseURL = preset?.baseURL || base.baseURL;

  return {
    ...base,
    provider,
    baseURL,
    apiKey: shouldDropAPIKey(base.baseURL, baseURL, base.apiKey)
      ? ""
      : base.apiKey,
    model: recommendedModel || base.model,
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
  apiKey:
    currentDraft &&
    shouldDropAPIKey(currentDraft.baseURL, preset.baseURL, currentDraft.apiKey)
      ? ""
      : currentDraft?.apiKey || "",
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
  onDirtyChange,
}: {
  initialTab?: AISettingsTab;
  /**
   * Reports whether any editor (model, agent, skill, template) or the network
   * form holds unsaved changes, so the host dialog can confirm before closing.
   */
  onDirtyChange?: (dirty: boolean) => void;
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
  // `proxyConfig` is the form draft, `savedProxyConfig` what is persisted.
  // Outside updates refresh the saved copy and only replace an untouched draft.
  const [proxyConfig, setProxyConfig] = useState(loadAIProxyConfig);
  const [savedProxyConfig, setSavedProxyConfig] = useState(() => proxyConfig);
  const savedProxyConfigRef = useRef(savedProxyConfig);
  savedProxyConfigRef.current = savedProxyConfig;
  const [isTestingProxy, setIsTestingProxy] = useState(false);
  const [managedAccountStatus, setManagedAccountStatus] = useState<
    "idle" | "loading" | "signed-out" | "ready" | "unavailable"
  >("idle");
  const [managedCatalog, setManagedCatalog] = useState<AiGatewayCatalogEntry[]>(
    [],
  );
  const [managedQuota, setManagedQuota] = useState<AiGatewayQuota | null>(null);
  const [managedUsage, setManagedUsage] = useState<AiGatewayUsage[]>([]);
  const [managedAuditConsent, setManagedAuditConsent] = useState(false);
  const [managedAuditAvailable, setManagedAuditAvailable] = useState(false);
  const [managedAudits, setManagedAudits] = useState<AiGatewayAuditRecord[]>(
    [],
  );
  const [managedAuditDetail, setManagedAuditDetail] =
    useState<AiGatewayAuditRecord | null>(null);
  const [deviceUserCode, setDeviceUserCode] = useState("");
  const [isApprovingDevice, setIsApprovingDevice] = useState(false);
  const [isUpdatingAuditConsent, setIsUpdatingAuditConsent] = useState(false);
  const [pendingAuditAction, setPendingAuditAction] = useState<{
    id: string;
    action: "view" | "delete";
  } | null>(null);
  const managedActionPendingRef = useRef(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [setAsDefault, setSetAsDefault] = useState(false);
  const [setAgentAsDefault, setSetAgentAsDefault] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const templateImportInputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Keyed on the *saved* endpoint only: typing in the endpoint field or
  // picking a route must not rebuild the gateway and refetch everything.
  const savedGatewayEndpoint = savedProxyConfig.gatewayEndpoint;
  const managedGateway = useMemo(() => {
    try {
      return getManagedGateway({
        ...DEFAULT_AI_PROXY_CONFIG,
        gatewayEndpoint: savedGatewayEndpoint,
      });
    } catch {
      return null;
    }
  }, [savedGatewayEndpoint]);

  useEffect(() => {
    const handleProxyConfigUpdated = () => {
      const previousSaved = savedProxyConfigRef.current;
      const nextSaved = loadAIProxyConfig();
      savedProxyConfigRef.current = nextSaved;
      setSavedProxyConfig(nextSaved);
      setProxyConfig((draft) =>
        getProxyConfigSignature(draft) ===
        getProxyConfigSignature(previousSaved)
          ? nextSaved
          : draft,
      );
    };

    window.addEventListener(
      AI_PROXY_CONFIG_UPDATED_EVENT,
      handleProxyConfigUpdated,
    );

    return () => {
      window.removeEventListener(
        AI_PROXY_CONFIG_UPDATED_EVENT,
        handleProxyConfigUpdated,
      );
    };
  }, []);

  useEffect(() => {
    if (proxyConfig.mode !== "managed-gateway") {
      setManagedAccountStatus("idle");
      setManagedCatalog([]);
      setManagedQuota(null);
      setManagedUsage([]);
      setManagedAuditAvailable(false);
      setManagedAuditConsent(false);
      setManagedAudits([]);
      setManagedAuditDetail(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      // A refresh keeps the ready view (and the focused control) mounted.
      setManagedAccountStatus((current) =>
        current === "ready" ? current : "loading",
      );
      const backend = getCloudBackend();
      const user = await backend.auth.getCurrentUser();
      if (!user) {
        if (!cancelled) {
          setManagedAccountStatus("signed-out");
        }
        return;
      }
      if (!managedGateway?.isEnabled()) {
        if (!cancelled) {
          setManagedAccountStatus("unavailable");
        }
        return;
      }
      const [catalog, quota, usage, consent, audits] = await Promise.all([
        managedGateway.getCatalog(),
        managedGateway.getQuota(),
        managedGateway.getUsage({ limit: 10 }),
        managedGateway.getAuditConsent(),
        managedGateway.listAudits({ limit: 20 }),
      ]);
      if (!cancelled) {
        setManagedCatalog(catalog);
        setManagedQuota(quota);
        setManagedUsage(usage);
        setManagedAuditAvailable(consent.deploymentEnabled);
        setManagedAuditConsent(consent.enabled);
        setManagedAudits(audits);
        setManagedAuditDetail(null);
        setManagedAccountStatus("ready");
      }
    };
    load().catch(() => {
      if (!cancelled) {
        setManagedAccountStatus("unavailable");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [managedGateway, proxyConfig.mode]);

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

  const clearFieldErrors = useCallback(
    (scope: string, fields: readonly string[]) => {
      setFieldErrors((current) => {
        const keys = fields
          .map((field) => `${scope}.${field}` as FieldErrorKey)
          .filter((key) => current[key]);
        if (!keys.length) {
          return current;
        }
        const next = { ...current };
        keys.forEach((key) => delete next[key]);
        return next;
      });
    },
    [],
  );

  /** Shows `message` under the field and moves focus there. */
  const failValidation = useCallback(
    (field: FieldErrorKey, message: string) => {
      setFieldErrors({ [field]: message });
      setErrorMessage("");
      setStatusMessage("");
      requestAnimationFrame(() => {
        const control = document.querySelector<HTMLElement>(
          `.AISettings [data-field="${field}"]`,
        );
        control?.focus();
        control?.scrollIntoView?.({ block: "nearest" });
      });
    },
    [],
  );

  const resetFeedback = useCallback(() => {
    setStatusMessage("");
    setErrorMessage("");
    setFieldErrors({});
  }, []);

  const updateProxyDraft = useCallback(
    (patch: Partial<AIProxyConfigV2>) => {
      setProxyConfig((current) => ({ ...current, ...patch }));
      clearFieldErrors("network", Object.keys(patch));
    },
    [clearFieldErrors],
  );

  const persistProxyConfig = useCallback(() => {
    // Validate the endpoint the user can see first so the error lands on it.
    const visibleEndpointField: FieldErrorKey | null =
      proxyConfig.mode === "byok-proxy"
        ? "network.endpoint"
        : proxyConfig.mode === "managed-gateway"
        ? "network.gatewayEndpoint"
        : null;
    if (visibleEndpointField) {
      try {
        validateAIProxyEndpoint(
          visibleEndpointField === "network.endpoint"
            ? proxyConfig.endpoint
            : proxyConfig.gatewayEndpoint,
        );
      } catch (error) {
        if (error instanceof AIProxyConfigError) {
          failValidation(
            visibleEndpointField,
            t("ai.proxy.errors.invalidEndpoint"),
          );
          return;
        }
      }
    }

    try {
      const savedConfig = saveAIProxyConfig(proxyConfig);
      savedProxyConfigRef.current = savedConfig;
      setSavedProxyConfig(savedConfig);
      setProxyConfig(savedConfig);
      setFieldErrors({});
      setStatusMessage(t("ai.proxy.saved"));
      setErrorMessage("");
    } catch (error: any) {
      setErrorMessage(
        error instanceof AIProxyConfigError
          ? t("ai.proxy.errors.invalidEndpoint")
          : error?.message || t("ai.proxy.errors.invalidEndpoint"),
      );
      setStatusMessage("");
    }
  }, [failValidation, proxyConfig]);

  const testProxy = useCallback(async () => {
    if (proxyConfig.mode !== "byok-proxy") {
      setErrorMessage(t("ai.proxy.errors.tryDirect"));
      setStatusMessage("");
      return;
    }

    setIsTestingProxy(true);
    setErrorMessage("");
    setStatusMessage("");

    try {
      await testAIProxyConnection(proxyConfig);
      setStatusMessage(t("ai.proxy.testSuccess"));
    } catch (error: any) {
      setErrorMessage(
        error instanceof AIProxyTransportError
          ? error.message
          : t("ai.proxy.errors.server"),
      );
    } finally {
      setIsTestingProxy(false);
    }
  }, [proxyConfig]);

  const approveDeviceCode = useCallback(async () => {
    const code = deviceUserCode.trim();
    if (!code || managedActionPendingRef.current) {
      return;
    }
    managedActionPendingRef.current = true;
    setIsApprovingDevice(true);
    try {
      if (!managedGateway) {
        throw new Error("Managed gateway is unavailable.");
      }
      await managedGateway.approveDeviceAuthorization(code);
      setDeviceUserCode("");
      setStatusMessage(t("ai.proxy.deviceApproved"));
      setErrorMessage("");
    } catch {
      setStatusMessage("");
      setErrorMessage(t("ai.proxy.errors.deviceApproval"));
    } finally {
      managedActionPendingRef.current = false;
      setIsApprovingDevice(false);
    }
  }, [deviceUserCode, managedGateway]);

  const updateManagedAuditConsent = useCallback(
    async (enabled: boolean) => {
      if (managedActionPendingRef.current) {
        return;
      }
      // The checkbox is controlled by `managedAuditConsent`, which only
      // changes on success, so a failed request leaves it where it was.
      managedActionPendingRef.current = true;
      setIsUpdatingAuditConsent(true);
      try {
        if (!managedGateway) {
          throw new Error("Managed gateway is unavailable.");
        }
        await managedGateway.setAuditConsent(enabled);
        setManagedAuditConsent(enabled);
        setStatusMessage(t("ai.proxy.auditUpdated"));
        setErrorMessage("");
      } catch {
        setStatusMessage("");
        setErrorMessage(t("ai.proxy.errors.managedGateway"));
      } finally {
        managedActionPendingRef.current = false;
        setIsUpdatingAuditConsent(false);
      }
    },
    [managedGateway],
  );

  const viewManagedAudit = useCallback(
    async (auditId: string) => {
      if (managedActionPendingRef.current) {
        return;
      }
      managedActionPendingRef.current = true;
      setPendingAuditAction({ id: auditId, action: "view" });
      try {
        if (!managedGateway) {
          throw new Error("Managed gateway is unavailable.");
        }
        setManagedAuditDetail(await managedGateway.getAudit(auditId));
        setStatusMessage("");
        setErrorMessage("");
      } catch {
        setManagedAuditDetail(null);
        setStatusMessage("");
        setErrorMessage(t("ai.proxy.errors.managedGateway"));
      } finally {
        managedActionPendingRef.current = false;
        setPendingAuditAction(null);
      }
    },
    [managedGateway],
  );

  const deleteManagedAudit = useCallback(
    async (auditId: string) => {
      if (!managedGateway || managedActionPendingRef.current) {
        return;
      }
      if (
        !(await confirmAction(t("ai.proxy.auditDeleteConfirm"), {
          confirmLabel: t("ai.common.delete"),
          danger: true,
        })) ||
        managedActionPendingRef.current
      ) {
        return;
      }
      managedActionPendingRef.current = true;
      setPendingAuditAction({ id: auditId, action: "delete" });
      try {
        await managedGateway.deleteAudit(auditId);
        setManagedAudits((current) =>
          current.filter((audit) => audit.id !== auditId),
        );
        setManagedAuditDetail((current) =>
          current?.id === auditId ? null : current,
        );
        setStatusMessage(t("ai.proxy.auditDeleted"));
        setErrorMessage("");
      } catch {
        setStatusMessage("");
        setErrorMessage(t("ai.proxy.errors.managedGateway"));
      } finally {
        managedActionPendingRef.current = false;
        setPendingAuditAction(null);
      }
    },
    [managedGateway],
  );

  const restoreProxyDefaults = useCallback(async () => {
    if (
      !(await confirmAction(t("ai.proxy.restoreDefaultsConfirm"), {
        title: t("ai.proxy.restoreDefaults"),
        confirmLabel: t("ai.proxy.restoreDefaultsAction"),
        danger: true,
      }))
    ) {
      return;
    }
    const restored = resetAIProxyConfig();
    savedProxyConfigRef.current = restored;
    setSavedProxyConfig(restored);
    setProxyConfig(restored);
    setFieldErrors({});
    setStatusMessage(t("ai.proxy.restored"));
    setErrorMessage("");
  }, []);

  // ------------------------------------------------------- Unsaved edits
  const isModelEditorDirty =
    editorState.mode !== "list" &&
    snapshotDraft(editorState.draft, setAsDefault) !== editorState.baseline;
  const isAgentEditorDirty =
    agentEditorState.mode !== "list" &&
    snapshotDraft(agentEditorState.draft, setAgentAsDefault) !==
      agentEditorState.baseline;
  const isSkillEditorDirty =
    skillEditorState.mode !== "list" &&
    snapshotDraft(skillEditorState.draft) !== skillEditorState.baseline;
  const isTemplateEditorDirty =
    templateEditorState.mode !== "list" &&
    snapshotDraft(templateEditorState.draft) !== templateEditorState.baseline;
  const isProxyConfigDirty =
    getProxyConfigSignature(proxyConfig) !==
    getProxyConfigSignature(savedProxyConfig);
  const isDirty =
    isModelEditorDirty ||
    isAgentEditorDirty ||
    isSkillEditorDirty ||
    isTemplateEditorDirty ||
    isProxyConfigDirty;

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  useEffect(
    () => () => {
      onDirtyChange?.(false);
    },
    [onDirtyChange],
  );

  /** Back from an editor: confirm first when it holds unsaved edits. */
  const leaveEditor = useCallback(async (dirty: boolean, close: () => void) => {
    if (dirty && !(await confirmDiscardAISettingsChanges())) {
      return;
    }
    close();
    // Back unmounts with the editor; keep focus inside the dialog so Escape
    // and Tab keep working (the confirm restores focus to the gone button).
    window.setTimeout(() => {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) {
        panelRef.current?.focus({ preventScroll: true });
      }
    });
  }, []);

  const openCreateModel = useCallback(() => {
    const draft = createModelDraft(activeMediaType);
    const nextSetAsDefault = !config.defaultModel;
    setEditorState({
      mode: "create",
      draft,
      baseline: snapshotDraft(draft, nextSetAsDefault),
    });
    setSetAsDefault(nextSetAsDefault);
    resetFeedback();
  }, [activeMediaType, config.defaultModel, resetFeedback]);

  const openEditModelGroup = useCallback(
    (group: AIModelGroup) => {
      if (!group.models.length) {
        return;
      }

      const draft = createModelDraftFromSavedModels(group.models);
      const nextSetAsDefault = group.models.some(
        (model) => config.defaultModel === model.id,
      );
      setEditorState({
        mode: "edit",
        draft,
        indexes: group.indexes,
        baseline: snapshotDraft(draft, nextSetAsDefault),
      });
      setSetAsDefault(nextSetAsDefault);
      resetFeedback();
    },
    [config.defaultModel, resetFeedback],
  );

  const closeEditor = useCallback(() => {
    setEditorState({ mode: "list" });
    setErrorMessage("");
    setFieldErrors({});
  }, []);

  const updateDraft = useCallback(
    (patch: Partial<AIModelDraft>) => {
      clearFieldErrors("model", Object.keys(patch));
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
    },
    [clearFieldErrors],
  );

  const applyProviderPreset = useCallback(
    async (preset: AIModelProviderPreset) => {
      if (editorState.mode === "list") {
        return;
      }
      const { draft } = editorState;
      const dropsKey = shouldDropAPIKey(
        draft.baseURL,
        preset.baseURL,
        draft.apiKey,
      );
      // Applying a preset replaces the connection and model fields; on a
      // saved item (or when it would clear a typed key) ask first.
      if (
        (editorState.mode === "edit" || dropsKey) &&
        !(await confirmAction(
          t("ai.settings.messages.applyPresetConfirm", { name: preset.name }) +
            (dropsKey
              ? `\n\n${t("ai.settings.messages.applyPresetClearsKey")}`
              : ""),
          {
            title: t("ai.settings.messages.applyPresetTitle"),
            confirmLabel: t("ai.common.apply"),
            danger: false,
          },
        ))
      ) {
        return;
      }

      setEditorState((current) =>
        current.mode === "list"
          ? current
          : {
              ...current,
              draft: createModelDraftFromProviderPreset(preset, current.draft),
            },
      );
      setActiveMediaType(preset.mediaType);
      setFieldErrors({});
      setStatusMessage(
        t("ai.settings.messages.defaultsApplied", { name: preset.name }) +
          (dropsKey ? ` ${t("ai.settings.messages.apiKeyCleared")}` : ""),
      );
      setErrorMessage("");
    },
    [editorState],
  );

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
    async (indexes: number[]) => {
      const removedIndexSet = new Set(indexes);
      const removedModels = config.models.filter((_, modelIndex) =>
        removedIndexSet.has(modelIndex),
      );
      const first = removedModels[0];

      if (
        !first ||
        !(await confirmAction(
          t("ai.settings.messages.deleteModelConfirm", {
            name: first.siteName || first.label || first.model,
            models: formatModelGroupNames(removedModels),
          }),
          {
            title: t("ai.common.delete"),
            confirmLabel: t("ai.common.delete"),
            danger: true,
          },
        ))
      ) {
        return;
      }

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
      failValidation(
        "model.siteName",
        t("ai.settings.messages.siteNameRequired"),
      );
      return;
    }

    if (!editorState.draft.baseURL.trim()) {
      failValidation(
        "model.baseURL",
        t("ai.settings.messages.baseURLRequired"),
      );
      return;
    }

    if (!savedModels.length || !draft) {
      failValidation("model.model", t("ai.settings.messages.modelIdsRequired"));
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
  }, [config, editorState, failValidation, persistConfig, setAsDefault]);

  const openCreateAgent = useCallback(
    (type: AIAgentType, provider: AIAgentProvider = "openai-compatible") => {
      setActiveAgentSubTab("base");
      const draft = createAgentDraftFromProviderPreset(provider, type);
      const nextSetAsDefault =
        type === "text"
          ? !agentConfig.defaultTextAgentId
          : type === "vision"
          ? !agentConfig.defaultVisionAgentId
          : !agentConfig.defaultLLMAgentId;
      setAgentEditorState({
        mode: "create",
        draft,
        baseline: snapshotDraft(draft, nextSetAsDefault),
      });
      setSetAgentAsDefault(nextSetAsDefault);
      resetFeedback();
    },
    [
      resetFeedback,
      agentConfig.defaultLLMAgentId,
      agentConfig.defaultTextAgentId,
      agentConfig.defaultVisionAgentId,
    ],
  );

  const openEditAgent = useCallback(
    (agent: AIAgent) => {
      setActiveAgentSubTab("base");
      const draft = { ...agent, systemPrompt: agent.systemPrompt || "" };
      const nextSetAsDefault =
        agent.type === "text"
          ? agent.id === agentConfig.defaultTextAgentId
          : agent.type === "vision"
          ? agent.id === agentConfig.defaultVisionAgentId
          : agent.id === agentConfig.defaultLLMAgentId;
      setAgentEditorState({
        mode: "edit",
        draft,
        baseline: snapshotDraft(draft, nextSetAsDefault),
      });
      setSetAgentAsDefault(nextSetAsDefault);
      resetFeedback();
    },
    [
      resetFeedback,
      agentConfig.defaultLLMAgentId,
      agentConfig.defaultTextAgentId,
      agentConfig.defaultVisionAgentId,
    ],
  );

  const closeAgentEditor = useCallback(() => {
    setAgentEditorState({ mode: "list" });
    setErrorMessage("");
    setFieldErrors({});
  }, []);

  const updateAgentDraft = useCallback(
    (patch: Partial<AIAgent>) => {
      clearFieldErrors("agent", Object.keys(patch));
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
    },
    [clearFieldErrors],
  );

  // Used by both the preset cards and the Provider select, so the two paths
  // follow the same confirm and API-key rules.
  const applyAgentProviderPreset = useCallback(
    async (provider: AIAgentProvider) => {
      if (agentEditorState.mode === "list") {
        return;
      }
      const { draft } = agentEditorState;
      const next = createAgentDraftFromProviderPreset(
        provider,
        draft.type,
        draft,
      );
      const dropsKey = !!draft.apiKey && !next.apiKey;
      const name =
        AGENT_PROVIDER_OPTIONS.find((option) => option.value === provider)
          ?.label || provider;
      if (
        (agentEditorState.mode === "edit" || dropsKey) &&
        !(await confirmAction(
          t("ai.settings.messages.applyPresetConfirm", { name }) +
            (dropsKey
              ? `\n\n${t("ai.settings.messages.applyPresetClearsKey")}`
              : ""),
          {
            title: t("ai.settings.messages.applyPresetTitle"),
            confirmLabel: t("ai.common.apply"),
            danger: false,
          },
        ))
      ) {
        return;
      }

      setAgentEditorState((current) =>
        current.mode === "list"
          ? current
          : {
              ...current,
              draft: createAgentDraftFromProviderPreset(
                provider,
                current.draft.type,
                current.draft,
              ),
            },
      );
      setFieldErrors({});
      setStatusMessage(
        t("ai.settings.messages.defaultsApplied", { name }) +
          (dropsKey ? ` ${t("ai.settings.messages.apiKeyCleared")}` : ""),
      );
      setErrorMessage("");
    },
    [agentEditorState],
  );

  const submitAgentDraft = useCallback(() => {
    if (agentEditorState.mode === "list") {
      return;
    }

    const draft = normalizeAgentDraftForSave(agentEditorState.draft);

    if (!draft.name.trim()) {
      failValidation("agent.name", t("ai.settings.messages.agentNameRequired"));
      return;
    }

    if (!draft.baseURL.trim()) {
      failValidation(
        "agent.baseURL",
        t("ai.settings.messages.baseURLRequired"),
      );
      return;
    }

    if (!draft.model.trim()) {
      failValidation("agent.model", t("ai.settings.messages.modelRequired"));
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
  }, [
    agentConfig,
    agentEditorState,
    failValidation,
    persistAgentConfig,
    setAgentAsDefault,
  ]);

  const removeAgent = useCallback(
    async (agent: AIAgent) => {
      if (
        !(await confirmAction(
          t("ai.settings.messages.deleteAgentConfirm", {
            type: getAgentTypeLabel(agent.type, t),
            name: agent.name,
            suffix: "",
          }),
        ))
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
    const draft = createSkillDraft();
    setSkillEditorState({
      mode: "create",
      draft,
      baseline: snapshotDraft(draft),
    });
    resetFeedback();
  }, [resetFeedback]);

  const openEditSkill = useCallback(
    (skill: AISkill) => {
      setActiveAgentSubTab("skills");
      const draft = createSkillDraftFromSkill(skill);
      setSkillEditorState({
        mode: "edit",
        draft,
        baseline: snapshotDraft(draft),
      });
      resetFeedback();
    },
    [resetFeedback],
  );

  const closeSkillEditor = useCallback(() => {
    setSkillEditorState({ mode: "list" });
    setErrorMessage("");
    setFieldErrors({});
  }, []);

  const updateSkillDraft = useCallback(
    (patch: Partial<SkillDraft>) => {
      clearFieldErrors("skill", Object.keys(patch));
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
    },
    [clearFieldErrors],
  );

  const submitSkillDraft = useCallback(() => {
    if (skillEditorState.mode === "list") {
      return;
    }

    const draft = normalizeSkillDraftForSave(skillEditorState.draft);

    if (!draft.name) {
      failValidation("skill.name", t("ai.settings.messages.skillNameRequired"));
      return;
    }

    if (
      agentConfig.skills.some(
        (skill) =>
          skill.id !== draft.id &&
          skill.name.toLowerCase() === draft.name.toLowerCase(),
      )
    ) {
      failValidation("skill.name", t("ai.settings.messages.skillNameUnique"));
      return;
    }

    if (!draft.description) {
      failValidation(
        "skill.description",
        t("ai.settings.messages.skillDescriptionRequired"),
      );
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
  }, [agentConfig, failValidation, persistAgentConfig, skillEditorState]);

  const removeSkill = useCallback(
    async (skill: AISkill) => {
      if (
        !(await confirmAction(
          t("ai.settings.messages.deleteSkillConfirm", { name: skill.name }),
        ))
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
    const draft = createPromptTemplateDraft();
    setTemplateEditorState({
      mode: "create",
      draft,
      baseline: snapshotDraft(draft),
    });
    resetFeedback();
  }, [resetFeedback]);

  const openEditTemplate = useCallback(
    (template: PromptTemplate) => {
      if (template.isBuiltIn) {
        return;
      }

      const draft = createPromptTemplateDraftFromTemplate(template);
      setTemplateEditorState({
        mode: "edit",
        templateId: template.id,
        draft,
        baseline: snapshotDraft(draft),
      });
      resetFeedback();
    },
    [resetFeedback],
  );

  const closeTemplateEditor = useCallback(() => {
    setTemplateEditorState({ mode: "list" });
    setErrorMessage("");
    setFieldErrors({});
  }, []);

  const updateTemplateDraft = useCallback(
    (patch: Partial<PromptTemplateDraft>) => {
      clearFieldErrors("template", Object.keys(patch));
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
    [clearFieldErrors],
  );

  const toggleTemplateMode = useCallback(
    (mode: AIImageGenerationMode) => {
      clearFieldErrors("template", ["modes"]);
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
    },
    [clearFieldErrors],
  );

  const submitTemplateDraft = useCallback(() => {
    if (templateEditorState.mode === "list") {
      return;
    }

    const draft = templateEditorState.draft;

    if (!draft.label.trim()) {
      failValidation(
        "template.label",
        t("ai.settings.messages.templateLabelRequired"),
      );
      return;
    }

    if (!draft.template.trim()) {
      failValidation(
        "template.template",
        t("ai.settings.messages.templateContentRequired"),
      );
      return;
    }

    if (!draft.modes.length) {
      failValidation(
        "template.modes",
        t("ai.settings.messages.templateModeRequired"),
      );
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
  }, [failValidation, templateEditorState]);

  const removeTemplate = useCallback(async (template: PromptTemplate) => {
    if (
      template.isBuiltIn ||
      !(await confirmAction(
        t("ai.settings.messages.deleteTemplateConfirm", {
          label: template.label,
        }),
      ))
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
    <DialogSection
      title={t("ai.settings.modelList.title")}
      actions={
        <UiButton size="sm" onClick={openCreateModel}>
          {t("ai.settings.modelList.addModel")}
        </UiButton>
      }
    >
      <TabList
        idPrefix="ai-settings-media"
        className="AISettings__subTabs"
        label={t("ai.settings.modelList.ariaLabel")}
        value={activeMediaType}
        onChange={setActiveMediaType}
        tabs={AI_MODEL_MEDIA_TYPES.map((mediaType) => ({
          value: mediaType,
          label: getMediaTypeLabel(mediaType, t),
        }))}
      />

      <div
        {...getTabPanelProps("ai-settings-media", activeMediaType)}
        className="AISettings__subPanel"
        tabIndex={-1}
      >
        {visibleModelGroups.length === 0 && (
          <div className="AISettings__emptyState">
            <span>
              {t("ai.settings.modelList.empty", {
                mediaType: getMediaTypeInlineLabel(activeMediaType, t),
              })}
            </span>
            <UiButton size="sm" variant="ghost" onClick={openCreateModel}>
              {t("ai.settings.modelList.addMediaModel", {
                mediaType: getMediaTypeInlineLabel(activeMediaType, t),
              })}
            </UiButton>
          </div>
        )}

        {visibleModelGroups.length > 0 && (
          <ul className="AISettings__list">
            {visibleModelGroups.map((group) => {
              const isDefault = group.models.some(
                (model) => config.defaultModel === model.id,
              );

              return (
                <ListRow
                  key={group.key}
                  title={group.model.siteName}
                  badges={
                    <>
                      {group.models.length > 1 && (
                        <Badge>
                          {t("ai.settings.modelList.modelCount", {
                            count: group.models.length,
                          })}
                        </Badge>
                      )}
                      {isDefault && (
                        <Badge tone="info">{t("ai.common.default")}</Badge>
                      )}
                    </>
                  }
                  meta={
                    <span className="AISettings__metaLines">
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
                          {group.model.nativeModel ||
                            DEFAULT_AI_IMAGE_NATIVE_MODEL}
                        </span>
                      )}
                    </span>
                  }
                  actions={
                    <UiButton
                      size="sm"
                      onClick={() => openEditModelGroup(group)}
                    >
                      {t("ai.common.edit")}
                    </UiButton>
                  }
                  menu={[
                    {
                      label: t("ai.settings.modelList.setAsDefault"),
                      disabled: isDefault,
                      onSelect: () => makeDefaultModelGroup(group),
                    },
                    {
                      label: t("ai.common.delete"),
                      danger: true,
                      onSelect: () => removeModelGroup(group.indexes),
                    },
                  ]}
                />
              );
            })}
          </ul>
        )}
      </div>
    </DialogSection>
  );

  const renderAgentSubTabs = () => (
    <TabList
      idPrefix="ai-settings-agents"
      className="AISettings__subTabs"
      label={t("ai.settings.agents.sectionsAriaLabel")}
      value={activeAgentSubTab}
      onChange={(value) => {
        setActiveAgentSubTab(value);
        setStatusMessage("");
        setErrorMessage("");
      }}
      tabs={[
        { value: "base", label: t("ai.settings.agents.base") },
        { value: "skills", label: t("ai.settings.agents.skills") },
      ]}
    />
  );

  const renderBaseAgentsList = () => (
    <DialogSection
      title={t("ai.settings.agents.baseConfiguration")}
      description={t("ai.settings.agents.baseDescription")}
    >
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
    </DialogSection>
  );

  const renderSkillsList = () => (
    <DialogSection
      title={t("ai.settings.agents.skillsTitle")}
      description={t("ai.settings.agents.skillsDescription", {
        placeholder: "{user_input}",
      })}
      actions={
        <UiButton size="sm" onClick={openCreateSkill}>
          {t("ai.settings.agents.addSkill")}
        </UiButton>
      }
    >
      {agentConfig.skills.length === 0 && (
        <div className="AISettings__emptyState">
          {t("ai.settings.agents.emptySkills")}
        </div>
      )}

      {agentConfig.skills.length > 0 && (
        <ul className="AISettings__list">
          {agentConfig.skills.map((skill) => (
            <ListRow
              key={skill.id}
              leading={
                <span className="AISettings__iconBadge" aria-hidden="true">
                  {skill.icon}
                </span>
              }
              title={skill.name}
              meta={
                <span className="AISettings__metaLines">
                  {skill.description && <span>{skill.description}</span>}
                  <span>
                    {t("ai.settings.agents.triggerPrefix")}{" "}
                    {skill.triggers?.join(", ") ||
                      t("ai.settings.agents.notConfigured")}
                  </span>
                </span>
              }
              actions={
                <UiButton size="sm" onClick={() => openEditSkill(skill)}>
                  {t("ai.common.edit")}
                </UiButton>
              }
              menu={[
                {
                  label: t("ai.common.delete"),
                  danger: true,
                  onSelect: () => removeSkill(skill),
                },
              ]}
            />
          ))}
        </ul>
      )}
    </DialogSection>
  );

  const renderAgentsList = () => (
    <>
      {renderAgentSubTabs()}
      <div
        {...getTabPanelProps("ai-settings-agents", activeAgentSubTab)}
        className="AISettings__subPanel"
        tabIndex={-1}
      >
        {activeAgentSubTab === "base" && renderBaseAgentsList()}
        {activeAgentSubTab === "skills" && renderSkillsList()}
      </div>
    </>
  );

  const renderAgentSection = (
    title: string,
    subtitle: string,
    agents: AIAgent[],
    defaultAgentId: string | null,
    type: AIAgentType,
  ) => (
    <DialogSection
      headingLevel={4}
      className="AISettings__group"
      title={title}
      description={subtitle}
      actions={
        <UiButton size="sm" onClick={() => openCreateAgent(type)}>
          {t("ai.settings.agentEditor.heading", {
            mode: `${t("ai.common.add")} ${getAgentTypeLabel(type, t)}`,
          })}
        </UiButton>
      }
    >
      {agents.length === 0 && (
        <div className="AISettings__emptyState">
          {t("ai.settings.agents.emptyBaseAgent", {
            type: getAgentTypeLabel(type, t).toLowerCase(),
            target: getAgentTargetLabel(type, t),
          })}
        </div>
      )}

      {agents.length > 0 && (
        <ul className="AISettings__list">
          {agents.map((agent) => {
            const providerLabel =
              AGENT_PROVIDER_OPTIONS.find(
                (option) => option.value === agent.provider,
              )?.label || agent.provider;
            const isDefault = agent.id === defaultAgentId;

            return (
              <ListRow
                key={agent.id}
                title={agent.name}
                badges={
                  <>
                    <Badge>{providerLabel}</Badge>
                    {isDefault && (
                      <Badge tone="info">{t("ai.common.default")}</Badge>
                    )}
                  </>
                }
                meta={
                  <span className="AISettings__metaLines">
                    <span>
                      {t("ai.settings.agents.modelPrefix")} {agent.model}
                    </span>
                    <span>
                      {t("ai.settings.modelList.baseURLPrefix")} {agent.baseURL}
                    </span>
                  </span>
                }
                actions={
                  <UiButton size="sm" onClick={() => openEditAgent(agent)}>
                    {t("ai.common.edit")}
                  </UiButton>
                }
                menu={[
                  {
                    label: t("ai.settings.modelList.setAsDefault"),
                    disabled: isDefault,
                    onSelect: () => makeDefaultAgent(agent),
                  },
                  {
                    label: t("ai.common.delete"),
                    danger: true,
                    onSelect: () => removeAgent(agent),
                  },
                ]}
              />
            );
          })}
        </ul>
      )}
    </DialogSection>
  );

  const renderEditorHeader = (onBack: () => void, title: string) => (
    <div className="AISettings__editorHeader">
      <UiButton size="sm" variant="ghost" onClick={onBack}>
        {t("ai.common.back")}
      </UiButton>
      <h3>{title}</h3>
    </div>
  );

  const renderAgentEditor = () => {
    if (agentEditorState.mode === "list") {
      return null;
    }

    const { draft } = agentEditorState;
    const providerPreset = getAIAgentProviderPreset(draft.provider);
    // Saved key, new host: warn that the key is about to travel with it.
    const savedAgent =
      agentEditorState.mode === "edit"
        ? (JSON.parse(agentEditorState.baseline).draft as AIAgent)
        : null;
    const agentKeyHostChanged =
      !!savedAgent &&
      draft.apiKey === savedAgent.apiKey &&
      shouldDropAPIKey(savedAgent.baseURL, draft.baseURL, draft.apiKey);

    return (
      <>
        {renderEditorHeader(
          () => void leaveEditor(isAgentEditorDirty, closeAgentEditor),
          t("ai.settings.agentEditor.heading", {
            mode: `${
              agentEditorState.mode === "edit"
                ? t("ai.common.edit")
                : t("ai.common.add")
            } ${getAgentTypeLabel(draft.type, t)}`,
          }),
        )}

        <div className="AISettings__providerPresets">
          <span className="AISettings__providerPresetsLabel">
            {t("ai.settings.agentEditor.defaultConfigs")}
          </span>
          <div className="AISettings__providerPresetList">
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

        <div className="AISettings__form">
          <div className="AISettings__formGrid">
            <Field
              label={t("ai.settings.agentEditor.agentName")}
              hint={t("ai.settings.agentEditor.agentNameHint")}
              error={fieldErrors["agent.name"]}
            >
              <TextInput
                data-field="agent.name"
                value={draft.name}
                placeholder={t("ai.settings.agentEditor.agentNamePlaceholder")}
                onChange={(event) =>
                  updateAgentDraft({ name: event.target.value })
                }
              />
            </Field>

            <Field
              label={t("ai.settings.agentEditor.provider")}
              hint={providerPreset?.description}
            >
              <Select
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
              </Select>
            </Field>

            <Field
              label={t("ai.settings.agentEditor.baseURL")}
              error={fieldErrors["agent.baseURL"]}
            >
              <TextInput
                data-field="agent.baseURL"
                value={draft.baseURL}
                placeholder="https://api.example.com/v1"
                onChange={(event) =>
                  updateAgentDraft({ baseURL: event.target.value })
                }
              />
            </Field>

            <Field
              label={t("ai.settings.agentEditor.apiKey")}
              hint={
                agentKeyHostChanged
                  ? t("ai.settings.messages.apiKeyHostChanged")
                  : t("ai.settings.agentEditor.plainTextStorage")
              }
            >
              <TextInput
                value={draft.apiKey}
                type="password"
                autoComplete="off"
                onChange={(event) =>
                  updateAgentDraft({ apiKey: event.target.value })
                }
              />
            </Field>

            <Field
              label={t("ai.settings.agentEditor.model")}
              error={fieldErrors["agent.model"]}
            >
              <TextInput
                data-field="agent.model"
                value={draft.model}
                placeholder={draft.type === "vision" ? "gpt-4o" : "gpt-4o-mini"}
                onChange={(event) =>
                  updateAgentDraft({ model: event.target.value })
                }
              />
            </Field>

            <label className="AISettings__checkbox AISettings__checkbox--aligned">
              <input
                type="checkbox"
                checked={setAgentAsDefault}
                onChange={(event) => setSetAgentAsDefault(event.target.checked)}
              />
              <span>
                {t("ai.settings.agentEditor.defaultAgent", {
                  type: getAgentTypeLabel(draft.type, t),
                })}
              </span>
            </label>
          </div>

          <Field
            label={t("ai.settings.agentEditor.systemPromptOptional")}
            hint={t("ai.settings.agentEditor.systemPromptHint")}
          >
            <TextArea
              value={draft.systemPrompt || ""}
              rows={4}
              placeholder={
                providerPreset?.defaultSystemPrompts[draft.type] || ""
              }
              onChange={(event) =>
                updateAgentDraft({ systemPrompt: event.target.value })
              }
            />
          </Field>

          <Callout
            tone="neutral"
            live={false}
            title={t("ai.settings.agentEditor.recommendedFor", {
              type: getAgentTargetShortLabel(draft.type, t),
            })}
          >
            <ul className="AISettings__plainList">
              {getAgentRecommendations(draft.type, t).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </Callout>
        </div>

        <DialogActions
          className="AISettings__footer"
          leading={
            agentEditorState.mode === "edit" && (
              <UiButton
                variant="danger"
                onClick={() => removeAgent(agentEditorState.draft)}
              >
                {t("ai.common.remove")}
              </UiButton>
            )
          }
        >
          <UiButton variant="primary" onClick={submitAgentDraft}>
            {agentEditorState.mode === "edit"
              ? t("ai.settings.agentEditor.saveAgent")
              : t("ai.settings.agentEditor.createAgent")}
          </UiButton>
        </DialogActions>
      </>
    );
  };

  const renderIconSelect = (
    value: string,
    onChange: (value: string) => void,
  ) => (
    <Field label={t("ai.settings.common.icon")}>
      <Select value={value} onChange={(event) => onChange(event.target.value)}>
        {ICON_OPTIONS.map((icon) => (
          <option key={icon} value={icon}>
            {icon}
          </option>
        ))}
      </Select>
    </Field>
  );

  const renderSkillEditor = () => {
    if (skillEditorState.mode === "list") {
      return null;
    }

    const { draft } = skillEditorState;

    return (
      <>
        {renderEditorHeader(
          () => void leaveEditor(isSkillEditorDirty, closeSkillEditor),
          t("ai.settings.skillEditor.heading", {
            mode:
              skillEditorState.mode === "edit"
                ? t("ai.common.edit")
                : t("ai.common.create"),
          }),
        )}

        <div className="AISettings__form">
          <div className="AISettings__formGrid">
            <Field
              label={t("ai.settings.skillEditor.skillName")}
              error={fieldErrors["skill.name"]}
            >
              <TextInput
                data-field="skill.name"
                value={draft.name}
                placeholder={t("ai.settings.skillEditor.skillNamePlaceholder")}
                onChange={(event) =>
                  updateSkillDraft({ name: event.target.value })
                }
              />
            </Field>

            {renderIconSelect(draft.icon, (icon) => updateSkillDraft({ icon }))}

            <Field
              label={t("ai.settings.skillEditor.description")}
              error={fieldErrors["skill.description"]}
            >
              <TextInput
                data-field="skill.description"
                value={draft.description}
                placeholder={t(
                  "ai.settings.skillEditor.descriptionPlaceholder",
                )}
                onChange={(event) =>
                  updateSkillDraft({ description: event.target.value })
                }
              />
            </Field>

            <Field
              label={t("ai.settings.skillEditor.triggers")}
              hint={t("ai.settings.skillEditor.triggersHint")}
            >
              <TextInput
                value={draft.triggers}
                placeholder={t("ai.settings.skillEditor.triggersPlaceholder")}
                onChange={(event) =>
                  updateSkillDraft({ triggers: event.target.value })
                }
              />
            </Field>
          </div>

          <Field
            label={t("ai.settings.skillEditor.initialPrompt")}
            hint={t("ai.settings.skillEditor.initialPromptHint", {
              placeholder: "{user_input}",
            })}
          >
            <TextArea
              value={draft.initialPrompt || ""}
              rows={7}
              placeholder={t(
                "ai.settings.skillEditor.initialPromptPlaceholder",
              )}
              onChange={(event) =>
                updateSkillDraft({ initialPrompt: event.target.value })
              }
            />
          </Field>
        </div>

        <DialogActions
          className="AISettings__footer"
          leading={
            skillEditorState.mode === "edit" && (
              <UiButton
                variant="danger"
                onClick={() =>
                  removeSkill(
                    normalizeSkillDraftForSave(skillEditorState.draft),
                  )
                }
              >
                {t("ai.common.remove")}
              </UiButton>
            )
          }
        >
          <UiButton variant="primary" onClick={submitSkillDraft}>
            {skillEditorState.mode === "edit"
              ? t("ai.settings.skillEditor.saveSkill")
              : t("ai.settings.skillEditor.createSkill")}
          </UiButton>
        </DialogActions>
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
        <DialogSection
          title={t("ai.settings.templates.title")}
          actions={
            <>
              <UiButton size="sm" onClick={openCreateTemplate}>
                {t("ai.settings.templates.addTemplate")}
              </UiButton>
              <ActionMenu
                items={[
                  {
                    label: t("ai.settings.templates.import"),
                    onSelect: () => templateImportInputRef.current?.click(),
                  },
                  {
                    label: t("ai.settings.templates.export"),
                    disabled: !customTemplates.length,
                    onSelect: exportTemplates,
                  },
                ]}
              />
            </>
          }
        >
          <div className="AISettings__agentSections">
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
        </DialogSection>

        <input
          ref={templateImportInputRef}
          className="AISettings__visuallyHidden"
          type="file"
          accept="application/json,.json"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const file = event.target.files?.[0];

            if (file) {
              importTemplates(file);
            }
            event.target.value = "";
          }}
        />
      </>
    );
  };

  const renderTemplateSection = (
    title: string,
    templates: PromptTemplate[],
    isCustomSection: boolean,
  ) => (
    <DialogSection
      headingLevel={4}
      className="AISettings__group"
      title={title}
      actions={<Badge>{templates.length}</Badge>}
    >
      {templates.length === 0 && (
        <div className="AISettings__emptyState">
          <span>{t("ai.settings.templates.empty")}</span>
          {isCustomSection && (
            <UiButton size="sm" variant="ghost" onClick={openCreateTemplate}>
              {t("ai.settings.templates.addCustomTemplate")}
            </UiButton>
          )}
        </div>
      )}
      {templates.length > 0 && (
        <ul className="AISettings__list">
          {templates.map((template) => (
            <ListRow
              key={template.id}
              className="AISettings__templateRow"
              title={template.label}
              meta={
                <span className="AISettings__metaLines">
                  <span>
                    {[
                      formatTemplateModes(template.modes, t),
                      getPromptTemplateCategoryLabel(template.category, t),
                      getPromptTemplateLanguageLabel(template.language, t),
                    ].join(" · ")}
                  </span>
                  <span className="AISettings__templateText">
                    {template.template}
                  </span>
                </span>
              }
              actions={
                !template.isBuiltIn && (
                  <UiButton
                    size="sm"
                    onClick={() => openEditTemplate(template)}
                  >
                    {t("ai.common.edit")}
                  </UiButton>
                )
              }
              menu={
                template.isBuiltIn
                  ? undefined
                  : [
                      {
                        label: t("ai.common.delete"),
                        danger: true,
                        onSelect: () => removeTemplate(template),
                      },
                    ]
              }
            />
          ))}
        </ul>
      )}
    </DialogSection>
  );

  const renderTemplateEditor = () => {
    if (templateEditorState.mode === "list") {
      return null;
    }

    const { draft } = templateEditorState;

    return (
      <>
        {renderEditorHeader(
          () => void leaveEditor(isTemplateEditorDirty, closeTemplateEditor),
          templateEditorState.mode === "edit"
            ? t("ai.settings.templates.editTemplate")
            : t("ai.settings.templates.newTemplate"),
        )}

        <div className="AISettings__form">
          <Field
            label={t("ai.settings.templates.label")}
            error={fieldErrors["template.label"]}
          >
            <TextInput
              data-field="template.label"
              value={draft.label}
              onChange={(event) =>
                updateTemplateDraft({ label: event.target.value })
              }
            />
          </Field>

          <Field
            label={t("ai.settings.templates.content")}
            hint={t("ai.settings.templates.placeholderHint")}
            error={fieldErrors["template.template"]}
          >
            <TextArea
              data-field="template.template"
              value={draft.template}
              rows={5}
              onChange={(event) =>
                updateTemplateDraft({ template: event.target.value })
              }
            />
          </Field>

          <fieldset
            className="AISettings__checkboxGroup"
            aria-invalid={fieldErrors["template.modes"] ? true : undefined}
            aria-describedby={
              fieldErrors["template.modes"]
                ? "ai-settings-template-modes-error"
                : undefined
            }
          >
            <legend className="AISettings__visuallyHidden">
              {t("ai.common.mode")}
            </legend>
            {TEMPLATE_MODE_OPTIONS.map((option, index) => (
              <label className="AISettings__checkbox" key={option.value}>
                <input
                  type="checkbox"
                  data-field={index === 0 ? "template.modes" : undefined}
                  checked={draft.modes.includes(option.value)}
                  onChange={() => toggleTemplateMode(option.value)}
                />
                <span>{t(option.labelKey)}</span>
              </label>
            ))}
            {fieldErrors["template.modes"] && (
              <p
                className="UiField__error AISettings__groupError"
                id="ai-settings-template-modes-error"
                role="alert"
              >
                {fieldErrors["template.modes"]}
              </p>
            )}
          </fieldset>

          <div className="AISettings__formGrid">
            <Field label={t("ai.settings.templates.category")}>
              <Select
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
              </Select>
            </Field>

            <Field label={t("ai.settings.templates.language")}>
              <Select
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
              </Select>
            </Field>
          </div>
        </div>

        <DialogActions className="AISettings__footer">
          <UiButton variant="primary" onClick={submitTemplateDraft}>
            {templateEditorState.mode === "edit"
              ? t("ai.settings.templates.saveTemplate")
              : t("ai.settings.templates.createTemplate")}
          </UiButton>
        </DialogActions>
      </>
    );
  };

  const renderEditor = () => {
    if (editorState.mode === "list") {
      return null;
    }

    const { draft } = editorState;
    const selectedPreset = getPresetById(draft.endpointPresetId);
    // Saved key, new host: warn that the key is about to travel with it.
    const savedModel =
      editorState.mode === "edit"
        ? (JSON.parse(editorState.baseline).draft as AIModelDraft)
        : null;
    const modelKeyHostChanged =
      !!savedModel &&
      draft.apiKey === savedModel.apiKey &&
      shouldDropAPIKey(savedModel.baseURL, draft.baseURL, draft.apiKey);
    const fieldMappingCount = Object.values(draft.fieldMapping || {}).filter(
      Boolean,
    ).length;
    const capabilityCount = draft.capabilities.length;
    const updateEndpoint = (
      endpointKey: AIImageEndpointMode,
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
        {renderEditorHeader(
          () => void leaveEditor(isModelEditorDirty, closeEditor),
          editorState.mode === "edit"
            ? t("ai.settings.modelEditor.editModel")
            : t("ai.settings.modelEditor.newModel"),
        )}

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
          <DialogSection
            headingLevel={4}
            className="AISettings__formSection"
            title={t("ai.settings.modelEditor.connection")}
          >
            <Field
              label={t("ai.settings.modelEditor.siteName")}
              error={fieldErrors["model.siteName"]}
            >
              <TextInput
                data-field="model.siteName"
                value={draft.siteName}
                onChange={(event) =>
                  updateDraft({ siteName: event.target.value })
                }
              />
            </Field>

            <Field
              label={t("ai.settings.modelEditor.baseURL")}
              error={fieldErrors["model.baseURL"]}
            >
              <TextInput
                data-field="model.baseURL"
                value={draft.baseURL}
                onChange={(event) =>
                  updateDraft({ baseURL: event.target.value })
                }
                placeholder="https://api.example.com/v1"
              />
            </Field>

            <Field
              label={t("ai.settings.modelEditor.apiKey")}
              hint={
                modelKeyHostChanged
                  ? t("ai.settings.messages.apiKeyHostChanged")
                  : t("ai.settings.modelEditor.plainTextStorage")
              }
            >
              <TextInput
                value={draft.apiKey}
                type="password"
                autoComplete="off"
                onChange={(event) =>
                  updateDraft({ apiKey: event.target.value })
                }
              />
            </Field>
          </DialogSection>

          <DialogSection
            headingLevel={4}
            className="AISettings__formSection"
            title={t("ai.settings.modelEditor.model")}
            actions={
              <label className="AISettings__checkbox">
                <input
                  type="checkbox"
                  checked={setAsDefault}
                  onChange={(event) => setSetAsDefault(event.target.checked)}
                />
                <span>{t("ai.settings.modelEditor.defaultModel")}</span>
              </label>
            }
          >
            <Field
              label={t("ai.settings.modelEditor.modelIds")}
              hint={t("ai.settings.modelEditor.modelIdsHint")}
              error={fieldErrors["model.model"]}
            >
              <TextArea
                data-field="model.model"
                value={draft.model}
                rows={3}
                onChange={(event) => updateDraft({ model: event.target.value })}
              />
            </Field>

            <div className="AISettings__formGrid">
              {draft.mediaType === "image" && (
                <Field label={t("ai.settings.modelEditor.nativeModel")}>
                  <Select
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
                  </Select>
                </Field>
              )}

              <Field label={t("ai.settings.modelEditor.type")}>
                <Select
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
                </Select>
              </Field>

              <Field label={t("ai.settings.modelEditor.timeoutSeconds")}>
                <TextInput
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
              </Field>
            </div>
          </DialogSection>

          {draft.mediaType === "image" && (
            <DialogSection
              headingLevel={4}
              className="AISettings__formSection AISettings__formSection--wide"
              title={t("ai.settings.modelEditor.apiConfiguration")}
            >
              <Field
                label={t("ai.settings.modelEditor.endpointPreset")}
                hint={selectedPreset?.description}
              >
                <Select
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
                </Select>
              </Field>

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
                        <TextInput
                          aria-label={t(
                            "ai.settings.modelEditor.endpointPathLabel",
                            { label: endpointLabel },
                          )}
                          value={endpoint.path}
                          placeholder={endpointField.placeholder}
                          onChange={(event) =>
                            updateEndpoint(endpointField.key, {
                              path: event.target.value,
                            })
                          }
                        />
                        <Select
                          aria-label={t(
                            "ai.settings.modelEditor.endpointFormatLabel",
                            { label: endpointLabel },
                          )}
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
                        </Select>
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
                  {fieldMappingCount > 0 && <Badge>{fieldMappingCount}</Badge>}
                </summary>
                <div className="AISettings__fieldMappingGrid">
                  {FIELD_MAPPING_FORM_FIELDS.map((field) => (
                    <Field label={t(field.labelKey)} key={field.key}>
                      <TextInput
                        value={draft.fieldMapping?.[field.key] || ""}
                        placeholder={field.placeholder}
                        onChange={(event) =>
                          updateFieldMapping(field.key, event.target.value)
                        }
                      />
                    </Field>
                  ))}
                </div>
              </details>
            </DialogSection>
          )}

          <DialogSection
            headingLevel={4}
            className="AISettings__formSection AISettings__formSection--wide"
            title={t("ai.settings.modelEditor.capabilities")}
          >
            <details className="AISettings__advanced">
              <summary>
                <span>{t("ai.settings.modelEditor.enabledCapabilities")}</span>
                <Badge>{capabilityCount}</Badge>
              </summary>

              <div className="AISettings__capabilities">
                {MODEL_CAPABILITY_OPTIONS[draft.mediaType].map((option) => (
                  <label className="AISettings__checkbox" key={option.value}>
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
          </DialogSection>
        </div>

        <DialogActions
          className="AISettings__footer"
          leading={
            editorState.mode === "edit" && (
              <UiButton
                variant="danger"
                onClick={() => removeModelGroup(editorState.indexes)}
              >
                {t("ai.common.remove")}
              </UiButton>
            )
          }
        >
          <UiButton variant="primary" onClick={submitDraft}>
            {editorState.mode === "edit"
              ? t("ai.settings.modelEditor.saveModel")
              : t("ai.settings.modelEditor.createModel")}
          </UiButton>
        </DialogActions>
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

  const renderNetworkSettings = () => {
    const runtimeDefaultEndpoint = getRuntimeDefaultAIProxyEndpoint();
    const runtimeDefaultGatewayEndpoint = getRuntimeDefaultAIGatewayEndpoint();

    const networkModes = [
      {
        mode: "direct",
        title: t("ai.proxy.directTitle"),
        description: t("ai.proxy.directDescription"),
      },
      {
        mode: "byok-proxy",
        title: t("ai.proxy.backendTitle"),
        description: t("ai.proxy.backendDescription"),
      },
      {
        mode: "managed-gateway",
        title: t("ai.proxy.managedTitle"),
        description: t("ai.proxy.managedDescription"),
      },
    ] as const;

    return (
      <>
        <div
          className="AISettings__networkModes"
          role="radiogroup"
          aria-label={t("ai.proxy.networkTitle")}
        >
          {networkModes.map((option) => (
            <label
              key={option.mode}
              className={
                proxyConfig.mode === option.mode
                  ? "AISettings__networkMode is-selected"
                  : "AISettings__networkMode"
              }
            >
              <input
                type="radio"
                name="ai-network-mode"
                checked={proxyConfig.mode === option.mode}
                onChange={() => updateProxyDraft({ mode: option.mode })}
              />
              <span>
                <strong>{option.title}</strong>
                <small>{option.description}</small>
              </span>
            </label>
          ))}
        </div>

        {proxyConfig.mode === "byok-proxy" && (
          <div className="AISettings__formGrid">
            <Field
              label={t("ai.proxy.endpoint")}
              error={fieldErrors["network.endpoint"]}
              hint={
                <span className="AISettings__metaLines">
                  <span>{t("ai.proxy.endpointHint")}</span>
                  <span>
                    {t("ai.proxy.runtimeDefault", {
                      endpoint: runtimeDefaultEndpoint,
                    })}
                  </span>
                </span>
              }
            >
              <TextInput
                data-field="network.endpoint"
                value={proxyConfig.endpoint}
                placeholder={t("ai.proxy.endpointPlaceholder")}
                onChange={(event) =>
                  updateProxyDraft({ endpoint: event.target.value })
                }
              />
            </Field>

            <Field
              label={t("ai.proxy.accessToken")}
              hint={t("ai.proxy.accessTokenHint")}
            >
              <TextInput
                type="password"
                autoComplete="off"
                value={proxyConfig.accessToken}
                onChange={(event) =>
                  updateProxyDraft({ accessToken: event.target.value })
                }
              />
            </Field>
          </div>
        )}

        {proxyConfig.mode === "managed-gateway" && (
          <>
            <Field
              label={t("ai.proxy.gatewayEndpoint")}
              error={fieldErrors["network.gatewayEndpoint"]}
              hint={t("ai.proxy.runtimeDefault", {
                endpoint: runtimeDefaultGatewayEndpoint,
              })}
            >
              <TextInput
                data-field="network.gatewayEndpoint"
                value={proxyConfig.gatewayEndpoint}
                placeholder="/ai-gateway/v1"
                onChange={(event) =>
                  updateProxyDraft({ gatewayEndpoint: event.target.value })
                }
              />
            </Field>

            {managedAccountStatus === "loading" && (
              <Callout tone="info">{t("ai.proxy.managedLoading")}</Callout>
            )}
            {managedAccountStatus === "signed-out" && (
              <Callout tone="warning">
                {t("ai.proxy.managedSignInRequired")}
              </Callout>
            )}
            {managedAccountStatus === "unavailable" && (
              <Callout tone="danger">
                {t("ai.proxy.managedUnavailable")}
              </Callout>
            )}

            {managedAccountStatus === "ready" && (
              <>
                <div className="AISettings__formGrid">
                  {MANAGED_ROUTE_CAPABILITIES.map((capability) => {
                    const routes = managedCatalog.filter(
                      (entry) => entry.capability === capability,
                    );
                    return (
                      <Field
                        label={t(MANAGED_ROUTE_LABELS[capability])}
                        key={capability}
                      >
                        <Select
                          value={proxyConfig.managedRoutes[capability] || ""}
                          onChange={(event) =>
                            updateProxyDraft({
                              managedRoutes: {
                                ...proxyConfig.managedRoutes,
                                [capability]: event.target.value,
                              },
                            })
                          }
                        >
                          <option value="">{t("ai.proxy.selectRoute")}</option>
                          {routes.map((route) => (
                            <option value={route.id} key={route.id}>
                              {route.label} ({route.model})
                            </option>
                          ))}
                        </Select>
                      </Field>
                    );
                  })}
                </div>

                {managedQuota && (
                  <DialogSection
                    headingLevel={4}
                    className="AISettings__group"
                    title={t("ai.proxy.quotaTitle")}
                  >
                    <div className="AISettings__gatewaySummary">
                      <span>
                        {t("ai.proxy.quotaDaily", {
                          used: managedQuota.daily.used,
                          limit: managedQuota.daily.limit,
                        })}
                      </span>
                      <span>
                        {t("ai.proxy.quotaMonthly", {
                          used: managedQuota.monthly.used,
                          limit: managedQuota.monthly.limit,
                        })}
                      </span>
                      <span>
                        {t("ai.proxy.recentUsage", {
                          count: managedUsage.length,
                        })}
                      </span>
                    </div>
                  </DialogSection>
                )}

                {managedAuditAvailable && (
                  <DialogSection
                    headingLevel={4}
                    className="AISettings__group"
                    title={t("ai.proxy.auditRecords")}
                  >
                    <label className="AISettings__checkbox">
                      <input
                        type="checkbox"
                        checked={managedAuditConsent}
                        disabled={isUpdatingAuditConsent}
                        aria-busy={isUpdatingAuditConsent || undefined}
                        onChange={(event) =>
                          void updateManagedAuditConsent(event.target.checked)
                        }
                      />
                      <span>{t("ai.proxy.auditConsent")}</span>
                    </label>
                    {!managedAudits.length && (
                      <p className="AISettings__hint">
                        {t("ai.proxy.auditEmpty")}
                      </p>
                    )}
                    {managedAudits.length > 0 && (
                      <ul className="AISettings__list">
                        {managedAudits.map((audit) => (
                          <ListRow
                            key={audit.id}
                            title={audit.routeId}
                            meta={new Date(audit.createdAt).toLocaleString()}
                            actions={
                              <>
                                <UiButton
                                  size="sm"
                                  variant="ghost"
                                  loading={
                                    pendingAuditAction?.id === audit.id &&
                                    pendingAuditAction.action === "view"
                                  }
                                  disabled={!!pendingAuditAction}
                                  onClick={() =>
                                    void viewManagedAudit(audit.id)
                                  }
                                >
                                  {t("ai.proxy.auditView")}
                                </UiButton>
                                <UiButton
                                  size="sm"
                                  variant="danger"
                                  loading={
                                    pendingAuditAction?.id === audit.id &&
                                    pendingAuditAction.action === "delete"
                                  }
                                  disabled={!!pendingAuditAction}
                                  onClick={() =>
                                    void deleteManagedAudit(audit.id)
                                  }
                                >
                                  {t("ai.proxy.auditDelete")}
                                </UiButton>
                              </>
                            }
                          />
                        ))}
                      </ul>
                    )}
                    {managedAuditDetail && (
                      <div className="AISettings__auditDetail">
                        <div className="AISettings__auditDetailHeader">
                          <strong>{t("ai.proxy.auditPrompt")}</strong>
                          <UiButton
                            size="sm"
                            variant="ghost"
                            onClick={() => setManagedAuditDetail(null)}
                          >
                            {t("buttons.close")}
                          </UiButton>
                        </div>
                        <pre>{managedAuditDetail.prompt || ""}</pre>
                      </div>
                    )}
                  </DialogSection>
                )}

                <div className="AISettings__deviceApproval">
                  <Field label={t("ai.proxy.deviceCode")}>
                    <TextInput
                      value={deviceUserCode}
                      autoComplete="off"
                      onChange={(event) =>
                        setDeviceUserCode(event.target.value)
                      }
                    />
                  </Field>
                  <UiButton
                    disabled={!deviceUserCode.trim()}
                    loading={isApprovingDevice}
                    onClick={() => void approveDeviceCode()}
                  >
                    {t("ai.proxy.approveDevice")}
                  </UiButton>
                </div>
              </>
            )}
          </>
        )}

        <Callout tone="warning" live={false}>
          {t("ai.proxy.videoWarning")}
        </Callout>

        <DialogActions
          className="AISettings__footer"
          leading={
            <>
              <UiButton
                variant="ghost"
                onClick={() => void restoreProxyDefaults()}
              >
                {t("ai.proxy.restoreDefaults")}
              </UiButton>
              {isProxyConfigDirty && (
                <span className="AISettings__unsaved" role="status">
                  {t("ai.settings.messages.unsavedChanges")}
                </span>
              )}
            </>
          }
        >
          <UiButton
            disabled={proxyConfig.mode !== "byok-proxy"}
            loading={isTestingProxy}
            onClick={testProxy}
          >
            {isTestingProxy ? t("ai.proxy.testing") : t("ai.proxy.test")}
          </UiButton>
          <UiButton variant="primary" onClick={persistProxyConfig}>
            {t("ai.proxy.save")}
          </UiButton>
        </DialogActions>
      </>
    );
  };

  return (
    <div className="AISettings">
      <TabList
        idPrefix="ai-settings"
        className="AISettings__topTabs"
        label={t("ai.common.settings")}
        value={activeSettingsTab}
        onChange={setActiveSettingsTab}
        tabs={[
          { value: "models", label: t("ai.settings.tabs.models") },
          { value: "agents", label: t("ai.settings.tabs.agents") },
          { value: "templates", label: t("ai.settings.tabs.templates") },
          { value: "network", label: t("ai.proxy.networkTitle") },
        ]}
      />

      <div
        {...getTabPanelProps("ai-settings", activeSettingsTab)}
        ref={panelRef}
        className="AISettings__panel"
        tabIndex={-1}
      >
        {activeSettingsTab === "models" &&
          (editorState.mode === "list" ? renderList() : renderEditor())}
        {activeSettingsTab === "agents" && renderAgentSettings()}
        {activeSettingsTab === "templates" &&
          (templateEditorState.mode === "list"
            ? renderTemplatesList()
            : renderTemplateEditor())}
        {activeSettingsTab === "network" && renderNetworkSettings()}
      </div>

      {(statusMessage || errorMessage) && (
        <Callout
          className="AISettings__message"
          tone={errorMessage ? "danger" : "success"}
        >
          {errorMessage || statusMessage}
        </Callout>
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
