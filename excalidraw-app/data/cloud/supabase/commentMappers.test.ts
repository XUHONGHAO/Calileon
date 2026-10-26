import { describe, expect, it } from "vitest";

import {
  rowToSceneComment,
  rowToSceneCommentJoin,
  rowToSceneCommentPage,
  toDeleteOutcome,
  toIso,
} from "./commentMappers";

const row = {
  id: "c1",
  scene_id: "scene-1",
  author_id: "user-a",
  author_name: "Ada",
  author_avatar: {
    url: "https://example.test/a.png",
    audio: { color: "#1f9e8f", glyph: "A" },
  },
  is_owner_author: true,
  kind: "message",
  event_type: null,
  target_id: null,
  quoted_id: "c0",
  body: "Hello",
  original_hidden: false,
  original_body: null,
  status: "resolved",
  resolved_at: "2026-10-24T06:05:00.000Z",
  edited_at: "2026-10-24T06:03:00.000Z",
  deleted_at: null,
  deleted_role: null,
  delete_reason: null,
  created_at: "2026-10-24T06:00:00.000Z",
  updated_at: "2026-10-24T06:05:00.123456Z",
  quoted: {
    author_name: "Bo",
    created_at: "2026-10-24T05:00:00.000Z",
    deleted: false,
    excerpt: "Earlier",
  },
};

describe("rowToSceneComment", () => {
  it("maps snake_case JSON and ISO times to the domain shape", () => {
    expect(rowToSceneComment(row)).toEqual({
      id: "c1",
      sceneId: "scene-1",
      authorId: "user-a",
      authorName: "Ada",
      authorAvatar: { color: "#1f9e8f", glyph: "A" },
      isOwnerAuthor: true,
      kind: "message",
      eventType: null,
      targetId: null,
      quotedId: "c0",
      body: "Hello",
      originalHidden: false,
      originalBody: null,
      status: "resolved",
      resolvedAt: Date.UTC(2026, 9, 24, 6, 5),
      editedAt: Date.UTC(2026, 9, 24, 6, 3),
      deletedAt: null,
      deletedRole: null,
      deleteReason: null,
      createdAt: Date.UTC(2026, 9, 24, 6, 0),
      updatedAt: Date.UTC(2026, 9, 24, 6, 5, 0, 123),
      quoted: {
        authorName: "Bo",
        createdAt: Date.UTC(2026, 9, 24, 5, 0),
        deleted: false,
        excerpt: "Earlier",
      },
    });
  });

  it("never exposes the avatar URL and drops an invalid circle avatar", () => {
    const mapped = rowToSceneComment(row)!;
    expect(JSON.stringify(mapped)).not.toContain("example.test");
    expect(
      rowToSceneComment({
        ...row,
        author_avatar: { audio: { color: "red", glyph: "A" } },
      })?.authorAvatar,
    ).toBeNull();
  });

  it("drops malformed rows and defaults unknown enums", () => {
    expect(rowToSceneComment(null)).toBeNull();
    expect(rowToSceneComment({ ...row, id: 5 })).toBeNull();
    expect(rowToSceneComment({ ...row, kind: "note" })).toBeNull();
    expect(rowToSceneComment({ ...row, created_at: "nope" })).toBeNull();
    const loose = rowToSceneComment({
      ...row,
      status: "weird",
      deleted_role: "admin",
      author_name: null,
      updated_at: null,
    })!;
    expect(loose.status).toBe("open");
    expect(loose.deletedRole).toBeNull();
    expect(loose.authorName).toBe("");
    expect(loose.updatedAt).toBe(loose.createdAt);
  });
});

describe("pages and join", () => {
  it("keeps good rows of a page and reads the server time", () => {
    const page = rowToSceneCommentPage({
      comments: [row, { broken: true }],
      has_more: true,
      server_time: "2026-10-24T07:00:00.000Z",
    });
    expect(page.comments.map((comment) => comment.id)).toEqual(["c1"]);
    expect(page.hasMore).toBe(true);
    expect(page.serverTime).toBe(Date.UTC(2026, 9, 24, 7));
    expect(rowToSceneCommentPage(null).comments).toEqual([]);
  });

  it("maps a join result", () => {
    expect(
      rowToSceneCommentJoin({
        role: "owner",
        owner_id: "owner-1",
        last_seen_at: "2026-10-24T06:00:00.000Z",
        unread_deleted: 2,
        server_time: "2026-10-24T07:00:00.000Z",
      }),
    ).toEqual({
      role: "owner",
      ownerId: "owner-1",
      lastSeenAt: Date.UTC(2026, 9, 24, 6),
      unreadDeleted: 2,
      serverTime: Date.UTC(2026, 9, 24, 7),
    });
    const fallback = rowToSceneCommentJoin({
      role: "admin",
      unread_deleted: -3,
      server_time: "2026-10-24T07:00:00.000Z",
    });
    expect(fallback.role).toBe("participant");
    expect(fallback.unreadDeleted).toBe(0);
    expect(fallback.lastSeenAt).toBe(Date.UTC(2026, 9, 24, 7));
  });

  it("reads delete outcomes and formats ISO parameters", () => {
    expect(toDeleteOutcome("retracted")).toBe("retracted");
    expect(toDeleteOutcome("hidden")).toBe("hidden");
    expect(toDeleteOutcome("other")).toBe("struck");
    expect(toIso(Date.UTC(2026, 9, 24))).toBe("2026-10-24T00:00:00.000Z");
  });
});
