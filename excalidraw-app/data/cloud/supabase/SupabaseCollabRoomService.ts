/**
 * SupabaseCollabRoomService - Phase 4B cloud scene ↔ collaboration room
 * binding. It stores room ids only; room keys stay client-side in URL hashes.
 */

import { t } from "@excalidraw/excalidraw/i18n";

import { BackendError } from "../errors";

import {
  collabRoomCreateToInsert,
  rowToCollabRoomRecord,
  type CollabRoomRow,
} from "./collabRoomMappers";
import { getSupabaseClient } from "./client";
import { mapDataError } from "./errorMapping";

import type {
  CollabRoomCreateInput,
  CollabRoomRecord,
  CollabRoomService,
} from "../types";

const TABLE = "collab_rooms";
const COLUMNS =
  "id,owner_id,scene_id,room_id,status,created_at,updated_at,revoked_at";

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

export const createSupabaseCollabRoomService = (): CollabRoomService => {
  const createForScene = async (
    input: CollabRoomCreateInput,
  ): Promise<CollabRoomRecord> => {
    const ownerId = await requireOwnerId();
    const client = getSupabaseClient();
    const { data, error } = await client
      .from(TABLE)
      .insert(collabRoomCreateToInsert(input, ownerId))
      .select(COLUMNS)
      .single();
    if (error || !data) {
      throw mapDataError(error);
    }
    return rowToCollabRoomRecord(data as CollabRoomRow);
  };

  const getByScene = async (
    sceneId: string,
  ): Promise<CollabRoomRecord | null> => {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from(TABLE)
      .select(COLUMNS)
      .eq("scene_id", sceneId)
      .eq("status", "active")
      .is("revoked_at", null)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      throw mapDataError(error);
    }
    return data ? rowToCollabRoomRecord(data as CollabRoomRow) : null;
  };

  const getByRoomId = async (
    roomId: string,
  ): Promise<CollabRoomRecord | null> => {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from(TABLE)
      .select(COLUMNS)
      .eq("room_id", roomId)
      .eq("status", "active")
      .is("revoked_at", null)
      .maybeSingle();
    if (error) {
      throw mapDataError(error);
    }
    return data ? rowToCollabRoomRecord(data as CollabRoomRow) : null;
  };

  const revoke = async (id: string): Promise<void> => {
    const client = getSupabaseClient();
    const { error } = await client
      .from(TABLE)
      .update({
        status: "revoked",
        revoked_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("status", "active");
    if (error) {
      throw mapDataError(error);
    }
  };

  const touch = async (id: string): Promise<CollabRoomRecord> => {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from(TABLE)
      .update({ updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "active")
      .is("revoked_at", null)
      .select(COLUMNS)
      .single();
    if (error || !data) {
      throw mapDataError(error);
    }
    return rowToCollabRoomRecord(data as CollabRoomRow);
  };

  return {
    isAvailable: () => true,
    createForScene,
    getByScene,
    getByRoomId,
    revoke,
    touch,
  };
};
