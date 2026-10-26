import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackendError } from "../data/cloud/errors";

import {
  CHANGE_OVERLAP_MS,
  CommentsController,
  POLL_INTERVAL_MS,
  SIGNAL_DEBOUNCE_MS,
} from "./commentsController";
import { makeComment } from "./testFixtures";

import type {
  SceneComment,
  SceneCommentChannelStatus,
  SceneCommentPage,
  SceneCommentSignal,
} from "../data/cloud/types";

const T0 = Date.UTC(2026, 9, 25, 12, 0);

const page = (
  comments: SceneComment[],
  patch: Partial<SceneCommentPage> = {},
): SceneCommentPage => ({
  comments,
  hasMore: false,
  serverTime: Date.now(),
  ...patch,
});

const setup = (
  opts: {
    initial?: SceneComment[];
    unreadDeleted?: number;
    lastSeenAt?: number;
  } = {},
) => {
  let handlers: {
    onSignal: (signal: SceneCommentSignal) => void;
    onStatus: (status: SceneCommentChannelStatus) => void;
  } | null = null;
  const unsubscribe = vi.fn();
  const service = {
    isAvailable: () => true,
    join: vi.fn(async () => ({
      role: "participant" as const,
      ownerId: "owner-1",
      lastSeenAt: opts.lastSeenAt ?? T0 - 60_000,
      unreadDeleted: opts.unreadDeleted ?? 0,
      serverTime: Date.now(),
    })),
    list: vi.fn(async () => page(opts.initial ?? [])),
    listChanges: vi.fn(async () => page([])),
    post: vi.fn(),
    edit: vi.fn(),
    setStatus: vi.fn(),
    remove: vi.fn(),
    markSeen: vi.fn(async () => Date.now()),
    subscribe: vi.fn((_sceneId: string, next: typeof handlers) => {
      handlers = next;
      return unsubscribe;
    }),
  };
  const controller = new CommentsController({
    service,
    sceneId: "scene-1",
    shareToken: "tok",
    viewerId: "user-a",
  });
  return {
    service,
    controller,
    unsubscribe,
    signal: (signal: SceneCommentSignal) => handlers!.onSignal(signal),
    status: (status: SceneCommentChannelStatus) => handlers!.onStatus(status),
  };
};

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("CommentsController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("joins with the share token, loads the latest page, then subscribes", async () => {
    const first = makeComment();
    const { service, controller } = setup({ initial: [first] });
    expect(controller.getState().phase).toBe("joining");
    await controller.start();
    expect(service.join).toHaveBeenCalledWith("scene-1", "tok");
    expect(service.subscribe).toHaveBeenCalledWith(
      "scene-1",
      expect.any(Object),
    );
    const state = controller.getState();
    expect(state.phase).toBe("ready");
    expect(state.role).toBe("participant");
    expect([...state.comments.keys()]).toEqual([first.id]);
    controller.dispose();
  });

  it("shows the join error and does not subscribe", async () => {
    const { service, controller } = setup();
    service.join.mockRejectedValueOnce(
      new BackendError("forbidden", "no access", { recoverable: false }),
    );
    await controller.start();
    expect(controller.getState().phase).toBe("error");
    expect(controller.getState().error?.message).toBe("no access");
    expect(service.subscribe).not.toHaveBeenCalled();
  });

  it("polls while the channel is not live, with a full reload every 5th time", async () => {
    const { service, controller, status } = setup();
    await controller.start();
    status("unavailable");
    service.list.mockClear();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    }
    expect(service.listChanges).toHaveBeenCalledTimes(4);
    expect(service.list).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(service.list).toHaveBeenCalledTimes(1);

    status("live");
    service.listChanges.mockClear();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    expect(service.listChanges).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("debounces change signals into one pull from cursor minus the overlap", async () => {
    const { service, controller, signal, status } = setup();
    await controller.start();
    status("live");
    signal({ kind: "changed" });
    signal({ kind: "changed" });
    signal({ kind: "changed" });
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS);
    expect(service.listChanges).toHaveBeenCalledTimes(1);
    expect(service.listChanges).toHaveBeenCalledWith(
      "scene-1",
      T0 - CHANGE_OVERLAP_MS,
    );

    const edited = makeComment({ body: "new" });
    service.listChanges.mockResolvedValueOnce(page([edited]));
    signal({ kind: "changed" });
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS);
    expect(controller.getState().comments.get(edited.id)?.body).toBe("new");
    controller.dispose();
  });

  it("follows change pages, stepping back 1 ms at each boundary", async () => {
    const { service, controller, signal } = setup();
    await controller.start();
    const a = makeComment({ updatedAt: T0 + 10 });
    const b = makeComment({ updatedAt: T0 + 20 });
    service.listChanges
      .mockResolvedValueOnce(page([a], { hasMore: true }))
      .mockResolvedValueOnce(page([b]));
    signal({ kind: "changed" });
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS);
    expect(service.listChanges).toHaveBeenNthCalledWith(
      2,
      "scene-1",
      T0 + 10 - 1,
    );
    expect(controller.getState().comments.size).toBe(2);
    controller.dispose();
  });

  it("removes a retracted comment on a DELETE signal and ignores unknown ids", async () => {
    const message = makeComment();
    const { service, controller, signal } = setup({ initial: [message] });
    await controller.start();
    signal({ kind: "removed", id: "elsewhere" });
    expect(controller.getState().comments.size).toBe(1);
    signal({ kind: "removed", id: message.id });
    expect(controller.getState().comments.size).toBe(0);

    // a stale response must not bring it back (tombstone)
    service.listChanges.mockResolvedValueOnce(page([message]));
    signal({ kind: "changed" });
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS);
    expect(controller.getState().comments.size).toBe(0);
    controller.dispose();
  });

  it("reloads everything after a reconnect, not on the first connect", async () => {
    const gone = makeComment();
    const { service, controller, status } = setup({ initial: [gone] });
    await controller.start();
    status("live");
    await flush();
    expect(service.list).toHaveBeenCalledTimes(1);
    status("unavailable");
    // retracted while the channel was down: only a full reload notices
    service.list.mockResolvedValueOnce(page([]));
    status("live");
    await flush();
    expect(service.list).toHaveBeenCalledTimes(2);
    expect(controller.getState().comments.size).toBe(0);
    controller.dispose();
  });

  it("reloads when the page comes back, at most every 2 s", async () => {
    const { service, controller } = setup();
    await controller.start();
    service.list.mockClear();
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(service.list).not.toHaveBeenCalled(); // just loaded
    await vi.advanceTimersByTimeAsync(2_500);
    window.dispatchEvent(new Event("focus"));
    await flush();
    expect(service.list).toHaveBeenCalledTimes(1);
    controller.dispose();
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(service.list).toHaveBeenCalledTimes(1);
  });

  it("switches to the error phase when access is revoked in the background", async () => {
    const { service, controller, signal, unsubscribe } = setup();
    await controller.start();
    service.listChanges.mockRejectedValueOnce(
      new BackendError("forbidden", "revoked", { recoverable: false }),
    );
    signal({ kind: "changed" });
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS);
    expect(controller.getState().phase).toBe("error");
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("keeps the feed on a transient background failure", async () => {
    const message = makeComment();
    const { service, controller, signal } = setup({ initial: [message] });
    await controller.start();
    service.listChanges.mockRejectedValueOnce(new TypeError("offline"));
    signal({ kind: "changed" });
    await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS);
    expect(controller.getState().phase).toBe("ready");
    expect(controller.getState().comments.size).toBe(1);
    controller.dispose();
  });

  it("posts optimistically, then swaps in the saved row", async () => {
    const { service, controller } = setup();
    await controller.start();
    const saved = makeComment({ body: "hi", authorId: "user-a" });
    let resolve!: (comment: SceneComment) => void;
    service.post.mockReturnValueOnce(
      new Promise<SceneComment>((done) => {
        resolve = done;
      }),
    );
    const posting = controller.post("hi", null);
    expect(controller.getState().pending).toMatchObject([
      { body: "hi", status: "sending" },
    ]);
    resolve(saved);
    await posting;
    expect(controller.getState().pending).toEqual([]);
    expect(controller.getState().comments.get(saved.id)).toBe(saved);
    controller.dispose();
  });

  it("keeps a failed post for retry or discard", async () => {
    const { service, controller } = setup();
    await controller.start();
    service.post.mockRejectedValueOnce(
      new BackendError("quota-exceeded", "slow down", { recoverable: true }),
    );
    await controller.post("hi", "c0");
    const [failed] = controller.getState().pending;
    expect(failed).toMatchObject({
      status: "failed",
      error: "slow down",
      quotedId: "c0",
    });

    const saved = makeComment({ body: "hi" });
    service.post.mockResolvedValueOnce(saved);
    await controller.retry(failed.tempId);
    expect(service.post).toHaveBeenLastCalledWith({
      sceneId: "scene-1",
      body: "hi",
      quotedId: "c0",
    });
    expect(controller.getState().pending).toEqual([]);

    service.post.mockRejectedValueOnce(new TypeError("offline"));
    await controller.post("again", null);
    controller.discard(controller.getState().pending[0].tempId);
    expect(controller.getState().pending).toEqual([]);
    controller.dispose();
  });

  it("drops a retracted comment at once and refreshes after a strike", async () => {
    const message = makeComment();
    const { service, controller } = setup({ initial: [message] });
    await controller.start();
    service.remove.mockResolvedValueOnce("struck");
    await controller.remove(message.id, { reason: "dup" });
    await vi.advanceTimersByTimeAsync(0);
    expect(service.listChanges).toHaveBeenCalled();
    expect(controller.getState().comments.size).toBe(1);

    service.remove.mockResolvedValueOnce("retracted");
    await controller.remove(message.id);
    expect(controller.getState().comments.size).toBe(0);
    controller.dispose();
  });

  it("rethrows action errors and reloads on a conflict", async () => {
    const { service, controller } = setup();
    await controller.start();
    service.list.mockClear();
    service.edit.mockRejectedValueOnce(
      new BackendError("conflict", "gone", { recoverable: true }),
    );
    await expect(controller.edit("c1", "x")).rejects.toMatchObject({
      message: "gone",
    });
    await flush();
    expect(service.list).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("loads older pages before the oldest loaded comment", async () => {
    const oldest = makeComment({ createdAt: T0 - 5_000 });
    const { service, controller } = setup({
      initial: [oldest, makeComment({ createdAt: T0 - 1_000 })],
    });
    service.list.mockResolvedValueOnce(
      page([oldest, makeComment({ createdAt: T0 - 1_000 })], { hasMore: true }),
    );
    await controller.start();
    expect(controller.getState().hasOlder).toBe(true);
    const older = makeComment({ createdAt: T0 - 9_000 });
    service.list.mockResolvedValueOnce(page([older]));
    await controller.loadOlder();
    expect(service.list).toHaveBeenLastCalledWith("scene-1", {
      before: oldest.createdAt + 1,
    });
    expect(controller.getState().comments.has(older.id)).toBe(true);
    expect(controller.getState().hasOlder).toBe(false);
    controller.dispose();
  });

  describe("unread deletions (C9)", () => {
    const deletedMine = () =>
      makeComment({
        authorId: "user-a",
        deletedAt: T0 - 1_000,
        deletedRole: "owner",
        deleteReason: "off-topic",
      });

    it("shows the badge in the background and clears it when the tab opens", async () => {
      const unread = deletedMine();
      const { service, controller } = setup({
        initial: [unread],
        unreadDeleted: 1,
      });
      await controller.start();
      expect(controller.getState().badge).toBe(true);
      expect(service.markSeen).not.toHaveBeenCalled();

      controller.setPanelOpen(true);
      expect(controller.getState().unreadIds.has(unread.id)).toBe(true);
      expect(controller.getState().badge).toBe(false);
      await flush();
      expect(service.markSeen).toHaveBeenCalledTimes(1);
      // the highlight stays while the panel is open
      expect(controller.getState().unreadIds.has(unread.id)).toBe(true);

      controller.setPanelOpen(false);
      expect(controller.getState().unreadIds.size).toBe(0);
      expect(controller.getState().badge).toBe(false);
      controller.dispose();
    });

    it("takes the highlight snapshot when the tab was open before loading", async () => {
      const unread = deletedMine();
      const { service, controller } = setup({ initial: [unread] });
      controller.setPanelOpen(true);
      await controller.start();
      expect(controller.getState().unreadIds.has(unread.id)).toBe(true);
      await flush();
      expect(service.markSeen).toHaveBeenCalledTimes(1);
      controller.dispose();
    });

    it("counts a deletion that arrives while the tab is open as seen", async () => {
      const { service, controller, signal } = setup();
      await controller.start();
      controller.setPanelOpen(true);
      await flush();
      service.markSeen.mockClear();
      // deleted after the visit that just got marked
      service.listChanges.mockResolvedValueOnce(
        page([{ ...deletedMine(), deletedAt: T0 + 100, updatedAt: T0 + 100 }]),
      );
      signal({ kind: "changed" });
      await vi.advanceTimersByTimeAsync(SIGNAL_DEBOUNCE_MS);
      expect(service.markSeen).toHaveBeenCalledTimes(1);
      expect(controller.getState().badge).toBe(false);
      controller.dispose();
    });
  });

  it("does nothing after dispose", async () => {
    const { service, controller, signal, status, unsubscribe } = setup();
    await controller.start();
    status("unavailable");
    controller.dispose();
    expect(unsubscribe).toHaveBeenCalled();
    service.listChanges.mockClear();
    signal({ kind: "changed" });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
    expect(service.listChanges).not.toHaveBeenCalled();
  });
});
