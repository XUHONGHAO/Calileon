import { t } from "@excalidraw/excalidraw/i18n";

import { BackendError } from "../errors";
import { normalizeEmbedOrigin } from "../embedOrigin";

import {
  assetUploadToUpsert,
  rowToAssetRef,
  type AssetRow,
} from "./assetMappers";
import { getSupabaseClient } from "./client";
import {
  embedCreateToInsert,
  embedUpdateToUpdate,
  rowToEmbedRecord,
  type EmbedRow,
} from "./embedMappers";
import { mapDataError, mapStorageError } from "./errorMapping";
import { rowToSceneRecord, type SceneRow } from "./mappers";

import type {
  AssetRef,
  AssetType,
  EmbeddedSceneLoadResult,
  EmbedCreateInput,
  EmbedMode,
  EmbedResolution,
  EmbedService,
  EmbedUpdateInput,
  SceneRecord,
} from "../types";

const TABLE = "embeds";
const BUCKET = "excalidraw-assets";
const SIGNED_URL_TTL_SECONDS = 60 * 60;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const EMBED_COLUMNS =
  "id,owner_id,scene_id,mode,token,allowed_origins,theme,size,revoked,created_at,updated_at";

interface EmbedResolutionRow {
  scene_id: string;
  owner_id: string;
  mode: EmbedMode;
  allowed_origins: string[];
  theme: "light" | "dark" | "system";
  size: "responsive" | "wide" | "compact";
}

interface EmbeddedSceneRpcPayload {
  scene: SceneRow;
  mode: EmbedMode;
  allowed_origins: string[];
  theme: "light" | "dark" | "system";
  size: "responsive" | "wide" | "compact";
  assets: AssetRow[];
}

const createEmbedToken = (): string => {
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

const createFallbackId = (): string => {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (randomUUID) {
    return randomUUID.call(globalThis.crypto);
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

const normalizeLimit = (limit: number | undefined): number => {
  if (!Number.isFinite(limit) || !limit) {
    return DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
};

const requireOrigin = (origin: string): string => {
  const normalized = normalizeEmbedOrigin(origin);
  if (!normalized) {
    throw new BackendError("forbidden", t("cloud.embed.forbiddenOrigin"), {
      recoverable: false,
    });
  }
  return normalized;
};

const requireAllowedOrigins = (origins: string[]): void => {
  if (origins.length === 0) {
    throw new BackendError("forbidden", t("cloud.embed.originRequired"), {
      recoverable: true,
    });
  }
};

const getMimeType = (blob: Blob, fallback?: string): string =>
  blob.type || fallback || "application/octet-stream";

const createStoragePath = (input: {
  ownerId: string;
  sceneId: string;
  fileId: string;
}): string => `${input.ownerId}/${input.sceneId}/${input.fileId}`;

const mapEmbedError = (error: unknown): BackendError => {
  const message = (error as { message?: string } | null)?.message ?? "";
  if (message.includes("cloud-embed-version-conflict")) {
    return new BackendError(
      "conflict",
      t("cloud.errors.shareVersionConflict"),
      {
        recoverable: true,
        nextAction: t("cloud.errors.nextActionRetry"),
      },
    );
  }
  if (message.includes("cloud-embed-forbidden")) {
    return new BackendError("forbidden", t("cloud.embed.forbiddenOrigin"), {
      recoverable: false,
    });
  }
  return mapDataError(error);
};

const createForbiddenEmbedError = (): BackendError =>
  new BackendError("forbidden", t("cloud.embed.forbiddenOrigin"), {
    recoverable: false,
  });

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

const toResolution = (row: EmbedResolutionRow): EmbedResolution => ({
  sceneId: row.scene_id,
  mode: row.mode,
  allowedOrigins: row.allowed_origins,
  theme: row.theme,
  size: row.size,
});

const resolveEmbedForUpload = async (
  token: string,
  origin: string,
): Promise<EmbedResolutionRow> => {
  const client = getSupabaseClient();
  const { data, error } = await client.rpc("resolve_cloud_embed", {
    p_token: token,
    p_origin: requireOrigin(origin),
  });
  if (error || !data) {
    throw mapEmbedError(error);
  }

  const resolution = Array.isArray(data) ? data[0] : data;
  if (!resolution) {
    throw createForbiddenEmbedError();
  }
  if (resolution.mode !== "write") {
    throw new BackendError("forbidden", t("cloud.embed.readOnly"), {
      recoverable: false,
    });
  }
  return resolution as EmbedResolutionRow;
};

export const createSupabaseEmbedService = (): EmbedService => {
  const create = async (input: EmbedCreateInput) => {
    const ownerId = await requireOwnerId();
    const insert = embedCreateToInsert(input, ownerId, createEmbedToken());
    requireAllowedOrigins(insert.allowed_origins);

    const client = getSupabaseClient();
    const { data, error } = await client
      .from(TABLE)
      .insert(insert)
      .select(EMBED_COLUMNS)
      .single();
    if (error || !data) {
      throw mapEmbedError(error);
    }
    return rowToEmbedRecord(data as EmbedRow);
  };

  const listByScene = async (sceneId: string, opts?: { limit?: number }) => {
    const client = getSupabaseClient();
    const { data, error } = await client
      .from(TABLE)
      .select(EMBED_COLUMNS)
      .eq("scene_id", sceneId)
      .order("created_at", { ascending: false })
      .limit(normalizeLimit(opts?.limit));
    if (error || !data) {
      throw mapEmbedError(error);
    }
    return (data as EmbedRow[]).map(rowToEmbedRecord);
  };

  const update = async (id: string, input: EmbedUpdateInput) => {
    const updatePayload = embedUpdateToUpdate(input);
    if (updatePayload.allowed_origins) {
      requireAllowedOrigins(updatePayload.allowed_origins);
    }

    const client = getSupabaseClient();
    const { data, error } = await client
      .from(TABLE)
      .update(updatePayload)
      .eq("id", id)
      .select(EMBED_COLUMNS)
      .single();
    if (error || !data) {
      throw mapEmbedError(error);
    }
    return rowToEmbedRecord(data as EmbedRow);
  };

  const revoke = async (id: string): Promise<void> => {
    const client = getSupabaseClient();
    const { error } = await client
      .from(TABLE)
      .update({ revoked: true })
      .eq("id", id);
    if (error) {
      throw mapEmbedError(error);
    }
  };

  const resolve = async (
    token: string,
    origin: string,
  ): Promise<EmbedResolution> => {
    const client = getSupabaseClient();
    const { data, error } = await client.rpc("resolve_cloud_embed", {
      p_token: token,
      p_origin: requireOrigin(origin),
    });
    if (error || !data) {
      throw mapEmbedError(error);
    }
    const resolution = Array.isArray(data) ? data[0] : data;
    if (!resolution) {
      throw createForbiddenEmbedError();
    }
    return toResolution(resolution as EmbedResolutionRow);
  };

  const loadScene = async (
    token: string,
    origin: string,
  ): Promise<EmbeddedSceneLoadResult> => {
    const client = getSupabaseClient();
    const { data, error } = await client.rpc("load_embedded_scene", {
      p_token: token,
      p_origin: requireOrigin(origin),
    });
    if (error || !data) {
      throw mapEmbedError(error);
    }

    const payload = data as EmbeddedSceneRpcPayload;
    if (!payload.scene) {
      throw createForbiddenEmbedError();
    }
    return {
      scene: rowToSceneRecord(payload.scene),
      mode: payload.mode,
      assets: await Promise.all(
        (payload.assets ?? []).map((row) => rowWithUrlToAssetRef(row)),
      ),
      embed: {
        sceneId: payload.scene.id,
        mode: payload.mode,
        allowedOrigins: payload.allowed_origins,
        theme: payload.theme,
        size: payload.size,
      },
    };
  };

  const saveScene = async (
    token: string,
    origin: string,
    scene: SceneRecord,
  ): Promise<{ id: string; version: number }> => {
    const client = getSupabaseClient();
    const { data, error } = await client.rpc("save_embedded_scene", {
      p_token: token,
      p_origin: requireOrigin(origin),
      p_payload: scene.payload,
      p_title: scene.title,
      p_version: scene.version,
      p_thumbnail_meta: scene.thumbnailMeta ?? null,
    });
    if (error || !data) {
      throw mapEmbedError(error);
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw createForbiddenEmbedError();
    }
    return {
      id: (row as { id: string }).id,
      version: (row as { version: number }).version,
    };
  };

  const uploadAsset = async (input: {
    token: string;
    origin: string;
    blob: Blob;
    type: AssetType;
    sceneId: string;
    fileId?: string;
    mimeType?: string;
  }): Promise<AssetRef> => {
    const resolution = await resolveEmbedForUpload(input.token, input.origin);
    if (resolution.scene_id !== input.sceneId) {
      throw new BackendError("forbidden", t("cloud.embed.readOnly"), {
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
    const { data, error } = await client.rpc("upsert_embedded_asset", {
      p_token: input.token,
      p_origin: requireOrigin(input.origin),
      p_file_id: upsertPayload.file_id,
      p_type: upsertPayload.type,
      p_storage_path: upsertPayload.storage_path,
      p_mime_type: upsertPayload.mime_type,
      p_bytes: upsertPayload.bytes,
    });
    if (error || !data) {
      throw mapEmbedError(error);
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      throw createForbiddenEmbedError();
    }
    return rowWithUrlToAssetRef(row as AssetRow);
  };

  return {
    isAvailable: () => true,
    create,
    listByScene,
    update,
    revoke,
    resolve,
    loadScene,
    saveScene,
    uploadAsset,
  };
};
