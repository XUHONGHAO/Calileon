import type { AIImageGenerationParams } from "./types";

export const MANY_MINDS_DEFAULT_CONCURRENCY = 3;
export const MANY_MINDS_MAX_TASKS = 9;

export type ManyMindsInputKind =
  | "image"
  | "region"
  | "text"
  | "vision-and-text";

export type ManyMindsAssetRef = {
  assetId: string;
  role: "input" | "output";
  mimeType: string;
  width?: number;
  height?: number;
};

export type ManyMindsInputSnapshot = {
  kind: ManyMindsInputKind;
  prompt: string;
  sourceElementIds: string[];
  assets: ManyMindsAssetRef[];
  createdAt: number;
};

export type ManyMindsPerspective = {
  id: string;
  name: string;
  icon: string;
  prompt: string;
  recommendedModelId?: string;
  params?: Partial<AIImageGenerationParams>;
  isBuiltIn: boolean;
  createdAt?: number;
  updatedAt?: number;
};

export type ManyMindsTaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type ManyMindsTask = {
  id: string;
  batchId: string;
  perspective: ManyMindsPerspective;
  modelId: string;
  params: AIImageGenerationParams;
  status: ManyMindsTaskStatus;
  output?: ManyMindsAssetRef;
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  interruptedAt?: number;
  attempt: number;
  parentTaskId?: string;
  cancellationMayHaveIncurredCost?: boolean;
};

export type ManyMindsBatchStatus =
  | "idle"
  | "running"
  | "completed"
  | "cancelled"
  | "interrupted";

export type ManyMindsBatch = {
  version: 1;
  id: string;
  persistenceScopeId: string;
  input: ManyMindsInputSnapshot;
  taskOrder: string[];
  tasks: Record<string, ManyMindsTask>;
  concurrency: number;
  status: ManyMindsBatchStatus;
  createdAt: number;
  updatedAt: number;
  parentTaskId?: string;
};

/** Safe relation that may be copied to canvas metadata or generation logs. */
export type ManyMindsPortableRelation = {
  version: 1;
  batchId: string;
  taskId: string;
  perspectiveId: string;
  parentTaskId?: string;
  inputAssetIds: string[];
  outputAssetId: string;
};

export type ManyMindsStoredAsset = {
  version: 1;
  ref: ManyMindsAssetRef;
  blob: Blob;
  createdAt: number;
};

export const createManyMindsId = (prefix: string) => {
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${id}`;
};

export const createManyMindsBatch = ({
  persistenceScopeId,
  input,
  perspectives,
  modelId,
  params,
  concurrency = MANY_MINDS_DEFAULT_CONCURRENCY,
  parentTaskId,
  now = Date.now(),
}: {
  persistenceScopeId: string;
  input: ManyMindsInputSnapshot;
  perspectives: readonly ManyMindsPerspective[];
  modelId: string;
  params: AIImageGenerationParams;
  concurrency?: number;
  parentTaskId?: string;
  now?: number;
}): ManyMindsBatch => {
  if (!persistenceScopeId.trim()) {
    throw new Error("Many Minds requires a persistence scope.");
  }
  if (perspectives.length < 1 || perspectives.length > MANY_MINDS_MAX_TASKS) {
    throw new Error("Many Minds batches require between 1 and 9 tasks.");
  }

  const id = createManyMindsId("many-minds-batch");
  const tasks = perspectives.map((perspective) => {
    const taskId = createManyMindsId("many-minds-task");
    return {
      id: taskId,
      batchId: id,
      perspective: { ...perspective, params: { ...perspective.params } },
      modelId: perspective.recommendedModelId || modelId,
      params: { ...params, ...perspective.params },
      status: "queued" as const,
      createdAt: now,
      attempt: 0,
      parentTaskId,
    };
  });

  return {
    version: 1,
    id,
    persistenceScopeId,
    input: {
      ...input,
      sourceElementIds: [...input.sourceElementIds],
      assets: input.assets.map((asset) => ({ ...asset })),
    },
    taskOrder: tasks.map((task) => task.id),
    tasks: Object.fromEntries(tasks.map((task) => [task.id, task])),
    concurrency: Math.max(1, Math.min(MANY_MINDS_MAX_TASKS, concurrency)),
    status: "idle",
    createdAt: now,
    updatedAt: now,
    parentTaskId,
  };
};
