import { describe, expect, it } from "vitest";

import { getCommentAvailability } from "./availability";

import type { CommentContext } from "./availability";

const plain = {
  id: "scene-1",
  ownerId: "owner-1",
  payloadKind: "plain",
} as const;

const context = (patch: Partial<CommentContext> = {}): CommentContext => ({
  enabled: true,
  isSignedIn: true,
  cloudScene: null,
  sharedScene: null,
  isEmbedded: false,
  isVault: false,
  isCollaborating: false,
  isSingleFile: false,
  ...patch,
});

// one case per row of technical design §9.4
describe("getCommentAvailability", () => {
  it("deployment without comments", () => {
    expect(
      getCommentAvailability(context({ enabled: false, cloudScene: plain })),
    ).toEqual({ kind: "unsupported-deployment" });
  });

  it("local board, not saved to the cloud", () => {
    expect(getCommentAvailability(context())).toEqual({
      kind: "unsupported-context",
      reason: "local",
    });
    expect(getCommentAvailability(context({ isSignedIn: false }))).toEqual({
      kind: "unsupported-context",
      reason: "local",
    });
  });

  it("owner on their own cloud board", () => {
    expect(getCommentAvailability(context({ cloudScene: plain }))).toEqual({
      kind: "ready",
      sceneId: "scene-1",
      ownerId: "owner-1",
      shareToken: null,
    });
  });

  it("signed-in visitor through a #cloud= link carries the token", () => {
    expect(
      getCommentAvailability(
        context({ sharedScene: { ...plain, token: "tok" } }),
      ),
    ).toEqual({
      kind: "ready",
      sceneId: "scene-1",
      ownerId: "owner-1",
      shareToken: "tok",
    });
  });

  it("signed-out visitor through a #cloud= link", () => {
    expect(
      getCommentAvailability(
        context({ isSignedIn: false, sharedScene: { ...plain, token: "tok" } }),
      ),
    ).toEqual({ kind: "signed-out", sceneId: "scene-1" });
  });

  it("collaboration room, also when bound to a cloud board", () => {
    expect(
      getCommentAvailability(
        context({ isCollaborating: true, cloudScene: plain }),
      ),
    ).toEqual({ kind: "unsupported-context", reason: "room" });
  });

  it("vault, embed and single-file", () => {
    expect(
      getCommentAvailability(context({ isVault: true, cloudScene: plain })),
    ).toEqual({ kind: "unsupported-context", reason: "vault" });
    expect(
      getCommentAvailability(context({ isEmbedded: true, cloudScene: plain })),
    ).toEqual({ kind: "unsupported-context", reason: "embed" });
    expect(
      getCommentAvailability(
        context({ isSingleFile: true, cloudScene: plain }),
      ),
    ).toEqual({ kind: "unsupported-context", reason: "single-file" });
  });

  it("end-to-end encrypted cloud board, even signed out", () => {
    const encrypted = { ...plain, payloadKind: "encrypted" } as const;
    expect(getCommentAvailability(context({ cloudScene: encrypted }))).toEqual({
      kind: "unsupported-context",
      reason: "encrypted",
    });
    expect(
      getCommentAvailability(
        context({
          isSignedIn: false,
          sharedScene: { ...encrypted, token: "tok" },
        }),
      ),
    ).toEqual({ kind: "unsupported-context", reason: "encrypted" });
  });
});
