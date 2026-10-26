/**
 * Length limits shared with schema_comments.sql. The server counts characters
 * (code points) of the trimmed text and is the authority; these only drive the
 * counter and the send button.
 */

export const COMMENT_MAX_LENGTH = 4000;
/** the counter appears from here on (technical design §11.2) */
export const COMMENT_COUNTER_FROM = 3800;
export const DELETE_REASON_MAX_LENGTH = 500;

export const countChars = (text: string): number =>
  Array.from(text.trim()).length;

/** Enter that finishes an IME composition must not send (§11.2). */
export const isComposingEnter = (event: {
  key: string;
  nativeEvent: { isComposing?: boolean; keyCode?: number };
}): boolean =>
  event.key === "Enter" &&
  (!!event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229);
