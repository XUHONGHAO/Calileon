import { EDITOR_LS_KEYS } from "@excalidraw/common";

import { EditorLocalStorage } from "../data/EditorLocalStorage";

/** The user switched live transcription of voice messages off. */
export const isTranscriptionTurnedOff = () =>
  EditorLocalStorage.get<boolean>(EDITOR_LS_KEYS.VOICE_TRANSCRIPTION_OFF) ===
  true;

export const setTranscriptionTurnedOff = (off: boolean) => {
  if (off) {
    EditorLocalStorage.set(EDITOR_LS_KEYS.VOICE_TRANSCRIPTION_OFF, true);
  } else {
    EditorLocalStorage.delete(EDITOR_LS_KEYS.VOICE_TRANSCRIPTION_OFF);
  }
};

/** The one-time "speech may go to the browser vendor" notice was answered. */
export const hasSeenTranscriptionNotice = () =>
  EditorLocalStorage.get<boolean>(
    EDITOR_LS_KEYS.VOICE_TRANSCRIPTION_NOTICE_SEEN,
  ) === true;

export const markTranscriptionNoticeSeen = () => {
  EditorLocalStorage.set(EDITOR_LS_KEYS.VOICE_TRANSCRIPTION_NOTICE_SEEN, true);
};
