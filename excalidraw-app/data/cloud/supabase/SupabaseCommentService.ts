/**
 * SupabaseCommentService — scene comments over the RPCs in
 * schema_comments.sql (ADR 0037). Every write is an RPC; the table itself is
 * only read through Realtime, and even then a change is just a signal to pull
 * through `list_scene_comments`, which owns all visibility rules.
 */

import { getSupabaseClient } from "./client";
import {
  rowToSceneComment,
  rowToSceneCommentJoin,
  rowToSceneCommentPage,
  toDeleteOutcome,
  toIso,
} from "./commentMappers";
import { mapCommentError } from "./errorMapping";

import type {
  SceneComment,
  SceneCommentChannelStatus,
  SceneCommentDeleteOutcome,
  SceneCommentJoinResult,
  SceneCommentPage,
  SceneCommentService,
  SceneCommentSignal,
  SceneCommentStatus,
} from "../types";

const call = async (
  fn: string,
  params: Record<string, unknown>,
): Promise<unknown> => {
  const { data, error } = await getSupabaseClient().rpc(fn, params);
  if (error) {
    throw mapCommentError(error);
  }
  return data;
};

const toComment = (data: unknown): SceneComment => {
  const comment = rowToSceneComment(data);
  if (!comment) {
    throw mapCommentError(null);
  }
  return comment;
};

let channelSeq = 0;

export const createSupabaseCommentService = (): SceneCommentService => {
  const join = async (
    sceneId: string,
    shareToken: string | null,
  ): Promise<SceneCommentJoinResult> =>
    rowToSceneCommentJoin(
      await call("join_scene_comments", {
        p_scene_id: sceneId,
        p_token: shareToken,
      }),
    );

  const list = async (
    sceneId: string,
    opts: { before?: number } = {},
  ): Promise<SceneCommentPage> =>
    rowToSceneCommentPage(
      await call("list_scene_comments", {
        p_scene_id: sceneId,
        p_before: opts.before === undefined ? null : toIso(opts.before),
      }),
    );

  const listChanges = async (
    sceneId: string,
    since: number,
  ): Promise<SceneCommentPage> =>
    rowToSceneCommentPage(
      await call("list_scene_comments", {
        p_scene_id: sceneId,
        p_since: toIso(since),
      }),
    );

  const post = async (input: {
    sceneId: string;
    body: string;
    quotedId?: string | null;
  }): Promise<SceneComment> =>
    toComment(
      await call("post_scene_comment", {
        p_scene_id: input.sceneId,
        p_body: input.body,
        p_quoted_id: input.quotedId ?? null,
      }),
    );

  const edit = async (id: string, body: string): Promise<SceneComment> =>
    toComment(await call("edit_scene_comment", { p_id: id, p_body: body }));

  const setStatus = async (
    id: string,
    status: SceneCommentStatus,
  ): Promise<SceneComment> =>
    toComment(
      await call("set_scene_comment_status", { p_id: id, p_status: status }),
    );

  const remove = async (
    id: string,
    opts: { reason?: string | null; hideOriginal?: boolean } = {},
  ): Promise<SceneCommentDeleteOutcome> =>
    toDeleteOutcome(
      await call("delete_scene_comment", {
        p_id: id,
        p_reason: opts.reason?.trim() || null,
        p_hide_original: opts.hideOriginal === true,
      }),
    );

  const markSeen = async (sceneId: string): Promise<number> => {
    const data = await call("mark_scene_comments_seen", {
      p_scene_id: sceneId,
    });
    const ms = typeof data === "string" ? Date.parse(data) : NaN;
    return Number.isNaN(ms) ? Date.now() : ms;
  };

  const subscribe = (
    sceneId: string,
    handlers: {
      onSignal: (signal: SceneCommentSignal) => void;
      onStatus: (status: SceneCommentChannelStatus) => void;
    },
  ): (() => void) => {
    const client = getSupabaseClient();
    // a unique topic per subscription: two hooks on one scene must not share
    // (and then tear down) the same channel
    const channel = client.channel(`scene-comments:${sceneId}:${++channelSeq}`);
    let closed = false;
    const signal = (next: SceneCommentSignal) => {
      if (!closed) {
        handlers.onSignal(next);
      }
    };
    const status = (next: SceneCommentChannelStatus) => {
      if (!closed) {
        handlers.onStatus(next);
      }
    };
    status("connecting");
    for (const event of ["INSERT", "UPDATE"] as const) {
      channel.on(
        "postgres_changes",
        {
          event,
          schema: "public",
          table: "scene_comments",
          filter: `scene_id=eq.${sceneId}`,
        },
        // the row in the payload is ignored on purpose (ADR 0037 §6)
        () => signal({ kind: "changed" }),
      );
    }
    // A DELETE carries only the primary key, so a scene_id filter never
    // matches it (measured, M0). Listen unfiltered: ids of other scenes are
    // unknown locally and dropped by the caller.
    channel.on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "scene_comments" },
      (payload) => {
        const id = (payload.old as { id?: unknown } | null)?.id;
        if (typeof id === "string") {
          signal({ kind: "removed", id });
        }
      },
    );
    // "Subscribed to PostgreSQL" arrives after SUBSCRIBED and after every
    // rejoin; changes before it may be missed, so pull once more then.
    channel.on("system", {}, (payload: { status?: unknown }) => {
      if (payload?.status === "ok") {
        status("live");
        signal({ kind: "changed" });
      } else if (payload?.status === "error") {
        status("unavailable");
      }
    });
    channel.subscribe((state) => {
      status(state === "SUBSCRIBED" ? "live" : "unavailable");
    });

    return () => {
      closed = true;
      void client.removeChannel(channel);
    };
  };

  return {
    isAvailable: () => true,
    join,
    list,
    listChanges,
    post,
    edit,
    setStatus,
    remove,
    markSeen,
    subscribe,
  };
};
