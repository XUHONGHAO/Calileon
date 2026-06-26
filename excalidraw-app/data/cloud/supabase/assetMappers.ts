import type { AssetRef, AssetType } from "../types";

export interface AssetRow {
  id: string;
  owner_id: string;
  scene_id: string | null;
  file_id: string | null;
  type: AssetType;
  storage_path: string;
  mime_type: string | null;
  bytes: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export type AssetUpsertRow = Pick<
  AssetRow,
  | "owner_id"
  | "scene_id"
  | "file_id"
  | "type"
  | "storage_path"
  | "mime_type"
  | "bytes"
> & { deleted_at: null };

const toEpochMs = (value: string | null): number => {
  if (!value) {
    return 0;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
};

export const rowToAssetRef = (row: AssetRow, url: string): AssetRef => ({
  id: row.id,
  ownerId: row.owner_id,
  sceneId: row.scene_id,
  fileId: row.file_id ?? undefined,
  type: row.type,
  url,
  mimeType: row.mime_type ?? undefined,
  bytes: row.bytes,
  createdAt: toEpochMs(row.created_at),
  updatedAt: toEpochMs(row.updated_at),
});

export const assetUploadToUpsert = (input: {
  ownerId: string;
  sceneId: string | null;
  fileId: string;
  type: AssetType;
  storagePath: string;
  mimeType: string;
  bytes: number;
}): AssetUpsertRow => ({
  owner_id: input.ownerId,
  scene_id: input.sceneId,
  file_id: input.fileId,
  type: input.type,
  storage_path: input.storagePath,
  mime_type: input.mimeType,
  bytes: input.bytes,
  deleted_at: null,
});
