import { t } from "@excalidraw/excalidraw/i18n";

import { BackendError } from "../errors";

import { getSupabaseClient } from "./client";

import type {
  VideoAssetIngestResult,
  VideoAssetResolution,
  VideoAssetService,
} from "../types";

const INGEST_FUNCTION = "ai-video-ingest";
const RESOLVE_FUNCTION = "video-asset-resolve";

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
};

const mapFunctionError = (error: unknown): BackendError => {
  const status = Number(
    (
      error as {
        context?: { status?: number };
        status?: number;
      } | null
    )?.context?.status ?? (error as { status?: number } | null)?.status,
  );

  if (status === 401) {
    return new BackendError("unauthorized", t("cloud.errors.sessionExpired"), {
      recoverable: true,
      nextAction: t("cloud.errors.nextActionSignIn"),
    });
  }
  if (status === 403) {
    return new BackendError("forbidden", t("cloud.errors.forbiddenAsset"), {
      recoverable: false,
      nextAction: t("cloud.errors.nextActionSignIn"),
    });
  }
  if (status === 413) {
    return new BackendError(
      "payload-too-large",
      t("cloud.errors.assetTooLarge"),
      {
        recoverable: true,
        nextAction: t("cloud.errors.nextActionLocal"),
      },
    );
  }

  return new BackendError("network", t("cloud.errors.assetOperationFailed"), {
    recoverable: true,
    nextAction: t("cloud.errors.nextActionLocal"),
  });
};

const isIngestResult = (value: unknown): value is VideoAssetIngestResult => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const result = value as Partial<VideoAssetIngestResult>;
  return (
    typeof result.assetId === "string" &&
    !!result.assetId &&
    typeof result.mimeType === "string" &&
    result.mimeType.startsWith("video/") &&
    typeof result.bytes === "number" &&
    Number.isFinite(result.bytes) &&
    result.bytes >= 0
  );
};

const isResolution = (value: unknown): value is VideoAssetResolution => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const result = value as Partial<VideoAssetResolution>;
  try {
    const url = new URL(result.url || "");
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      typeof result.expiresAt === "number" &&
      Number.isFinite(result.expiresAt) &&
      typeof result.mimeType === "string" &&
      result.mimeType.startsWith("video/")
    );
  } catch {
    return false;
  }
};

export const createSupabaseVideoAssetService = (): VideoAssetService => ({
  isAvailable: () => true,

  ingest: async (input) => {
    throwIfAborted(input.signal);
    const { data, error } = await getSupabaseClient().functions.invoke(
      INGEST_FUNCTION,
      {
        body: {
          sceneId: input.sceneId,
          sourceUrl: input.sourceUrl,
          expectedMimeType: input.expectedMimeType,
          idempotencyKey: input.idempotencyKey,
        },
      },
    );
    throwIfAborted(input.signal);
    if (error) {
      throw mapFunctionError(error);
    }
    if (!isIngestResult(data)) {
      throw mapFunctionError(null);
    }
    return data;
  },

  resolve: async (input) => {
    throwIfAborted(input.signal);
    const { data, error } = await getSupabaseClient().functions.invoke(
      RESOLVE_FUNCTION,
      {
        body: {
          assetId: input.assetId,
          access: input.access,
        },
      },
    );
    throwIfAborted(input.signal);
    if (error) {
      throw mapFunctionError(error);
    }
    if (!isResolution(data)) {
      throw mapFunctionError(null);
    }
    return data;
  },
});
