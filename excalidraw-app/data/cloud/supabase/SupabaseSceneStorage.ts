/**
 * SupabaseSceneStorage — frozen `SceneStorage` over the `public.scenes` table
 * (decision 0006 §4 / 0008 §4.2).
 *
 * - save:   insert when `id` is null (DB backfills id + version), else update
 *           with an optimistic version bump.
 * - load:   single row by id, excluding soft-deleted.
 * - list:   summaries (no heavy payload), newest-updated first.
 * - rename: title-only update (version untouched).
 * - remove: soft delete (`deleted_at = now()`).
 *
 * RLS (`owner_id = auth.uid()`) enforces per-user isolation server-side; the
 * adapter also stamps `owner_id` from the current session on insert so a record
 * can never be created for another user. Errors funnel through `mapDataError`.
 */

import { t } from "@excalidraw/excalidraw/i18n";

import { BackendError } from "../errors";

import { getSupabaseClient } from "./client";
import { mapDataError } from "./errorMapping";
import {
  rowToSceneRecord,
  rowToSceneSummary,
  sceneRecordToInsert,
  sceneRecordToUpdate,
} from "./mappers";

import type { SceneRow, SceneSummaryRow } from "./mappers";
import type { SceneRecord, SceneStorage, SceneSummary } from "../types";

const TABLE = "scenes";
const SUMMARY_COLUMNS = "id,title,version,updated_at,thumbnail_meta";

const requireOwnerId = async (): Promise<string> => {
  const client = getSupabaseClient();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) {
    throw new BackendError("unauthorized", t("cloud.errors.signInRequired"), {
      recoverable: true,
      nextAction: t("cloud.errors.nextActionSignIn"),
    });
  }
  return data.user.id;
};

export const createSupabaseSceneStorage = (): SceneStorage => {
  const insertScene = async (
    scene: SceneRecord,
  ): Promise<{ id: string; version: number }> => {
    const ownerId = await requireOwnerId();
    const client = getSupabaseClient();
    const { data, error } = await client
      .from(TABLE)
      .insert(sceneRecordToInsert(scene, ownerId))
      .select("id,version")
      .single();
    if (error || !data) {
      throw mapDataError(error);
    }
    return { id: data.id as string, version: data.version as number };
  };

  const updateScene = async (
    scene: SceneRecord & { id: string },
  ): Promise<{ id: string; version: number }> => {
    const client = getSupabaseClient();
    const nextVersion = scene.version + 1;
    const { data, error } = await client
      .from(TABLE)
      .update(sceneRecordToUpdate(scene, nextVersion))
      .eq("id", scene.id)
      .is("deleted_at", null)
      .select("id,version")
      .single();
    if (error || !data) {
      throw mapDataError(error);
    }
    return { id: data.id as string, version: data.version as number };
  };

  const save = async (
    scene: SceneRecord,
  ): Promise<{ id: string; version: number }> => {
    if (scene.id == null) {
      return insertScene(scene);
    }
    return updateScene(scene as SceneRecord & { id: string });
  };

  const load = async (id: string): Promise<SceneRecord> => {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from(TABLE)
      .select("*")
      .eq("id", id)
      .is("deleted_at", null)
      .single();
    if (error || !data) {
      throw mapDataError(error);
    }
    return rowToSceneRecord(data as SceneRow);
  };

  const list = async (opts?: {
    sort?: "updatedAt";
  }): Promise<SceneSummary[]> => {
    const client = getSupabaseClient();
    // Only "updatedAt" sort is in the frozen contract; default to it.
    void opts;
    const { data, error } = await client
      .from(TABLE)
      .select(SUMMARY_COLUMNS)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false });
    if (error || !data) {
      throw mapDataError(error);
    }
    return (data as SceneSummaryRow[]).map(rowToSceneSummary);
  };

  const rename = async (id: string, title: string): Promise<void> => {
    const client = getSupabaseClient();
    const { error } = await client
      .from(TABLE)
      .update({ title })
      .eq("id", id)
      .is("deleted_at", null);
    if (error) {
      throw mapDataError(error);
    }
  };

  const remove = async (id: string): Promise<void> => {
    const client = getSupabaseClient();
    const { error } = await client
      .from(TABLE)
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id)
      .is("deleted_at", null);
    if (error) {
      throw mapDataError(error);
    }
  };

  return { save, load, list, rename, remove };
};
