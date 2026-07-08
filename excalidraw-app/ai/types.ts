import type { AppState, DataURL } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawFreeDrawElement,
  FileId,
} from "@excalidraw/element/types";

export type AIImageGenerationMode =
  | "text-to-image"
  | "image-to-image"
  | "inpaint";

export type AIModelMediaType = "image" | "video" | "audio";

export type AIImageNativeModel =
  | "nano-banana"
  | "nano-banana-pro"
  | "nano-banana-2"
  | "gpt-image-2"
  | "other";

export type AIImageModelCapability =
  | AIImageGenerationMode
  | "text-to-video"
  | "image-to-video"
  | "text-to-audio"
  | "negative-prompt"
  | "seed"
  | "style"
  | "quality"
  | "reference-strength"
  | "duration"
  | "resolution"
  | "aspect-ratio"
  | "audio-format"
  | "voice";

export type AIImageEndpointConfig = {
  path: string;
  format: "json" | "form" | "gemini";
};

export type AIImageEndpoints = {
  textToImage: AIImageEndpointConfig;
  imageToImage: AIImageEndpointConfig;
  inpaint: AIImageEndpointConfig;
};

export type AIImageFieldMapping = {
  prompt?: string;
  negativePrompt?: string;
  model?: string;
  image?: string;
  mask?: string;
  size?: string;
  n?: string;
};

export type AIImageModel = {
  id: string;
  siteName: string;
  baseURL: string;
  apiKey: string;
  model: string;
  label: string;
  mediaType: AIModelMediaType;
  nativeModel?: AIImageNativeModel;
  capabilities: AIImageModelCapability[];
  endpoints: AIImageEndpoints;
  fieldMapping?: AIImageFieldMapping;
  requestTimeoutSeconds: number;
};

export type AIImageProviderConfig = {
  baseURL: string;
  apiKey: string;
  defaultModel: string;
  models: AIImageModel[];
};

export type AIAgentProvider =
  | "openai"
  | "anthropic"
  | "gemini"
  | "deepseek"
  | "openai-compatible";

export type AIAgentType = "text" | "vision" | "llm";

export type AIAgent = {
  id: string;
  name: string;
  type: AIAgentType;
  provider: AIAgentProvider;
  baseURL: string;
  apiKey: string;
  model: string;
  systemPrompt?: string;
};

export type CustomAIAgent = {
  id: string;
  name: string;
  description: string;
  icon: string;
  baseLLMAgentId: string;
  systemPrompt: string;
};

export type AISkill = {
  id: string;
  name: string;
  icon: string;
  description: string;
  triggers?: string[];
  initialPrompt?: string;
};

export type ChatMode = "agent" | "image" | "video" | "audio";

export type ChatCodeBlock = {
  language: string;
  code: string;
};

export type DetectedPrompt = {
  text: string;
  confidence: number;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  agentId: string;
  timestamp: number;
  codeBlocks?: ChatCodeBlock[];
  detectedPrompt?: DetectedPrompt;
};

export type ChatConversation = {
  id: string;
  title: string;
  agentId: string;
  mode: ChatMode;
  messages: ChatMessage[];
  pendingSkillId?: string;
  createdAt: number;
  updatedAt: number;
};

export type CustomAgentChatHistory = {
  conversations: ChatConversation[];
  activeConversationId: string | null;
};

export type AIAgentConfig = {
  textAgents: AIAgent[];
  visionAgents: AIAgent[];
  llmAgents: AIAgent[];
  customAgents: CustomAIAgent[];
  skills: AISkill[];
  defaultTextAgentId: string | null;
  defaultVisionAgentId: string | null;
  defaultLLMAgentId: string | null;
  defaultCustomAgentId: string | null;
  useTextAgentForVision: boolean;
};

export type AIImageGenerationParams = {
  size: string;
  n: number;
  seed?: number | null;
  quality?: string;
  style?: string;
  referenceStrength?: number;
  duration?: number;
  fps?: number;
  resolution?: string;
  aspectRatio?: string;
  audioFormat?: string;
  voice?: string;
};

export type AIImageSourceType = "imported" | "canvas" | "mixed";

export type AIImageSource = {
  elementId: string;
  fileId?: FileId;
  file: File;
  dataURL: DataURL;
  width?: number;
  height?: number;
};

export type AIImageSourceEnhanced = AIImageSource & {
  index: number;
  sourceType: AIImageSourceType;
  weight?: number;
  locked?: boolean;
  createdAt: number;
  elementIds?: string[];
  missingElement?: boolean;
};

export type AIReferenceExportOptions = {
  background: "transparent" | "white" | "canvas";
  padding: "tight" | "padded";
  maxSize: "auto" | "1024" | "2048";
};

export type PromptTemplateCategory =
  | "composition"
  | "style"
  | "editing"
  | "custom";

export type PromptTemplateLanguage = "en" | "zh" | "multi";

export type PromptTemplate = {
  id: string;
  label: string;
  template: string;
  modes: AIImageGenerationMode[];
  category?: PromptTemplateCategory;
  language?: PromptTemplateLanguage;
  createdAt: number;
  isBuiltIn: boolean;
};

export type AIImageMask = {
  file: File;
  dataURL: DataURL;
};

export type AIImageEditableMask = {
  file: File;
  dataURL?: DataURL;
  elements: readonly ExcalidrawFreeDrawElement[];
  updatedAt: number;
};

export type AIMaskReadyPayload = {
  imageId: string;
  maskFile: File;
  maskElements: readonly ExcalidrawFreeDrawElement[];
};

export type AIImageGenerationRequest = {
  config: AIImageProviderConfig;
  mode: AIImageGenerationMode;
  model: string;
  prompt: string;
  negativePrompt?: string;
  params: AIImageGenerationParams;
  sources?: AIImageSource[];
  mask?: AIImageMask | null;
  signal?: AbortSignal;
};

export type AIImageGenerationOutput = {
  dataURL: DataURL;
  mimeType: string;
  remoteURL?: string;
  storageType?: "data-url" | "remote-url";
  remoteFetchError?: unknown;
  revisedPrompt?: string;
};

export type AIGenerationLogStatus = "success" | "failed" | "canceled";

export type AIGenerationLogEntry = {
  id: string;
  submittedAt: string;
  completedAt: string;
  mediaType: AIModelMediaType;
  mode: AIImageGenerationMode | "text-to-video" | "text-to-audio";
  status: AIGenerationLogStatus;
  model: {
    id: string;
    name: string;
    siteName: string;
  };
  prompt: string;
  negativePrompt?: string;
  params: AIImageGenerationParams;
  request: {
    baseURL: string;
    endpoint?: string;
  };
  response: {
    summary: string;
    details: unknown;
  };
};

export type AIImageGenerationMetadata = {
  version: 1;
  kind: "image";
  mode: AIImageGenerationMode;
  model: string;
  prompt: string;
  negativePrompt?: string;
  params: AIImageGenerationParams;
  sourceElementIds: string[];
  sourceImages?: Array<{
    index: number;
    elementId?: string;
    elementIds?: string[];
    sourceType: AIImageSourceType;
    weight?: number;
  }>;
  output: {
    provider: "openai-compatible";
    index: number;
    mimeType: string;
    remoteURL?: string;
    revisedPrompt?: string;
  };
  createdAt: string;
};

export type AIVideoGenerationMode = "text-to-video" | "image-to-video";

export type AIVideoGenerationRequest = {
  config: AIImageProviderConfig;
  mode: AIVideoGenerationMode;
  model: string;
  prompt: string;
  params: AIImageGenerationParams;
  // First-frame / reference images for image-to-video. Reuses the image source
  // shape so the workbench can hand over selected canvas images unchanged.
  sources?: AIImageSource[];
  signal?: AbortSignal;
};

export type AIVideoTaskStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed";

export type AIVideoGenerationOutput = {
  videoURL: string;
  thumbnailDataURL?: DataURL;
  mimeType: string;
  durationSeconds?: number;
  revisedPrompt?: string;
};

// Result of a single poll. `videoURL`/`thumbnailURL`/`durationSeconds` are only
// present once `status === "completed"`; `error` only when `status === "failed"`.
export type AIVideoPollResult = {
  status: AIVideoTaskStatus;
  progress?: number;
  videoURL?: string;
  thumbnailURL?: string;
  durationSeconds?: number;
  revisedPrompt?: string;
  error?: string;
};

// Stored on the inserted embeddable element's `customData.aiVideoGeneration`.
// The canvas has no native video element type, so the real video URL lives here
// (and on the element's `link`); the app renders it as an inline <video> player.
export type AIVideoGenerationMetadata = {
  version: 1;
  kind: "video";
  mode: AIVideoGenerationMode;
  model: string;
  prompt: string;
  params: AIImageGenerationParams;
  videoURL: string;
  mimeType: string;
  durationSeconds?: number;
  revisedPrompt?: string;
  createdAt: string;
};

// A submitted-but-not-yet-finished video task, persisted to localStorage so
// polling can resume after a page refresh. `params`/`prompt`/`mode` are kept so
// the resumed task can still build canvas metadata + a generation log on
// completion without the original in-memory request.
export type PendingVideoTask = {
  taskId: string;
  baseURL: string;
  // Which model card the task was submitted with, so the resumed poll can look
  // up its apiKey from the current config rather than persisting the secret.
  modelId: string;
  model: string;
  siteName: string;
  mode: AIVideoGenerationMode;
  prompt: string;
  params: AIImageGenerationParams;
  status: AIVideoTaskStatus;
  submittedAt: string;
};

export type AIImageCustomData = {
  aiGeneration?: AIImageGenerationMetadata;
  aiVideoGeneration?: AIVideoGenerationMetadata;
};

export type AIMaskEditingState = {
  mode: "editing" | null;
  targetImageId: string | null;
  maskElementIds: string[];
  previousState: {
    selectedElementIds: AppState["selectedElementIds"];
    scrollX: AppState["scrollX"];
    scrollY: AppState["scrollY"];
    zoom: AppState["zoom"];
    activeTool: AppState["activeTool"];
    currentItemStrokeColor: AppState["currentItemStrokeColor"];
    currentItemBackgroundColor: AppState["currentItemBackgroundColor"];
    currentItemStrokeWidth: AppState["currentItemStrokeWidth"];
    currentItemStrokeStyle: AppState["currentItemStrokeStyle"];
    currentItemRoughness: AppState["currentItemRoughness"];
    currentItemOpacity: AppState["currentItemOpacity"];
  } | null;
};
