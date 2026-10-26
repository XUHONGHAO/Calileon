import { atom } from "../editor-jotai";

import type { VideoPlaybackState } from "./player";

/** the video element currently playing in the DOM overlay (local only) */
export const videoPlaybackAtom = atom<VideoPlaybackState | null>(null);
