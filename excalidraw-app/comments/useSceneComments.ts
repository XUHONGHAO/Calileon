/**
 * React side of the comments controller (technical design §9.2, §9.3). The
 * host lives in AppSidebar, which stays mounted while the comments tab is
 * closed, so the join happens in the background and the tab badge (C9)
 * shows without opening the tab.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

import { getCommentAvailability } from "./availability";
import { CommentsController } from "./commentsController";

import type { CommentAvailability, CommentContext } from "./availability";
import type { CommentsState } from "./commentsController";
import type { SceneCommentService } from "../data/cloud/types";

const availabilityKey = (availability: CommentAvailability): string => {
  switch (availability.kind) {
    case "unsupported-deployment":
      return availability.kind;
    case "unsupported-context":
      return `${availability.kind}:${availability.reason}`;
    case "signed-out":
      return `${availability.kind}:${availability.sceneId}`;
    case "ready":
      return [
        availability.kind,
        availability.sceneId,
        availability.ownerId,
        availability.shareToken ?? "",
      ].join(":");
  }
};

/**
 * `getCommentAvailability`, stable while the outcome stays the same: App
 * re-renders constantly and passes the result into the memoized sidebar.
 */
export const useCommentAvailability = (
  context: CommentContext,
): CommentAvailability => {
  const next = getCommentAvailability(context);
  const key = availabilityKey(next);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => next, [key]);
};

export type CommentsHost = {
  controller: CommentsController | null;
  /** recreates the controller, e.g. after a failed join */
  retry: () => void;
};

export const useCommentsHost = (
  availability: CommentAvailability,
  viewerId: string | null,
  service: SceneCommentService | null,
): CommentsHost => {
  const ready = availability.kind === "ready" ? availability : null;
  const sceneId = ready?.sceneId ?? null;
  const shareToken = ready?.shareToken ?? null;
  const [attempt, setAttempt] = useState(0);
  const [controller, setController] = useState<CommentsController | null>(null);

  useEffect(() => {
    if (!service || !sceneId || !viewerId) {
      setController(null);
      return;
    }
    const next = new CommentsController({
      service,
      sceneId,
      shareToken,
      viewerId,
    });
    setController(next);
    void next.start();
    return () => {
      next.dispose();
    };
  }, [service, sceneId, shareToken, viewerId, attempt]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return { controller, retry };
};

const noopSubscribe = () => () => {};
const getNullState = () => null;

export const useCommentsState = (
  controller: CommentsController | null,
): CommentsState | null =>
  useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getState ?? getNullState,
  );

/** Only the badge flag, so the tab trigger re-renders when it flips. */
export const useCommentsBadge = (
  controller: CommentsController | null,
): boolean => {
  const getBadge = useCallback(
    () => controller?.getState().badge ?? false,
    [controller],
  );
  return useSyncExternalStore(controller?.subscribe ?? noopSubscribe, getBadge);
};

/** Marks the panel open while it is mounted (Radix unmounts hidden tabs). */
export const useCommentsPanelOpen = (controller: CommentsController | null) => {
  useEffect(() => {
    if (!controller) {
      return;
    }
    controller.setPanelOpen(true);
    return () => controller.setPanelOpen(false);
  }, [controller]);
};
