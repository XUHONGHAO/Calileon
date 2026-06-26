import type { AITaskCreateInput, AITaskRecord, AITaskStatus } from "../types";

export interface AITaskRow {
  id: string;
  owner_id: string;
  scene_id: string;
  feature_source: string;
  media_type: "image" | "video" | "audio";
  mode: string;
  status: AITaskStatus;
  model_id: string;
  model_label: string | null;
  provider_label: string | null;
  prompt_summary: string;
  negative_prompt_summary: string | null;
  params: unknown;
  input_asset_ids: string[] | null;
  output_asset_ids: string[] | null;
  source_element_ids: string[] | null;
  inserted_element_ids: string[] | null;
  error_code: string | null;
  error_message: string | null;
  submitted_at: string;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export type AITaskInsertRow = Omit<
  AITaskRow,
  "id" | "created_at" | "updated_at" | "deleted_at"
> & {
  deleted_at: null;
};

const toEpochMs = (value: string | null): number => {
  if (!value) {
    return 0;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
};

const toIso = (value: number | null): string | null =>
  value == null ? null : new Date(value).toISOString();

const toStringArray = (value: string[] | null): string[] =>
  Array.isArray(value) ? value : [];

export const rowToAITaskRecord = (row: AITaskRow): AITaskRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  sceneId: row.scene_id,
  featureSource: row.feature_source,
  mediaType: row.media_type,
  mode: row.mode,
  status: row.status,
  modelId: row.model_id,
  modelLabel: row.model_label,
  providerLabel: row.provider_label,
  promptSummary: row.prompt_summary,
  negativePromptSummary: row.negative_prompt_summary,
  params: row.params,
  inputAssetIds: toStringArray(row.input_asset_ids),
  outputAssetIds: toStringArray(row.output_asset_ids),
  sourceElementIds: toStringArray(row.source_element_ids),
  insertedElementIds: toStringArray(row.inserted_element_ids),
  errorCode: row.error_code,
  errorMessage: row.error_message,
  submittedAt: toEpochMs(row.submitted_at),
  completedAt: toEpochMs(row.completed_at) || null,
  createdAt: toEpochMs(row.created_at),
  updatedAt: toEpochMs(row.updated_at),
  deletedAt: toEpochMs(row.deleted_at) || null,
});

export const aiTaskCreateToInsert = (
  input: AITaskCreateInput,
  ownerId: string,
): AITaskInsertRow => ({
  owner_id: ownerId,
  scene_id: input.sceneId,
  feature_source: input.featureSource,
  media_type: input.mediaType,
  mode: input.mode,
  status: input.status,
  model_id: input.modelId,
  model_label: input.modelLabel,
  provider_label: input.providerLabel,
  prompt_summary: input.promptSummary,
  negative_prompt_summary: input.negativePromptSummary,
  params: input.params ?? {},
  input_asset_ids: input.inputAssetIds,
  output_asset_ids: input.outputAssetIds,
  source_element_ids: input.sourceElementIds,
  inserted_element_ids: input.insertedElementIds,
  error_code: input.errorCode,
  error_message: input.errorMessage,
  submitted_at: new Date(input.submittedAt).toISOString(),
  completed_at: toIso(input.completedAt),
  deleted_at: null,
});
