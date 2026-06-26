/**
 * SupabaseAssetStorage - private Storage bucket + public.assets metadata.
 *
 * Binary data lives in the private `excalidraw-assets` bucket. The table only
 * stores ownership, scene/file binding, storage path, and lightweight metadata.
 */

import { t } from "@excalidraw/excalidraw/i18n";

import { BackendError } from "../errors";

import {
  assetUploadToUpsert,
  rowToAssetRef,
  type AssetRow,
} from "./assetMappers";
import { getSupabaseClient } from "./client";
import { mapDataError, mapStorageError } from "./errorMapping";

import type { AssetRef, AssetStorage, AssetType } from "../types";

const TABLE = "assets";
const BUCKET = "excalidraw-assets";
const SIGNED_URL_TTL_SECONDS = 60 * 60;
const ASSET_COLUMNS =
  "id,owner_id,scene_id,file_id,type,storage_path,mime_type,bytes,created_at,updated_at,deleted_at";

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

const getMimeType = (blob: Blob, fallback?: string): string =>
  blob.type || fallback || "application/octet-stream";

const createFallbackId = (): string => {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (randomUUID) {
    return randomUUID.call(globalThis.crypto);
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const createStoragePath = (input: {
  ownerId: string;
  sceneId: string | null;
  fileId: string;
}): string =>
  `${input.ownerId}/${input.sceneId ?? "_unscoped"}/${input.fileId}`;

const createSignedUrl = async (storagePath: string): Promise<string> => {
  const client = getSupabaseClient();
  const { data, error } = await client.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) {
    throw mapStorageError(error);
  }
  return data.signedUrl;
};

const rowWithUrlToAssetRef = async (row: AssetRow): Promise<AssetRef> =>
  rowToAssetRef(row, await createSignedUrl(row.storage_path));

export const createSupabaseAssetStorage = (): AssetStorage => {
  const upload = async (input: {
    blob: Blob;
    type: AssetType;
    sceneId?: string;
    fileId?: string;
    mimeType?: string;
  }): Promise<AssetRef> => {
    const ownerId = await requireOwnerId();
    const sceneId = input.sceneId ?? null;
    const fileId = input.fileId ?? createFallbackId();
    const mimeType = getMimeType(input.blob, input.mimeType);
    const storagePath = createStoragePath({ ownerId, sceneId, fileId });
    const client = getSupabaseClient();

    const { error: uploadError } = await client.storage
      .from(BUCKET)
      .upload(storagePath, input.blob, {
        contentType: mimeType,
        upsert: true,
      });
    if (uploadError) {
      throw mapStorageError(uploadError);
    }

    const { data, error } = await client
      .from(TABLE)
      .upsert(
        assetUploadToUpsert({
          ownerId,
          sceneId,
          fileId,
          type: input.type,
          storagePath,
          mimeType,
          bytes: input.blob.size,
        }),
        { onConflict: "owner_id,scene_id,file_id" },
      )
      .select(ASSET_COLUMNS)
      .single();
    if (error || !data) {
      throw mapDataError(error);
    }

    return rowWithUrlToAssetRef(data as AssetRow);
  };

  const getUrl = async (id: string): Promise<string> => {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from(TABLE)
      .select("storage_path")
      .eq("id", id)
      .is("deleted_at", null)
      .single();
    if (error || !data) {
      throw mapDataError(error);
    }
    return createSignedUrl((data as { storage_path: string }).storage_path);
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

  const listByScene = async (sceneId: string): Promise<AssetRef[]> => {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from(TABLE)
      .select(ASSET_COLUMNS)
      .eq("scene_id", sceneId)
      .is("deleted_at", null)
      .order("created_at", { ascending: true });
    if (error || !data) {
      throw mapDataError(error);
    }

    return Promise.all((data as AssetRow[]).map(rowWithUrlToAssetRef));
  };

  return { upload, getUrl, remove, listByScene };
};
