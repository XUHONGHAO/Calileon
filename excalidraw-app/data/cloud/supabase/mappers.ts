/**
 * Row ↔ domain mappers (decision 0008 §2, §4).
 *
 * Postgres columns are snake_case (PG convention); the frozen contract
 * (`SceneRecord` / `SceneSummary`, decision 0006 §3) is camelCase. All
 * conversion lives here so the storage adapter stays declarative and the
 * column-name coupling is in one place.
 */

import type { ScenePayloadKind, SceneRecord, SceneSummary } from "../types";

/** Shape of a `public.scenes` row (see supabase/schema.sql). */
export interface SceneRow {
  id: string;
  owner_id: string;
  title: string;
  payload_kind: string;
  payload: unknown;
  version: number;
  thumbnail_meta: SceneRecord["thumbnailMeta"] | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** Columns selected for list views (no heavy `payload`). */
export type SceneSummaryRow = Pick<
  SceneRow,
  "id" | "title" | "version" | "updated_at" | "thumbnail_meta"
>;

const toEpochMs = (value: string | null): number => {
  if (!value) {
    return 0;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
};

const toPayloadKind = (value: string): ScenePayloadKind =>
  value === "encrypted" ? "encrypted" : "plain";

/** Full row → `SceneRecord`. */
export const rowToSceneRecord = (row: SceneRow): SceneRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  title: row.title,
  payloadKind: toPayloadKind(row.payload_kind),
  payload: row.payload,
  version: row.version,
  thumbnailMeta: row.thumbnail_meta ?? undefined,
  createdAt: toEpochMs(row.created_at),
  updatedAt: toEpochMs(row.updated_at),
  deletedAt: row.deleted_at ? toEpochMs(row.deleted_at) : null,
});

/** Summary row → `SceneSummary`. */
export const rowToSceneSummary = (row: SceneSummaryRow): SceneSummary => ({
  id: row.id,
  title: row.title,
  version: row.version,
  updatedAt: toEpochMs(row.updated_at),
  thumbnailMeta: row.thumbnail_meta ?? undefined,
});

/**
 * `SceneRecord` → insert payload (new scene: no id, version handled by DB
 * default). `owner_id` is injected by the adapter from the current session so
 * callers cannot spoof it.
 */
export const sceneRecordToInsert = (
  scene: SceneRecord,
  ownerId: string,
): Omit<
  SceneRow,
  "id" | "version" | "created_at" | "updated_at" | "deleted_at"
> => ({
  owner_id: ownerId,
  title: scene.title,
  payload_kind: scene.payloadKind,
  payload: scene.payload,
  thumbnail_meta: scene.thumbnailMeta ?? null,
});

/**
 * `SceneRecord` → update payload (existing scene). `owner_id`/`created_at` are
 * never updated; `version` is bumped by the adapter (optimistic increment,
 * decision 0008 §3).
 */
export const sceneRecordToUpdate = (
  scene: SceneRecord,
  nextVersion: number,
): Pick<
  SceneRow,
  "title" | "payload_kind" | "payload" | "version" | "thumbnail_meta"
> => ({
  title: scene.title,
  payload_kind: scene.payloadKind,
  payload: scene.payload,
  version: nextVersion,
  thumbnail_meta: scene.thumbnailMeta ?? null,
});
