import type { AppProps, Collaborator, SocketId } from "../types";

/**
 * Element types this client understands beyond the original set. Announced
 * to collaborators (`Collaborator.elementTypes`) so peers can tell when an
 * old client in the room would drop them (ADR 0034 §10).
 */
export const SUPPORTED_ELEMENT_TYPE_CAPABILITIES: readonly string[] = ["audio"];

export type VoiceRecordingBlock =
  | { kind: "disabled" }
  | { kind: "host"; message: string }
  | { kind: "outdatedCollaborators" };

/**
 * Why recording is unavailable right now, or `null` when it is allowed.
 * Existing audio elements stay playable either way.
 */
export const getVoiceRecordingBlock = (
  voiceOptions: AppProps["voiceOptions"],
  isCollaborating: boolean,
  collaborators: ReadonlyMap<SocketId, Collaborator>,
): VoiceRecordingBlock | null => {
  if (!voiceOptions?.enabled) {
    return { kind: "disabled" };
  }
  if (voiceOptions.disabledReason) {
    return { kind: "host", message: voiceOptions.disabledReason };
  }
  if (isCollaborating) {
    for (const collaborator of collaborators.values()) {
      if (
        !collaborator.isCurrentUser &&
        !collaborator.elementTypes?.includes("audio")
      ) {
        return { kind: "outdatedCollaborators" };
      }
    }
  }
  return null;
};
