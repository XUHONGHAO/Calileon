import type { VideoReferenceService } from "../data/cloud/types";
import type { AIVideoReference } from "./types";

/**
 * Turns tray references into the signed HTTPS URLs RollDek needs (ADR 0039
 * §4). Uploads are all-or-nothing: if one fails, the ones already uploaded are
 * deleted before the error is rethrown, so nothing is left behind.
 */

/** Matches the `excalidraw-assets` bucket allowlist (schema_assets.sql). */
const ALLOWED_MIME_TYPES: Record<AIVideoReference["kind"], readonly string[]> =
  {
    image: ["image/png", "image/jpeg", "image/webp", "image/gif"],
    video: ["video/mp4", "video/webm"],
    audio: ["audio/mpeg", "audio/mp4", "audio/webm", "audio/ogg"],
  };

/** References left behind by a closed tab are swept after this long. */
export const STALE_VIDEO_REFERENCE_MS = 24 * 60 * 60 * 1000;

export type VideoReferenceUploadInput = {
  kind: AIVideoReference["kind"];
  blob: Blob;
  mimeType: string;
  durationSeconds?: number;
};

export class VideoReferenceTypeError extends Error {
  constructor(
    public readonly kind: AIVideoReference["kind"],
    public readonly mimeType: string,
  ) {
    super(`Unsupported ${kind} reference type: ${mimeType || "unknown"}`);
    this.name = "VideoReferenceTypeError";
  }
}

const normalizeMimeType = (mimeType: string) =>
  mimeType.split(";", 1)[0].trim().toLowerCase();

export const isAllowedVideoReferenceType = (
  kind: AIVideoReference["kind"],
  mimeType: string,
) => ALLOWED_MIME_TYPES[kind].includes(normalizeMimeType(mimeType));

export const uploadVideoReferences = async (
  service: VideoReferenceService,
  inputs: readonly VideoReferenceUploadInput[],
  signal?: AbortSignal,
): Promise<{ references: AIVideoReference[]; assetIds: string[] }> => {
  for (const input of inputs) {
    if (!isAllowedVideoReferenceType(input.kind, input.mimeType)) {
      throw new VideoReferenceTypeError(input.kind, input.mimeType);
    }
  }

  const references: AIVideoReference[] = [];
  const assetIds: string[] = [];
  try {
    // One at a time: references can be large, and order must match the tray.
    for (const input of inputs) {
      const uploaded = await service.upload({
        blob: input.blob,
        mimeType: normalizeMimeType(input.mimeType),
        signal,
      });
      assetIds.push(uploaded.assetId);
      references.push({
        kind: input.kind,
        url: uploaded.url,
        ...(input.durationSeconds != null
          ? { durationSeconds: input.durationSeconds }
          : {}),
      });
    }
  } catch (error) {
    await releaseVideoReferences(service, assetIds);
    throw error;
  }

  return { references, assetIds };
};

/** Best effort: a failure here is swept later by `removeStale`. */
export const releaseVideoReferences = async (
  service: VideoReferenceService | undefined,
  assetIds: readonly string[] | undefined,
) => {
  if (!service || !assetIds?.length) {
    return;
  }
  try {
    await service.remove(assetIds);
  } catch (error) {
    console.warn("Failed to delete AI video references", error);
  }
};
