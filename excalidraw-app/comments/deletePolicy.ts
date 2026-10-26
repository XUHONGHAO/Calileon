/**
 * What a viewer may do with a message, and what the delete dialog should look
 * like (technical design §6, §9.2). The server enforces all of it with its
 * own clock; this only predicts, and the RPC result wins when they differ.
 */

import type { SceneComment, SceneCommentRole } from "../data/cloud/types";

export const RETRACT_WINDOW_MS = 60 * 60 * 1000;

export type Viewer = {
  id: string;
  role: SceneCommentRole;
};

export type DeleteDialogKind =
  /** the author's own message, under an hour old, unanswered: no trace */
  | "retract"
  /** strike-through, optional reason */
  | "strike"
  /** the owner on someone else's message: strike or also hide the original */
  | "owner";

export const isAuthor = (comment: SceneComment, viewer: Viewer) =>
  comment.authorId !== null && comment.authorId === viewer.id;

export const isLiveMessage = (comment: SceneComment) =>
  comment.kind === "message" && comment.deletedAt === null;

/** Replies among the loaded rows (events are not replies). */
export const hasLoadedReplies = (
  comments: Iterable<SceneComment>,
  id: string,
): boolean => {
  for (const comment of comments) {
    if (comment.kind === "message" && comment.quotedId === id) {
      return true;
    }
  }
  return false;
};

export const predictDeleteDialog = (input: {
  comment: SceneComment;
  viewer: Viewer;
  hasReplies: boolean;
  /** local time corrected to the server's clock */
  serverNow: number;
}): DeleteDialogKind | null => {
  const { comment, viewer } = input;
  if (!isLiveMessage(comment)) {
    return null;
  }
  if (isAuthor(comment, viewer)) {
    return input.serverNow - comment.createdAt < RETRACT_WINDOW_MS &&
      !input.hasReplies
      ? "retract"
      : "strike";
  }
  return viewer.role === "owner" ? "owner" : null;
};

export const canReply = (comment: SceneComment) => isLiveMessage(comment);

export const canEdit = (comment: SceneComment, viewer: Viewer) =>
  isLiveMessage(comment) && isAuthor(comment, viewer);

/** Owner or the message's author (Q3). */
export const canChangeStatus = (comment: SceneComment, viewer: Viewer) =>
  isLiveMessage(comment) &&
  (viewer.role === "owner" || isAuthor(comment, viewer));

export const canDelete = (comment: SceneComment, viewer: Viewer) =>
  isLiveMessage(comment) &&
  (viewer.role === "owner" || isAuthor(comment, viewer));

/**
 * The viewer's own messages someone else deleted after `lastSeenAt` (C9).
 * Only the owner deletes other people's messages, so "someone else" is
 * `deletedRole === "owner"`.
 */
export const getUnreadDeletedIds = (
  comments: Iterable<SceneComment>,
  viewerId: string,
  lastSeenAt: number,
): string[] => {
  const ids: string[] = [];
  for (const comment of comments) {
    if (
      comment.kind === "message" &&
      comment.authorId === viewerId &&
      comment.deletedRole === "owner" &&
      comment.deletedAt !== null &&
      comment.deletedAt > lastSeenAt
    ) {
      ids.push(comment.id);
    }
  }
  return ids;
};
