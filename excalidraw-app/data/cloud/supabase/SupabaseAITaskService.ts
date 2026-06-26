/**
 * SupabaseAITaskService - owner-scoped AI generation task metadata.
 *
 * This indexes browser-direct AI workbench runs for cloud whiteboards. It does
 * not proxy AI calls and must never persist provider credentials.
 */

import { t } from "@excalidraw/excalidraw/i18n";

import { BackendError } from "../errors";

import {
  aiTaskCreateToInsert,
  rowToAITaskRecord,
  type AITaskRow,
} from "./aiTaskMappers";
import { getSupabaseClient } from "./client";
import { mapDataError } from "./errorMapping";

import type { AITaskCreateInput, AITaskRecord, AITaskService } from "../types";

const TABLE = "ai_tasks";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const AI_TASK_COLUMNS =
  "id,owner_id,scene_id,feature_source,media_type,mode,status,model_id,model_label,provider_label,prompt_summary,negative_prompt_summary,params,input_asset_ids,output_asset_ids,source_element_ids,inserted_element_ids,error_code,error_message,submitted_at,completed_at,created_at,updated_at,deleted_at";

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

const clampLimit = (limit: number | undefined): number => {
  if (!Number.isFinite(limit) || !limit) {
    return DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
};

export const createSupabaseAITaskService = (): AITaskService => {
  const create = async (input: AITaskCreateInput): Promise<AITaskRecord> => {
    const ownerId = await requireOwnerId();
    const client = getSupabaseClient();
    const { data, error } = await client
      .from(TABLE)
      .insert(aiTaskCreateToInsert(input, ownerId))
      .select(AI_TASK_COLUMNS)
      .single();
    if (error || !data) {
      throw mapDataError(error);
    }

    return rowToAITaskRecord(data as AITaskRow);
  };

  const list = async (opts?: {
    sceneId?: string;
    limit?: number;
  }): Promise<AITaskRecord[]> => {
    const client = getSupabaseClient();
    let query = client
      .from(TABLE)
      .select(AI_TASK_COLUMNS)
      .is("deleted_at", null)
      .order("submitted_at", { ascending: false })
      .limit(clampLimit(opts?.limit));

    if (opts?.sceneId) {
      query = query.eq("scene_id", opts.sceneId);
    }

    const { data, error } = await query;
    if (error || !data) {
      throw mapDataError(error);
    }

    return (data as AITaskRow[]).map(rowToAITaskRecord);
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

  return { create, list, remove };
};
