/**
 * scene comment RPC JSON → domain types (ADR 0037). Rows come from
 * `scene_comment_to_json` in schema_comments.sql: snake_case, ISO timestamps.
 * Parsing is defensive; a malformed row is dropped rather than shown.
 */

import { restoreAudioAvatar } from "@excalidraw/element";

import type {
  SceneComment,
  SceneCommentDeleteOutcome,
  SceneCommentJoinResult,
  SceneCommentPage,
} from "../types";

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);

const text = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const epoch = (value: unknown): number | null => {
  if (typeof value !== "string" || !value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

const oneOf = <T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null =>
  typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null;

export const rowToSceneComment = (row: unknown): SceneComment | null => {
  if (!isObject(row)) {
    return null;
  }
  const id = text(row.id);
  const sceneId = text(row.scene_id);
  const kind = oneOf(row.kind, ["message", "event"] as const);
  const createdAt = epoch(row.created_at);
  if (!id || !sceneId || !kind || createdAt === null) {
    return null;
  }

  const avatar = isObject(row.author_avatar) ? row.author_avatar : null;
  const quoted = isObject(row.quoted) ? row.quoted : null;

  return {
    id,
    sceneId,
    authorId: text(row.author_id),
    authorName: text(row.author_name) ?? "",
    // the snapshot may also hold an image URL; it is never rendered, so a
    // reader's browser never fetches a URL another user chose
    authorAvatar: avatar ? restoreAudioAvatar(avatar.audio) : null,
    isOwnerAuthor: row.is_owner_author === true,
    kind,
    eventType: oneOf(row.event_type, ["resolved", "reopened"] as const),
    targetId: text(row.target_id),
    quotedId: text(row.quoted_id),
    body: text(row.body),
    originalHidden: row.original_hidden === true,
    originalBody: text(row.original_body),
    status: oneOf(row.status, ["open", "resolved"] as const) ?? "open",
    resolvedAt: epoch(row.resolved_at),
    editedAt: epoch(row.edited_at),
    deletedAt: epoch(row.deleted_at),
    deletedRole: oneOf(row.deleted_role, ["author", "owner"] as const),
    deleteReason: text(row.delete_reason),
    createdAt,
    updatedAt: epoch(row.updated_at) ?? createdAt,
    quoted: quoted
      ? {
          authorName: text(quoted.author_name) ?? "",
          createdAt: epoch(quoted.created_at) ?? 0,
          deleted: quoted.deleted === true,
          excerpt: text(quoted.excerpt),
        }
      : null,
  };
};

export const rowToSceneCommentPage = (data: unknown): SceneCommentPage => {
  const page = isObject(data) ? data : {};
  const rows = Array.isArray(page.comments) ? page.comments : [];
  return {
    comments: rows
      .map(rowToSceneComment)
      .filter((comment): comment is SceneComment => comment !== null),
    hasMore: page.has_more === true,
    serverTime: epoch(page.server_time) ?? Date.now(),
  };
};

export const rowToSceneCommentJoin = (
  data: unknown,
): SceneCommentJoinResult => {
  const row = isObject(data) ? data : {};
  const serverTime = epoch(row.server_time) ?? Date.now();
  return {
    role: row.role === "owner" ? "owner" : "participant",
    ownerId: text(row.owner_id) ?? "",
    lastSeenAt: epoch(row.last_seen_at) ?? serverTime,
    unreadDeleted:
      typeof row.unread_deleted === "number" && row.unread_deleted > 0
        ? Math.floor(row.unread_deleted)
        : 0,
    serverTime,
  };
};

export const toDeleteOutcome = (data: unknown): SceneCommentDeleteOutcome =>
  oneOf(data, ["retracted", "struck", "hidden"] as const) ?? "struck";

/** ISO timestamp for an RPC parameter. */
export const toIso = (ms: number): string => new Date(ms).toISOString();
