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
  | "gpt-image-2.5"
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
  // When true, the endpoint returns a task id instead of the image itself; the
  // adapter submits with `async: true` then polls `AIImageEndpoints.taskPollURL`
  // until the task completes. Used by async providers such as Right Code.
  async?: boolean;
};

export type AIImageEndpoints = {
  textToImage: AIImageEndpointConfig;
  imageToImage: AIImageEndpointConfig;
  inpaint: AIImageEndpointConfig;
  // Poll URL template for async endpoints, containing a `{task_id}` placeholder.
  // An absolute URL is used verbatim; a "/"-prefixed path resolves against the
  // provider base URL's origin, so Right Code's `/v1/tasks/{task_id}` follows
  // whichever host the model's Base URL points at.
  taskPollURL?: string;
};

// The three per-mode endpoint keys of AIImageEndpoints, excluding the optional
// `taskPollURL` metadata field. Used where code iterates over the endpoint
// configs (each an AIImageEndpointConfig) and must not include taskPollURL.
export type AIImageEndpointMode = "textToImage" | "imageToImage" | "inpaint";

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
  /** User's free-text note, shown when hovering the model in the workbench. */
  note?: string;
  /** Video wire protocol (ADR 0039). Absent means "openai-videos". */
  videoProtocol?: AIVideoProtocol;
  /** How the provider bills this model; drives the cost estimate (ADR 0039). */
  billing?: AIModelBilling;
};

/**
 * Video wire protocols (ADR 0039):
 * - `openai-videos`: `POST {baseURL}/videos` + `GET /videos/{id}` (ADR 0015).
 * - `rolldek-sd`: RollDek sd-* channels, `POST /v1/videos` with top-level
 *   `duration` / `image_refs` / `first_image` fields.
 * - `volc-tasks`: Volcengine Ark format, `POST /api/v3/contents/generations/
 *   tasks` with a `content[]` array.
 * The two RollDek protocols take a bare-host Base URL; the adapter owns paths.
 */
export type AIVideoProtocol = "openai-videos" | "rolldek-sd" | "volc-tasks";

export type AIVideoResolutionTier = "480p" | "720p" | "1080p";

/**
 * Per-million-token prices, keyed by output resolution; `withVideo` applies
 * when the request carries a reference video (Volcengine prices it lower).
 */
export type AIModelTokenPrices = Partial<
  Record<AIVideoResolutionTier, { base: number; withVideo?: number }>
>;

/**
 * `per-request` models are billed a flat price per task and get no estimate.
 * `per-token` models show an estimate: `prices` overrides the catalog list
 * prices for this card, and `multiplier` is the relay's group rate.
 */
export type AIModelBilling =
  | { mode: "per-request" }
  | { mode: "per-token"; multiplier: number; prices?: AIModelTokenPrices };

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
  mode: AIImageGenerationMode | AIVideoGenerationMode | "text-to-audio";
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
    /** Async endpoints: task query URL, `{task_id}` left as a placeholder. */
    pollEndpoint?: string;
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

// `image-to-video` is the openai-videos first-frame mode (ADR 0015) and stays
// readable in saved metadata. `reference-to-video` (images/videos/audios as
// references) and `first-last-frame` come from the RollDek protocols (ADR 0039).
export type AIVideoGenerationMode =
  | "text-to-video"
  | "image-to-video"
  | "reference-to-video"
  | "first-last-frame";

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
  /** Billed tokens, from per-token providers once the task succeeded. */
  totalTokens?: number;
};

/**
 * A reference passed to the RollDek video protocols (ADR 0039). `url` must be
 * a public HTTPS URL (a short-lived signed storage URL); data/blob URLs are
 * rejected because RollDek only fails them asynchronously, after queueing.
 */
export type AIVideoReference = {
  kind: "image" | "video" | "audio";
  url: string;
  /** Length of a reference video, for the per-token estimate. */
  durationSeconds?: number;
};

// Stored on the inserted embeddable element's `customData.aiVideoGeneration`.
// The canvas has no native video element type, so the real video URL lives here
// (and on the element's `link`); the app renders it as an inline <video> player.
type AIVideoGenerationMetadataBase = {
  kind: "video";
  mode: AIVideoGenerationMode;
  model: string;
  prompt: string;
  params: AIImageGenerationParams;
  mimeType: string;
  durationSeconds?: number;
  revisedPrompt?: string;
  createdAt: string;
};

export type AIVideoGenerationMetadataV1 = AIVideoGenerationMetadataBase & {
  version: 1;
  videoURL: string;
};

export type AIVideoGenerationMetadataV2 = AIVideoGenerationMetadataBase & {
  version: 2;
  assetId: string;
  width?: number;
  height?: number;
};

export type AIVideoGenerationMetadata =
  | AIVideoGenerationMetadataV1
  | AIVideoGenerationMetadataV2;

// A submitted-but-not-yet-finished video task, persisted to localStorage so
// polling can resume after a page refresh. `params`/`prompt`/`mode` are kept so
// the resumed task can still build canvas metadata + a generation log on
// completion without the original in-memory request.
export type PendingVideoTask = {
  taskId: string;
  baseURL: string;
  /** Transport used when the task was submitted; absent means legacy direct/BYOK. */
  transportMode?: "direct" | "byok-proxy" | "managed-gateway";
  /** Managed catalog route retained so a refresh can poll the same contract. */
  managedRouteId?: string;
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
  /** RollDek protocol, so a resumed poll uses the right paths (ADR 0039). */
  videoProtocol?: AIVideoProtocol;
  /** Uploaded reference assets to delete once the task ends (ADR 0039 §4). */
  referenceAssetIds?: string[];
  /** A reference video was sent, so per-token cost uses that price tier. */
  hasReferenceVideo?: boolean;
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
