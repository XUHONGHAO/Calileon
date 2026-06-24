import type {
  CastExportCreateInput,
  CastExportRecord,
  CastExportType,
  CastScriptAttachInput,
  CastSessionCreateInput,
  CastSessionRecord,
  CastSessionStatus,
} from "../types";

export interface CastSessionRow {
  id: string;
  owner_id: string;
  scene_id: string;
  title: string;
  status: CastSessionStatus;
  script_asset_id: string | null;
  cover_asset_id: string | null;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export type CastSessionInsertRow = Pick<
  CastSessionRow,
  | "owner_id"
  | "scene_id"
  | "title"
  | "status"
  | "script_asset_id"
  | "cover_asset_id"
  | "duration_ms"
> & { deleted_at: null };

export type CastSessionUpdateRow = Partial<
  Pick<
    CastSessionRow,
    "status" | "script_asset_id" | "cover_asset_id" | "duration_ms"
  >
>;

export interface CastExportRow {
  id: string;
  owner_id: string;
  scene_id: string;
  session_id: string;
  asset_id: string;
  type: CastExportType;
  label: string | null;
  mime_type: string | null;
  bytes: number;
  created_at: string;
  deleted_at: string | null;
}

export type CastExportInsertRow = Omit<CastExportRow, "id" | "created_at"> & {
  deleted_at: null;
};

const toEpochMs = (value: string | null): number => {
  if (!value) {
    return 0;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
};

export const rowToCastSessionRecord = (
  row: CastSessionRow,
): CastSessionRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  sceneId: row.scene_id,
  title: row.title,
  status: row.status,
  scriptAssetId: row.script_asset_id,
  coverAssetId: row.cover_asset_id,
  durationMs: row.duration_ms,
  createdAt: toEpochMs(row.created_at),
  updatedAt: toEpochMs(row.updated_at),
  deletedAt: toEpochMs(row.deleted_at) || null,
});

export const castSessionCreateToInsert = (
  input: CastSessionCreateInput,
  ownerId: string,
): CastSessionInsertRow => ({
  owner_id: ownerId,
  scene_id: input.sceneId,
  title: input.title,
  status: input.status ?? "draft",
  script_asset_id: input.scriptAssetId ?? null,
  cover_asset_id: input.coverAssetId ?? null,
  duration_ms: input.durationMs ?? null,
  deleted_at: null,
});

export const castScriptAttachToUpdate = (
  input: CastScriptAttachInput,
): CastSessionUpdateRow => ({
  status: "ready",
  script_asset_id: input.scriptAssetId,
  ...(input.coverAssetId !== undefined
    ? { cover_asset_id: input.coverAssetId }
    : {}),
  ...(input.durationMs !== undefined ? { duration_ms: input.durationMs } : {}),
});

export const rowToCastExportRecord = (
  row: CastExportRow,
): CastExportRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  sceneId: row.scene_id,
  sessionId: row.session_id,
  assetId: row.asset_id,
  type: row.type,
  label: row.label,
  mimeType: row.mime_type,
  bytes: row.bytes,
  createdAt: toEpochMs(row.created_at),
  deletedAt: toEpochMs(row.deleted_at) || null,
});

export const castExportCreateToInsert = (
  input: CastExportCreateInput,
  ownerId: string,
): CastExportInsertRow => ({
  owner_id: ownerId,
  scene_id: input.sceneId,
  session_id: input.sessionId,
  asset_id: input.assetId,
  type: input.type,
  label: input.label,
  mime_type: input.mimeType,
  bytes: input.bytes,
  deleted_at: null,
});
