import { describe, expect, it } from "vitest";

import {
  canChangeStatus,
  canDelete,
  canEdit,
  canReply,
  getUnreadDeletedIds,
  hasLoadedReplies,
  predictDeleteDialog,
} from "./deletePolicy";
import { makeComment } from "./testFixtures";

const MIN = 60_000;
const now = Date.UTC(2026, 9, 25, 12, 0);
const author = { id: "user-a", role: "participant" } as const;
const owner = { id: "owner-1", role: "owner" } as const;
const stranger = { id: "user-b", role: "participant" } as const;

describe("predictDeleteDialog", () => {
  it("retracts an own message under an hour old without replies", () => {
    const comment = makeComment({ createdAt: now - 59 * MIN });
    expect(
      predictDeleteDialog({
        comment,
        viewer: author,
        hasReplies: false,
        serverNow: now,
      }),
    ).toBe("retract");
  });

  it("strikes an own message after an hour", () => {
    const comment = makeComment({ createdAt: now - 61 * MIN });
    expect(
      predictDeleteDialog({
        comment,
        viewer: author,
        hasReplies: false,
        serverNow: now,
      }),
    ).toBe("strike");
  });

  it("strikes an own message that has replies, even a fresh one", () => {
    const comment = makeComment({ createdAt: now - MIN });
    expect(
      predictDeleteDialog({
        comment,
        viewer: author,
        hasReplies: true,
        serverNow: now,
      }),
    ).toBe("strike");
  });

  it("gives the owner the hide option on someone else's message", () => {
    const comment = makeComment({ createdAt: now - MIN });
    expect(
      predictDeleteDialog({
        comment,
        viewer: owner,
        hasReplies: false,
        serverNow: now,
      }),
    ).toBe("owner");
  });

  it("treats the owner's own message like anyone's own (Q6)", () => {
    const comment = makeComment({ authorId: owner.id, createdAt: now - MIN });
    expect(
      predictDeleteDialog({
        comment,
        viewer: owner,
        hasReplies: false,
        serverNow: now,
      }),
    ).toBe("retract");
  });

  it("offers nothing to other participants or on deleted messages", () => {
    const comment = makeComment();
    expect(
      predictDeleteDialog({
        comment,
        viewer: stranger,
        hasReplies: false,
        serverNow: now,
      }),
    ).toBeNull();
    expect(
      predictDeleteDialog({
        comment: { ...comment, deletedAt: now, deletedRole: "author" },
        viewer: author,
        hasReplies: false,
        serverNow: now,
      }),
    ).toBeNull();
  });
});

describe("permissions", () => {
  it("follows Q3: owner or author may resolve; only the author edits", () => {
    const comment = makeComment();
    expect(canChangeStatus(comment, owner)).toBe(true);
    expect(canChangeStatus(comment, author)).toBe(true);
    expect(canChangeStatus(comment, stranger)).toBe(false);
    expect(canEdit(comment, author)).toBe(true);
    expect(canEdit(comment, owner)).toBe(false);
    expect(canDelete(comment, stranger)).toBe(false);
    expect(canReply(comment)).toBe(true);
  });

  it("allows nothing on a deleted message or an event", () => {
    const deleted = makeComment({ deletedAt: 1, deletedRole: "author" });
    const event = makeComment({ kind: "event", eventType: "resolved" });
    for (const comment of [deleted, event]) {
      expect(canReply(comment)).toBe(false);
      expect(canEdit(comment, author)).toBe(false);
      expect(canChangeStatus(comment, owner)).toBe(false);
      expect(canDelete(comment, owner)).toBe(false);
    }
  });

  it("does not count events as replies", () => {
    const message = makeComment();
    const event = makeComment({
      kind: "event",
      eventType: "resolved",
      targetId: message.id,
      quotedId: message.id,
    });
    expect(hasLoadedReplies([message, event], message.id)).toBe(false);
    expect(
      hasLoadedReplies(
        [message, makeComment({ quotedId: message.id })],
        message.id,
      ),
    ).toBe(true);
  });
});

describe("getUnreadDeletedIds", () => {
  it("lists the viewer's messages the owner deleted after the last visit", () => {
    const seen = 1000;
    const unread = makeComment({ deletedAt: 1500, deletedRole: "owner" });
    const before = makeComment({ deletedAt: 900, deletedRole: "owner" });
    const self = makeComment({ deletedAt: 1500, deletedRole: "author" });
    const others = makeComment({
      authorId: "user-b",
      deletedAt: 1500,
      deletedRole: "owner",
    });
    expect(
      getUnreadDeletedIds([unread, before, self, others], "user-a", seen),
    ).toEqual([unread.id]);
  });
});
