import { atom } from "../editor-jotai";

import type { AudioPlaybackState } from "./player";

/** a recording session started by clicking the canvas with the voice tool */
export type VoiceSession = {
  id: string;
  /** scene coords of the click; the bubble's avatar is centred here */
  sceneX: number;
  sceneY: number;
  /** element under the click the bubble will be attached to (ADR 0034 R5) */
  hostId: string | null;
};

export const voiceSessionAtom = atom<VoiceSession | null>(null);

export const audioPlaybackAtom = atom<AudioPlaybackState | null>(null);

/** the audio bubble whose transcript popover is open (local, not synced) */
export const transcriptPopoverAtom = atom<string | null>(null);

/** latest voice status message for the aria-live region */
export const audioAnnouncementAtom = atom<string>("");
