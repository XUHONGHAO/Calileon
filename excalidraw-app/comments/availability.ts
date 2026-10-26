/**
 * Whether the current board can have comments, and if not, why (ADR 0037 §7,
 * technical design §9.4). Comments exist only for signed-in users on plain
 * cloud whiteboards, including ones opened through a `#cloud=` share link.
 */

export type CommentUnsupportedReason =
  | "local"
  | "room"
  | "vault"
  | "embed"
  | "single-file"
  | "encrypted";

export type CommentAvailability =
  | { kind: "unsupported-deployment" }
  | { kind: "unsupported-context"; reason: CommentUnsupportedReason }
  | { kind: "signed-out"; sceneId: string }
  | {
      kind: "ready";
      sceneId: string;
      ownerId: string;
      /** null for the owner's own scene; a token for `#cloud=` visitors */
      shareToken: string | null;
    };

type SceneRef = {
  id: string;
  ownerId: string;
  payloadKind: "plain" | "encrypted";
};

export type CommentContext = {
  /** capabilities.sceneComments */
  enabled: boolean;
  isSignedIn: boolean;
  /** the board the signed-in user saved or opened from their scene list */
  cloudScene: SceneRef | null;
  /** a board opened through a `#cloud=` share link */
  sharedScene: (SceneRef & { token: string }) | null;
  isEmbedded: boolean;
  isVault: boolean;
  isCollaborating: boolean;
  isSingleFile: boolean;
};

export const getCommentAvailability = (
  context: CommentContext,
): CommentAvailability => {
  if (!context.enabled) {
    return { kind: "unsupported-deployment" };
  }
  // end-to-end encrypted contexts first: their content never reaches the
  // server, so plain-text comments next to them would break that promise
  if (context.isSingleFile) {
    return { kind: "unsupported-context", reason: "single-file" };
  }
  if (context.isVault) {
    return { kind: "unsupported-context", reason: "vault" };
  }
  if (context.isEmbedded) {
    return { kind: "unsupported-context", reason: "embed" };
  }
  // a room bound to a cloud scene included (Q5)
  if (context.isCollaborating) {
    return { kind: "unsupported-context", reason: "room" };
  }

  const scene = context.sharedScene ?? context.cloudScene;
  if (!scene || !scene.id) {
    return { kind: "unsupported-context", reason: "local" };
  }
  if (scene.payloadKind === "encrypted") {
    return { kind: "unsupported-context", reason: "encrypted" };
  }
  if (!context.isSignedIn) {
    return { kind: "signed-out", sceneId: scene.id };
  }
  return {
    kind: "ready",
    sceneId: scene.id,
    ownerId: scene.ownerId,
    shareToken: context.sharedScene?.token ?? null,
  };
};

/** The page itself runs from a downloaded single-file board (`file://`). */
export const isSingleFileRuntime = (): boolean =>
  typeof window !== "undefined" && window.location.protocol === "file:";
