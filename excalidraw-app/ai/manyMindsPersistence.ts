import { AIWorkbenchIndexedDBAdapter } from "../data/AIWorkbenchIndexedDB";

import { sanitizeManyMindsText } from "./manyMindsPerspectives";

import type {
  ManyMindsBatch,
  ManyMindsStoredAsset,
  ManyMindsTask,
} from "./manyMindsTypes";

const STATE_PAYLOAD_ID = "state";

const batchDescriptor = (scopeId: string, batchId: string) => ({
  scopeId,
  revision: batchId,
  kind: "many-minds-batch" as const,
});

const assetDescriptor = (scopeId: string, assetId: string) => ({
  scopeId,
  revision: assetId,
  kind: "many-minds-asset" as const,
});

const sanitizeParams = <TValue extends object>(value: TValue) =>
  Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      typeof entry === "string" ? sanitizeManyMindsText(entry) : entry,
    ]),
  ) as unknown as TValue;

const isStableAssetId = (assetId: string) =>
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(assetId) &&
  !/^https?:/i.test(assetId);

const sanitizeTask = (task: ManyMindsTask): ManyMindsTask => ({
  ...task,
  modelId: sanitizeManyMindsText(task.modelId).slice(0, 200),
  perspective: {
    ...task.perspective,
    name: sanitizeManyMindsText(task.perspective.name),
    prompt: sanitizeManyMindsText(task.perspective.prompt),
    recommendedModelId: task.perspective.recommendedModelId
      ? sanitizeManyMindsText(task.perspective.recommendedModelId)
      : undefined,
    params: task.perspective.params
      ? sanitizeParams(task.perspective.params)
      : undefined,
  },
  params: sanitizeParams(task.params),
  error: task.error
    ? sanitizeManyMindsText(task.error).slice(0, 1000)
    : undefined,
  output: task.output ? { ...task.output } : undefined,
});

const sanitizeBatch = (batch: ManyMindsBatch): ManyMindsBatch => ({
  ...batch,
  persistenceScopeId: sanitizeManyMindsText(batch.persistenceScopeId),
  input: {
    ...batch.input,
    prompt: sanitizeManyMindsText(batch.input.prompt),
    sourceElementIds: [...batch.input.sourceElementIds],
    assets: batch.input.assets.map((asset) => ({ ...asset })),
  },
  taskOrder: [...batch.taskOrder],
  tasks: Object.fromEntries(
    Object.entries(batch.tasks).map(([id, task]) => [id, sanitizeTask(task)]),
  ),
});

const interruptRunningTasks = (batch: ManyMindsBatch): ManyMindsBatch => {
  const interruptedAt = Date.now();
  let changed = false;
  const tasks = Object.fromEntries(
    Object.entries(batch.tasks).map(([id, task]) => {
      if (task.status !== "running") {
        return [id, task];
      }
      changed = true;
      return [
        id,
        {
          ...task,
          status: "interrupted" as const,
          interruptedAt,
          error: "Interrupted by page refresh. Retry explicitly to continue.",
        },
      ];
    }),
  );
  return changed
    ? { ...batch, tasks, status: "interrupted", updatedAt: interruptedAt }
    : batch;
};

export const saveManyMindsBatch = async (
  persistenceScopeId: string,
  batch: ManyMindsBatch,
) => {
  if (batch.persistenceScopeId !== persistenceScopeId) {
    throw new Error("Many Minds batch scope mismatch.");
  }
  if (
    !batch.input.assets.every((asset) => isStableAssetId(asset.assetId)) ||
    !Object.values(batch.tasks).every(
      (task) => !task.output || isStableAssetId(task.output.assetId),
    )
  ) {
    throw new Error("Many Minds batches may only reference stable asset ids.");
  }
  const key = AIWorkbenchIndexedDBAdapter.createRevisionPayloadKey(
    batchDescriptor(persistenceScopeId, batch.id),
    STATE_PAYLOAD_ID,
  );
  await AIWorkbenchIndexedDBAdapter.setMany([[key, sanitizeBatch(batch)]]);
  return key;
};

export const loadManyMindsBatch = async (
  persistenceScopeId: string,
  batchId: string,
) => {
  const key = AIWorkbenchIndexedDBAdapter.createRevisionPayloadKey(
    batchDescriptor(persistenceScopeId, batchId),
    STATE_PAYLOAD_ID,
  );
  const [batch] = await AIWorkbenchIndexedDBAdapter.getMany<ManyMindsBatch>([
    key,
  ]);
  if (!batch || batch.persistenceScopeId !== persistenceScopeId) {
    return null;
  }
  return interruptRunningTasks(sanitizeBatch(batch));
};

export const listManyMindsBatches = async (persistenceScopeId: string) => {
  const prefix = `aiwb:v1:many-minds-batch:${encodeURIComponent(
    persistenceScopeId,
  )}:`;
  const keys = await AIWorkbenchIndexedDBAdapter.listKeys(prefix);
  const batches = await AIWorkbenchIndexedDBAdapter.getMany<ManyMindsBatch>(
    keys,
  );
  return batches
    .filter((batch): batch is ManyMindsBatch => !!batch)
    .filter((batch) => batch.persistenceScopeId === persistenceScopeId)
    .map((batch) => interruptRunningTasks(sanitizeBatch(batch)))
    .sort((a, b) => b.updatedAt - a.updatedAt);
};

export const deleteManyMindsBatch = async (
  persistenceScopeId: string,
  batchId: string,
) => {
  const keys = await AIWorkbenchIndexedDBAdapter.listRevisionKeys(
    batchDescriptor(persistenceScopeId, batchId),
  );
  await AIWorkbenchIndexedDBAdapter.deleteMany(keys);
};

export const saveManyMindsAsset = async (
  persistenceScopeId: string,
  asset: ManyMindsStoredAsset,
) => {
  if (!isStableAssetId(asset.ref.assetId) || !(asset.blob instanceof Blob)) {
    throw new Error("Many Minds assets require a stable id and Blob payload.");
  }
  const key = AIWorkbenchIndexedDBAdapter.createRevisionPayloadKey(
    assetDescriptor(persistenceScopeId, asset.ref.assetId),
    STATE_PAYLOAD_ID,
  );
  await AIWorkbenchIndexedDBAdapter.setMany([[key, asset]]);
  return asset.ref;
};

export const loadManyMindsAsset = async (
  persistenceScopeId: string,
  assetId: string,
) => {
  const key = AIWorkbenchIndexedDBAdapter.createRevisionPayloadKey(
    assetDescriptor(persistenceScopeId, assetId),
    STATE_PAYLOAD_ID,
  );
  const [asset] =
    await AIWorkbenchIndexedDBAdapter.getMany<ManyMindsStoredAsset>([key]);
  return asset?.ref.assetId === assetId ? asset : null;
};

export const deleteManyMindsAsset = async (
  persistenceScopeId: string,
  assetId: string,
) => {
  const keys = await AIWorkbenchIndexedDBAdapter.listRevisionKeys(
    assetDescriptor(persistenceScopeId, assetId),
  );
  await AIWorkbenchIndexedDBAdapter.deleteMany(keys);
};
