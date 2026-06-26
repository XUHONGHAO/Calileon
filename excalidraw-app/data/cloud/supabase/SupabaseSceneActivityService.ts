import { t } from "@excalidraw/excalidraw/i18n";

import { BackendError } from "../errors";

import { getSupabaseClient } from "./client";
import { mapDataError } from "./errorMapping";
import {
  rowToSceneActivityRecord,
  sceneActivityToInsert,
} from "./activityMappers";

import type { SceneActivityRow } from "./activityMappers";
import type {
  SceneActivityCreateInput,
  SceneActivityRecord,
  SceneActivityService,
} from "../types";

const TABLE = "activity_log";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

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

const normalizeLimit = (limit: number | undefined) =>
  Math.max(1, Math.min(MAX_LIMIT, limit ?? DEFAULT_LIMIT));

export const createSupabaseSceneActivityService = (): SceneActivityService => {
  const create = async (
    input: SceneActivityCreateInput,
  ): Promise<SceneActivityRecord> => {
    const ownerId = await requireOwnerId();
    const client = getSupabaseClient();
    const { data, error } = await client
      .from(TABLE)
      .insert(sceneActivityToInsert(input, ownerId))
      .select("*")
      .single();
    if (error || !data) {
      throw mapDataError(error);
    }
    return rowToSceneActivityRecord(data as SceneActivityRow);
  };

  const listByScene = async (
    sceneId: string,
    opts?: { limit?: number },
  ): Promise<SceneActivityRecord[]> => {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from(TABLE)
      .select("*")
      .eq("scene_id", sceneId)
      .order("created_at", { ascending: false })
      .limit(normalizeLimit(opts?.limit));
    if (error || !data) {
      throw mapDataError(error);
    }
    return (data as SceneActivityRow[]).map(rowToSceneActivityRecord);
  };

  return { create, listByScene };
};
