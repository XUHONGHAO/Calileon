/**
 * SupabaseCastService - Phase 3B cast session/export metadata.
 *
 * This registers playback scripts and exported artifacts only. It does not
 * implement recording capture, playback, or server-side video transcoding.
 */

import { t } from "@excalidraw/excalidraw/i18n";

import { BackendError } from "../errors";

import {
  castExportCreateToInsert,
  castScriptAttachToUpdate,
  castSessionCreateToInsert,
  rowToCastExportRecord,
  rowToCastSessionRecord,
  type CastExportRow,
  type CastSessionRow,
} from "./castMappers";
import { getSupabaseClient } from "./client";
import { mapDataError } from "./errorMapping";

import type {
  CastExportCreateInput,
  CastExportRecord,
  CastScriptAttachInput,
  CastService,
  CastSessionCreateInput,
  CastSessionRecord,
} from "../types";

const SESSIONS_TABLE = "cast_sessions";
const EXPORTS_TABLE = "cast_exports";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const CAST_SESSION_COLUMNS =
  "id,owner_id,scene_id,title,status,script_asset_id,cover_asset_id,duration_ms,created_at,updated_at,deleted_at";
const CAST_EXPORT_COLUMNS =
  "id,owner_id,scene_id,session_id,asset_id,type,label,mime_type,bytes,created_at,deleted_at";

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

const normalizeLimit = (limit: number | undefined): number => {
  if (!Number.isFinite(limit) || !limit) {
    return DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
};

export const createSupabaseCastService = (): CastService => {
  const createSession = async (
    input: CastSessionCreateInput,
  ): Promise<CastSessionRecord> => {
    const ownerId = await requireOwnerId();
    const client = getSupabaseClient();
    const { data, error } = await client
      .from(SESSIONS_TABLE)
      .insert(castSessionCreateToInsert(input, ownerId))
      .select(CAST_SESSION_COLUMNS)
      .single();
    if (error || !data) {
      throw mapDataError(error);
    }
    return rowToCastSessionRecord(data as CastSessionRow);
  };

  const listByScene = async (
    sceneId: string,
    opts?: { limit?: number },
  ): Promise<CastSessionRecord[]> => {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from(SESSIONS_TABLE)
      .select(CAST_SESSION_COLUMNS)
      .eq("scene_id", sceneId)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(normalizeLimit(opts?.limit));
    if (error || !data) {
      throw mapDataError(error);
    }
    return (data as CastSessionRow[]).map(rowToCastSessionRecord);
  };

  const attachScript = async (
    sessionId: string,
    input: CastScriptAttachInput,
  ): Promise<CastSessionRecord> => {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from(SESSIONS_TABLE)
      .update(castScriptAttachToUpdate(input))
      .eq("id", sessionId)
      .is("deleted_at", null)
      .select(CAST_SESSION_COLUMNS)
      .single();
    if (error || !data) {
      throw mapDataError(error);
    }
    return rowToCastSessionRecord(data as CastSessionRow);
  };

  const registerExport = async (
    input: CastExportCreateInput,
  ): Promise<CastExportRecord> => {
    const ownerId = await requireOwnerId();
    const client = getSupabaseClient();
    const { data, error } = await client
      .from(EXPORTS_TABLE)
      .insert(castExportCreateToInsert(input, ownerId))
      .select(CAST_EXPORT_COLUMNS)
      .single();
    if (error || !data) {
      throw mapDataError(error);
    }

    const { error: statusError } = await client
      .from(SESSIONS_TABLE)
      .update({ status: "exported" })
      .eq("id", input.sessionId)
      .is("deleted_at", null);
    if (statusError) {
      throw mapDataError(statusError);
    }

    return rowToCastExportRecord(data as CastExportRow);
  };

  const listExportsByScene = async (
    sceneId: string,
    opts?: { limit?: number },
  ): Promise<CastExportRecord[]> => {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from(EXPORTS_TABLE)
      .select(CAST_EXPORT_COLUMNS)
      .eq("scene_id", sceneId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(normalizeLimit(opts?.limit));
    if (error || !data) {
      throw mapDataError(error);
    }
    return (data as CastExportRow[]).map(rowToCastExportRecord);
  };

  const remove = async (sessionId: string): Promise<void> => {
    const deletedAt = new Date().toISOString();
    const client = getSupabaseClient();

    const { error: exportError } = await client
      .from(EXPORTS_TABLE)
      .update({ deleted_at: deletedAt })
      .eq("session_id", sessionId)
      .is("deleted_at", null);
    if (exportError) {
      throw mapDataError(exportError);
    }

    const { error } = await client
      .from(SESSIONS_TABLE)
      .update({ deleted_at: deletedAt, status: "archived" })
      .eq("id", sessionId)
      .is("deleted_at", null);
    if (error) {
      throw mapDataError(error);
    }
  };

  return {
    isAvailable: () => true,
    createSession,
    listByScene,
    attachScript,
    registerExport,
    listExportsByScene,
    remove,
  };
};
