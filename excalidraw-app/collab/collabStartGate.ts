import { t } from "@excalidraw/excalidraw/i18n";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { hasAIVideoGenerationMarker } from "../ai/videoAssetMigration";

/**
 * Why a live collaboration session must not start with this scene, or null.
 * One check for every entry point (cloud room, anonymous session, invite,
 * embed), enforced inside `Collab.startCollaboration` (ADR 0035 §7):
 * - camera recordings never enter realtime collaboration;
 * - AI videos can't be played by peers yet (ADR 0022).
 * Joining an existing room is not gated: it replaces the local scene.
 */
export const getCollabStartBlock = (
  elements: readonly ExcalidrawElement[],
): string | null => {
  const live = elements.filter((element) => !element.isDeleted);
  if (live.some((element) => element.type === "video")) {
    return t("video.collabStartBlocked");
  }
  if (live.some(hasAIVideoGenerationMarker)) {
    return t("ai.workbench.videoAssetCollabBlocked");
  }
  return null;
};
