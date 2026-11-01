/**
 * Video provider references (ADR 0039 §4). RollDek only fetches public HTTPS
 * URLs, so each reference is uploaded to the private bucket and handed over as
 * a signed URL, then deleted when the task ends.
 *
 * Objects live under `{owner}/ai-video-reference/{file}`. The second folder is
 * never a scene id, so the share/embed storage policies (which match folder
 * [2] against a shared scene) never grant them; the owner policy still does.
 */

import { t } from "@excalidraw/excalidraw/i18n";

import { BackendError } from "../errors";

import { getSupabaseClient } from "./client";
import { mapDataError, mapStorageError } from "./errorMapping";

import type { VideoReferenceService } from "../types";

const TABLE = "assets";
const BUCKET = "excalidraw-assets";
const ASSET_TYPE = "ai-video-reference";
export const VIDEO_REFERENCE_FOLDER = "ai-video-reference";
/** The provider may fetch only after the queue clears; leave headroom. */
export const VIDEO_REFERENCE_URL_TTL_SECONDS = 2 * 60 * 60;

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
};

const requireOwnerId = async (): Promise<string> => {
  const { data, error } = await getSupabaseClient().auth.getUser();
  if (error || !data.user) {
    throw new BackendError("unauthorized", t("cloud.errors.signInRequired"), {
      recoverable: true,
      nextAction: t("cloud.errors.nextActionSignIn"),
    });
  }
  return data.user.id;
};

const createFileId = () => {
  const randomUUID = globalThis.crypto?.randomUUID;
  return randomUUID
    ? randomUUID.call(globalThis.crypto)
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const removeRows = async (rows: { id: string; storage_path: string }[]) => {
  if (!rows.length) {
    return;
  }
  const client = getSupabaseClient();
  const { error: storageError } = await client.storage
    .from(BUCKET)
    .remove(rows.map((row) => row.storage_path));
  if (storageError) {
    throw mapStorageError(storageError);
  }
  const { error } = await client
    .from(TABLE)
    .delete()
    .in(
      "id",
      rows.map((row) => row.id),
    )
    .eq("type", ASSET_TYPE);
  if (error) {
    throw mapDataError(error);
  }
};

export const createSupabaseVideoReferenceService =
  (): VideoReferenceService => ({
    upload: async ({ blob, mimeType, signal }) => {
      throwIfAborted(signal);
      const ownerId = await requireOwnerId();
      const fileId = createFileId();
      const storagePath = `${ownerId}/${VIDEO_REFERENCE_FOLDER}/${fileId}`;
      const client = getSupabaseClient();

      const { error: uploadError } = await client.storage
        .from(BUCKET)
        .upload(storagePath, blob, { contentType: mimeType, upsert: false });
      if (uploadError) {
        throw mapStorageError(uploadError);
      }

      const cleanUpObject = () =>
        client.storage
          .from(BUCKET)
          .remove([storagePath])
          .catch(() => undefined);

      const { data: row, error: rowError } = await client
        .from(TABLE)
        .insert({
          owner_id: ownerId,
          scene_id: null,
          file_id: fileId,
          type: ASSET_TYPE,
          storage_path: storagePath,
          mime_type: mimeType,
          bytes: blob.size,
        })
        .select("id")
        .single();
      if (rowError || !row) {
        await cleanUpObject();
        throw mapDataError(rowError);
      }

      const { data: signed, error: signError } = await client.storage
        .from(BUCKET)
        .createSignedUrl(storagePath, VIDEO_REFERENCE_URL_TTL_SECONDS);
      if (signError || !signed?.signedUrl) {
        await removeRows([
          { id: (row as { id: string }).id, storage_path: storagePath },
        ]).catch(() => undefined);
        throw mapStorageError(signError);
      }

      return {
        assetId: (row as { id: string }).id,
        url: signed.signedUrl,
        expiresAt: Date.now() + VIDEO_REFERENCE_URL_TTL_SECONDS * 1000,
      };
    },

    remove: async (assetIds) => {
      if (!assetIds.length) {
        return;
      }
      const { data, error } = await getSupabaseClient()
        .from(TABLE)
        .select("id,storage_path")
        .in("id", [...assetIds])
        .eq("type", ASSET_TYPE);
      if (error) {
        throw mapDataError(error);
      }
      await removeRows((data || []) as { id: string; storage_path: string }[]);
    },

    removeStale: async (olderThanMs) => {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      const { data, error } = await getSupabaseClient()
        .from(TABLE)
        .select("id,storage_path")
        .eq("type", ASSET_TYPE)
        .lt("created_at", cutoff)
        .limit(100);
      if (error) {
        throw mapDataError(error);
      }
      const rows = (data || []) as { id: string; storage_path: string }[];
      await removeRows(rows);
      return rows.length;
    },
  });
