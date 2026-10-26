import { beforeEach, describe, expect, it, vi } from "vitest";

import { BackendError } from "../errors";

import { createSupabaseCommentService } from "./SupabaseCommentService";

type Handler = (payload: any) => void;

const mockRpc = vi.fn();
const mockRemoveChannel = vi.fn();
let channels: Array<{
  topic: string;
  bindings: Array<{ type: string; filter: any; handler: Handler }>;
  subscribeCallback: ((state: string) => void) | null;
}> = [];

vi.mock("./client", () => ({
  getSupabaseClient: () => ({
    rpc: mockRpc,
    channel: (topic: string) => {
      const record = {
        topic,
        bindings: [] as Array<{ type: string; filter: any; handler: Handler }>,
        subscribeCallback: null as ((state: string) => void) | null,
      };
      channels.push(record);
      const channel = {
        on: (type: string, filter: any, handler: Handler) => {
          record.bindings.push({ type, filter, handler });
          return channel;
        },
        subscribe: (callback: (state: string) => void) => {
          record.subscribeCallback = callback;
          return channel;
        },
      };
      return channel;
    },
    removeChannel: mockRemoveChannel,
  }),
  hasSupabaseConfig: () => true,
}));

const commentRow = {
  id: "c1",
  scene_id: "scene-1",
  author_id: "user-a",
  author_name: "Ada",
  kind: "message",
  body: "Hello",
  status: "open",
  created_at: "2026-10-24T06:00:00.000Z",
  updated_at: "2026-10-24T06:00:00.000Z",
};

describe("SupabaseCommentService", () => {
  beforeEach(() => {
    mockRpc.mockReset();
    mockRemoveChannel.mockReset();
    channels = [];
  });

  it("calls the RPCs with the schema's parameter names", async () => {
    const service = createSupabaseCommentService();
    mockRpc.mockResolvedValue({
      data: {
        role: "participant",
        owner_id: "owner-1",
        server_time: "2026-10-24T07:00:00.000Z",
      },
      error: null,
    });
    await service.join("scene-1", "tok");
    expect(mockRpc).toHaveBeenLastCalledWith("join_scene_comments", {
      p_scene_id: "scene-1",
      p_token: "tok",
    });

    mockRpc.mockResolvedValue({
      data: { comments: [commentRow], has_more: false, server_time: null },
      error: null,
    });
    const page = await service.list("scene-1", {
      before: Date.UTC(2026, 9, 24),
    });
    expect(page.comments[0].id).toBe("c1");
    expect(mockRpc).toHaveBeenLastCalledWith("list_scene_comments", {
      p_scene_id: "scene-1",
      p_before: "2026-10-24T00:00:00.000Z",
    });
    await service.listChanges("scene-1", Date.UTC(2026, 9, 24, 1));
    expect(mockRpc).toHaveBeenLastCalledWith("list_scene_comments", {
      p_scene_id: "scene-1",
      p_since: "2026-10-24T01:00:00.000Z",
    });

    mockRpc.mockResolvedValue({ data: commentRow, error: null });
    await service.post({ sceneId: "scene-1", body: "Hello" });
    expect(mockRpc).toHaveBeenLastCalledWith("post_scene_comment", {
      p_scene_id: "scene-1",
      p_body: "Hello",
      p_quoted_id: null,
    });
    await service.edit("c1", "Hi");
    expect(mockRpc).toHaveBeenLastCalledWith("edit_scene_comment", {
      p_id: "c1",
      p_body: "Hi",
    });
    await service.setStatus("c1", "resolved");
    expect(mockRpc).toHaveBeenLastCalledWith("set_scene_comment_status", {
      p_id: "c1",
      p_status: "resolved",
    });

    mockRpc.mockResolvedValue({ data: "hidden", error: null });
    expect(
      await service.remove("c1", { reason: "  dup  ", hideOriginal: true }),
    ).toBe("hidden");
    expect(mockRpc).toHaveBeenLastCalledWith("delete_scene_comment", {
      p_id: "c1",
      p_reason: "dup",
      p_hide_original: true,
    });

    mockRpc.mockResolvedValue({
      data: "2026-10-24T08:00:00.000Z",
      error: null,
    });
    expect(await service.markSeen("scene-1")).toBe(Date.UTC(2026, 9, 24, 8));
  });

  it("throws mapped BackendErrors", async () => {
    const service = createSupabaseCommentService();
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: "comments-rate-limited", code: "P0001" },
    });
    await expect(
      service.post({ sceneId: "scene-1", body: "x" }),
    ).rejects.toMatchObject({ code: "quota-exceeded" });

    // a malformed success response is an error, not a blank comment
    mockRpc.mockResolvedValue({ data: { nope: true }, error: null });
    await expect(service.edit("c1", "x")).rejects.toBeInstanceOf(BackendError);
  });

  it("subscribes to filtered INSERT/UPDATE and an unfiltered DELETE", () => {
    const service = createSupabaseCommentService();
    const onSignal = vi.fn();
    const onStatus = vi.fn();
    const unsubscribe = service.subscribe("scene-1", { onSignal, onStatus });
    const [channel] = channels;
    expect(channel.topic).toMatch(/^scene-comments:scene-1:\d+$/);

    const changes = channel.bindings.filter(
      (binding) => binding.type === "postgres_changes",
    );
    expect(changes.map((binding) => binding.filter)).toEqual([
      {
        event: "INSERT",
        schema: "public",
        table: "scene_comments",
        filter: "scene_id=eq.scene-1",
      },
      {
        event: "UPDATE",
        schema: "public",
        table: "scene_comments",
        filter: "scene_id=eq.scene-1",
      },
      { event: "DELETE", schema: "public", table: "scene_comments" },
    ]);
    expect(onStatus).toHaveBeenLastCalledWith("connecting");

    // the row content is ignored; a change is only a signal
    changes[0].handler({ new: { body: "leak?" } });
    expect(onSignal).toHaveBeenLastCalledWith({ kind: "changed" });
    changes[2].handler({ old: { id: "c9" } });
    expect(onSignal).toHaveBeenLastCalledWith({ kind: "removed", id: "c9" });
    changes[2].handler({ old: {} });
    expect(onSignal).toHaveBeenCalledTimes(2);

    channel.subscribeCallback!("SUBSCRIBED");
    expect(onStatus).toHaveBeenLastCalledWith("live");
    channel.subscribeCallback!("CHANNEL_ERROR");
    expect(onStatus).toHaveBeenLastCalledWith("unavailable");

    // the system ack after (re)joining: live again, and pull once more
    const system = channel.bindings.find(
      (binding) => binding.type === "system",
    )!;
    system.handler({ status: "ok" });
    expect(onStatus).toHaveBeenLastCalledWith("live");
    expect(onSignal).toHaveBeenLastCalledWith({ kind: "changed" });
    system.handler({ status: "error" });
    expect(onStatus).toHaveBeenLastCalledWith("unavailable");

    unsubscribe();
    expect(mockRemoveChannel).toHaveBeenCalledTimes(1);
    const calls = onSignal.mock.calls.length;
    changes[0].handler({});
    channel.subscribeCallback!("CLOSED");
    expect(onSignal).toHaveBeenCalledTimes(calls);
    expect(onStatus).toHaveBeenLastCalledWith("unavailable");
  });

  it("gives every subscription its own channel", () => {
    const service = createSupabaseCommentService();
    const handlers = { onSignal: vi.fn(), onStatus: vi.fn() };
    service.subscribe("scene-1", handlers);
    service.subscribe("scene-1", handlers);
    expect(channels[0].topic).not.toBe(channels[1].topic);
  });
});
