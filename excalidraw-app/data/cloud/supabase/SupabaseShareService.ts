import { t } from "@excalidraw/excalidraw/i18n";

import { BackendError } from "../errors";

import {
  assetUploadToUpsert,
  rowToAssetRef,
  type AssetRow,
} from "./assetMappers";
import { getSupabaseClient } from "./client";
import { mapDataError, mapStorageError } from "./errorMapping";
import { rowToSceneRecord, type SceneRow } from "./mappers";

import type {
  AssetRef,
  AssetType,
  SceneRecord,
  ShareLink,
  ShareMode,
  ShareService,
  SharedSceneLoadResult,
} from "../types";

const TABLE = "shares";
const BUCKET = "excalidraw-assets";
const SIGNED_URL_TTL_SECONDS = 60 * 60;

const SHARE_COLUMNS =
  "id,scene_id,owner_id,mode,token,revoked,expires_at,created_at";

interface ShareRow {
  id: string;
  scene_id: string;
  owner_id: string;
  mode: ShareMode;
  token: string;
  revoked: boolean;
  expires_at: string | null;
  created_at: string;
}

interface ShareResolutionRow {
  scene_id: string;
  owner_id: string;
  mode: ShareMode;
}

interface SharedSceneRpcPayload {
  scene: SceneRow;
  mode: ShareMode;
  assets: AssetRow[];
}

const toEpochMs = (value: string | null): number => {
  if (!value) {
    return 0;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
};

const rowToShareLink = (row: ShareRow): ShareLink => ({
  id: row.id,
  sceneId: row.scene_id,
  mode: row.mode,
  token: row.token,
  revoked: row.revoked,
  expiresAt: row.expires_at ? toEpochMs(row.expires_at) : null,
  createdAt: toEpochMs(row.created_at),
});

const createShareToken = (): string => {
  const bytes = new Uint8Array(24);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

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

const createFallbackId = (): string => {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (randomUUID) {
    return randomUUID.call(globalThis.crypto);
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const getMimeType = (blob: Blob, fallback?: string): string =>
  blob.type || fallback || "application/octet-stream";

const createStoragePath = (input: {
  ownerId: string;
  sceneId: string;
  fileId: string;
}): string => `${input.ownerId}/${input.sceneId}/${input.fileId}`;

const mapShareError = (error: unknown): BackendError => {
  const message = (error as { message?: string } | null)?.message ?? "";
  if (message.includes("cloud-share-version-conflict")) {
    return new BackendError(
      "conflict",
      t("cloud.errors.shareVersionConflict"),
      {
        recoverable: true,
        nextAction: t("cloud.errors.nextActionRetry"),
      },
    );
  }
  return mapDataError(error);
};

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

const resolveShareForUpload = async (
  token: string,
): Promise<ShareResolutionRow> => {
  const client = getSupabaseClient();
  const { data, error } = await client.rpc("resolve_cloud_share", {
    p_token: token,
  });
  if (error || !data) {
    throw mapShareError(error);
  }

  const resolution = Array.isArray(data) ? data[0] : data;
  if (!resolution || resolution.mode !== "write") {
    throw new BackendError("forbidden", t("cloud.errors.forbiddenShare"), {
      recoverable: false,
    });
  }
  return resolution as ShareResolutionRow;
};

export const createSupabaseShareService = (): ShareService => {
  const create = async (input: {
    sceneId: string;
    mode: ShareMode;
  }): Promise<ShareLink> => {
    const ownerId = await requireOwnerId();
    const client = getSupabaseClient();
    const { data, error } = await client
      .from(TABLE)
      .insert({
        scene_id: input.sceneId,
        owner_id: ownerId,
        mode: input.mode,
        token: createShareToken(),
      })
      .select(SHARE_COLUMNS)
      .single();
    if (error || !data) {
      throw mapShareError(error);
    }
    return rowToShareLink(data as ShareRow);
  };

  const resolve = async (
    token: string,
  ): Promise<{ sceneId: string; mode: ShareMode }> => {
    const client = getSupabaseClient();
    const { data, error } = await client.rpc("resolve_cloud_share", {
      p_token: token,
    });
    if (error || !data) {
      throw mapShareError(error);
    }
    const resolution = Array.isArray(data) ? data[0] : data;
    return {
      sceneId: (resolution as ShareResolutionRow).scene_id,
      mode: (resolution as ShareResolutionRow).mode,
    };
  };

  const revoke = async (id: string): Promise<void> => {
    const client = getSupabaseClient();
    const { error } = await client
      .from(TABLE)
      .update({ revoked: true })
      .eq("id", id);
    if (error) {
      throw mapShareError(error);
    }
  };

  const listByScene = async (sceneId: string): Promise<ShareLink[]> => {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from(TABLE)
      .select(SHARE_COLUMNS)
      .eq("scene_id", sceneId)
      .order("created_at", { ascending: false });
    if (error || !data) {
      throw mapShareError(error);
    }
    return (data as ShareRow[]).map(rowToShareLink);
  };

  const loadScene = async (token: string): Promise<SharedSceneLoadResult> => {
    const client = getSupabaseClient();
    const { data, error } = await client.rpc("load_shared_scene", {
      p_token: token,
    });
    if (error || !data) {
      throw mapShareError(error);
    }

    const payload = data as SharedSceneRpcPayload;
    return {
      scene: rowToSceneRecord(payload.scene),
      mode: payload.mode,
      assets: await Promise.all(
        (payload.assets ?? []).map((row) => rowWithUrlToAssetRef(row)),
      ),
    };
  };

  const saveScene = async (
    token: string,
    scene: SceneRecord,
  ): Promise<{ id: string; version: number }> => {
    const client = getSupabaseClient();
    const { data, error } = await client.rpc("save_shared_scene", {
      p_token: token,
      p_payload: scene.payload,
      p_title: scene.title,
      p_version: scene.version,
      p_thumbnail_meta: scene.thumbnailMeta ?? null,
    });
    if (error || !data) {
      throw mapShareError(error);
    }

    const row = Array.isArray(data) ? data[0] : data;
    return {
      id: (row as { id: string }).id,
      version: (row as { version: number }).version,
    };
  };

  const uploadAsset = async (input: {
    token: string;
    blob: Blob;
    type: AssetType;
    sceneId: string;
    fileId?: string;
    mimeType?: string;
  }): Promise<AssetRef> => {
    const resolution = await resolveShareForUpload(input.token);
    if (resolution.scene_id !== input.sceneId) {
      throw new BackendError("forbidden", t("cloud.errors.forbiddenShare"), {
        recoverable: false,
      });
    }

    const fileId = input.fileId ?? createFallbackId();
    const mimeType = getMimeType(input.blob, input.mimeType);
    const storagePath = createStoragePath({
      ownerId: resolution.owner_id,
      sceneId: input.sceneId,
      fileId,
    });
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

    const upsertPayload = assetUploadToUpsert({
      ownerId: resolution.owner_id,
      sceneId: input.sceneId,
      fileId,
      type: input.type,
      storagePath,
      mimeType,
      bytes: input.blob.size,
    });
    const { data, error } = await client.rpc("upsert_shared_asset", {
      p_token: input.token,
      p_file_id: upsertPayload.file_id,
      p_type: upsertPayload.type,
      p_storage_path: upsertPayload.storage_path,
      p_mime_type: upsertPayload.mime_type,
      p_bytes: upsertPayload.bytes,
    });
    if (error || !data) {
      throw mapShareError(error);
    }
    const row = Array.isArray(data) ? data[0] : data;
    return rowWithUrlToAssetRef(row as AssetRow);
  };

  return {
    create,
    resolve,
    revoke,
    listByScene,
    loadScene,
    saveScene,
    uploadAsset,
  };
};
