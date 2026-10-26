import type { SceneComment } from "../data/cloud/types";

let seq = 0;

/** A live, open message unless overridden. Test helper only. */
export const makeComment = (
  patch: Partial<SceneComment> = {},
): SceneComment => {
  seq++;
  const createdAt = patch.createdAt ?? Date.UTC(2026, 9, 24, 6, 0) + seq;
  return {
    id: `c${seq}`,
    sceneId: "scene-1",
    authorId: "user-a",
    authorName: "Ada",
    authorAvatar: null,
    isOwnerAuthor: false,
    kind: "message",
    eventType: null,
    targetId: null,
    quotedId: null,
    body: `comment ${seq}`,
    originalHidden: false,
    originalBody: null,
    status: "open",
    resolvedAt: null,
    editedAt: null,
    deletedAt: null,
    deletedRole: null,
    deleteReason: null,
    createdAt,
    updatedAt: createdAt,
    quoted: null,
    ...patch,
  };
};

export const toMap = (comments: SceneComment[]) =>
  new Map(comments.map((comment) => [comment.id, comment]));
