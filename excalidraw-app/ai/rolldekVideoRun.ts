import { t } from "@excalidraw/excalidraw/i18n";

import { AIImageGenerationError } from "./openAIImageAdapter";
import { loadAIProxyConfig } from "./proxyConfig";
import {
  assertRollDekTransport,
  submitRollDekVideoTask,
  validateRollDekVideoRequest,
} from "./rolldekVideoAdapter";
import {
  STALE_VIDEO_REFERENCE_MS,
  releaseVideoReferences,
  uploadVideoReferences,
} from "./videoReferenceUploads";

import type { VideoReferenceService } from "../data/cloud/types";
import type { RollDekVideoRequest } from "./rolldekVideoAdapter";
import type { AIImageSource, AIVideoReference } from "./types";
import type { VideoReferenceUploadInput } from "./videoReferenceUploads";

/**
 * One RollDek submission from the workbench (ADR 0039 §4, §6): check the
 * request, upload references, submit once, and decide whether the uploaded
 * references can be deleted when the submit fails.
 */

const PLACEHOLDER_REFERENCE_URL = "https://placeholder.invalid/reference";

export const toImageReferenceUploads = (
  sources: readonly AIImageSource[],
): VideoReferenceUploadInput[] =>
  sources.map((source) => ({
    kind: "image",
    blob: source.file,
    mimeType: source.file.type || "image/png",
  }));

/**
 * A failed submit only proves no task exists when the provider rejected it or
 * the request never left the browser. Otherwise a task may still fetch the
 * references, so they are left for the stale sweep.
 */
export const canReleaseReferencesAfterSubmitError = (error: unknown) => {
  if ((error as { name?: string } | null)?.name === "AbortError") {
    return false;
  }
  const outcome =
    error instanceof AIImageGenerationError
      ? (error.details as { submitOutcome?: string } | undefined)?.submitOutcome
      : undefined;
  return outcome !== "unknown";
};

export const isUnknownSubmitOutcome = (error: unknown) =>
  !canReleaseReferencesAfterSubmitError(error);

export const submitRollDekVideoRun = async ({
  request,
  uploads,
  referenceService,
  referencesAllowed,
  onSubmitting,
}: {
  /** Everything except `references`, which come from `uploads`. */
  request: Omit<RollDekVideoRequest, "references">;
  uploads: readonly VideoReferenceUploadInput[];
  referenceService: VideoReferenceService | undefined;
  /** False when the host forbids plaintext uploads (e.g. a Vault). */
  referencesAllowed: boolean;
  /**
   * Called when uploads are done and the billed POST starts. An abort before
   * this created no task; after it, a task may exist.
   */
  onSubmitting?: () => void;
}): Promise<{
  taskId: string;
  endpoint: string;
  referenceAssetIds: string[];
}> => {
  const needsReferences =
    request.mode !== "text-to-video" && uploads.length > 0;

  if (needsReferences && (!referencesAllowed || !referenceService)) {
    throw new AIImageGenerationError(
      t("ai.workbench.rolldekReferencesUnavailable"),
      "unsupported",
    );
  }

  // Check everything that does not depend on the uploaded URLs first, so a
  // bad request never uploads anything.
  assertRollDekTransport(
    request.baseURL,
    request.config || loadAIProxyConfig(),
  );
  validateRollDekVideoRequest({
    ...request,
    references: uploads.map(
      (upload): AIVideoReference => ({
        kind: upload.kind,
        url: PLACEHOLDER_REFERENCE_URL,
        ...(upload.durationSeconds != null
          ? { durationSeconds: upload.durationSeconds }
          : {}),
      }),
    ),
  });

  const { references, assetIds } =
    needsReferences && referenceService
      ? await uploadVideoReferences(referenceService, uploads, request.signal)
      : { references: [], assetIds: [] };

  onSubmitting?.();
  try {
    const { taskId, endpoint } = await submitRollDekVideoTask({
      ...request,
      references,
    });
    return { taskId, endpoint, referenceAssetIds: assetIds };
  } catch (error) {
    if (canReleaseReferencesAfterSubmitError(error)) {
      await releaseVideoReferences(referenceService, assetIds);
    }
    throw error;
  }
};

let staleSweepStarted = false;

/** Once per page load: delete references a closed tab never cleaned up. */
export const sweepStaleVideoReferences = (
  referenceService: VideoReferenceService | undefined,
) => {
  if (staleSweepStarted || !referenceService) {
    return;
  }
  staleSweepStarted = true;
  void referenceService
    .removeStale(STALE_VIDEO_REFERENCE_MS)
    .catch((error) =>
      console.warn("Failed to sweep stale AI video references", error),
    );
};

export const __resetStaleVideoReferenceSweepForTests = () => {
  staleSweepStarted = false;
};
