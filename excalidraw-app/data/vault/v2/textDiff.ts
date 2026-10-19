/**
 * Vault v2 · full-string → splice conversion (ported from the P4c W0 spike).
 *
 * The editor (`textWysiwyg` → `App.handleTextWysiwyg.onChange`) only ever hands
 * us the *whole* next `originalText`. A character-level CRDT needs a splice
 * `(index, deleteCount, insert)`, so every keystroke goes through this diff.
 *
 * - O(n) common prefix/suffix scan on UTF-16 code units (the index space of
 *   both `textarea.selectionStart` and `Y.Text`);
 * - never cuts a surrogate pair: an emoji is either kept or replaced whole;
 * - optional caret hint (`selectionEnd` after the edit) disambiguates repeated
 *   characters ("aa" → "aaa": which `a` was typed?). Without the hint the
 *   splice is placed as late as possible, which can move a concurrent remote
 *   insert to the "wrong" side of the typed character (W0 spike tests/02).
 */
export type Splice = {
  readonly index: number;
  readonly deleteCount: number;
  readonly insert: string;
};

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

export const EMPTY_SPLICE: Splice = { index: 0, deleteCount: 0, insert: "" };

export const applySplice = (text: string, splice: Splice): string =>
  text.slice(0, splice.index) +
  splice.insert +
  text.slice(splice.index + splice.deleteCount);

export const isNoop = (splice: Splice) =>
  splice.deleteCount === 0 && splice.insert.length === 0;

export const diffText = (
  prev: string,
  next: string,
  caretAfter?: number,
): Splice => {
  if (prev === next) {
    return EMPTY_SPLICE;
  }

  // caret-anchored fast path: pure insert or pure delete ending at the caret
  if (caretAfter !== undefined) {
    const delta = next.length - prev.length;
    if (delta > 0) {
      const start = caretAfter - delta;
      if (
        start >= 0 &&
        next.slice(0, start) === prev.slice(0, start) &&
        next.slice(caretAfter) === prev.slice(start) &&
        !isLow(next.charCodeAt(start)) &&
        !isLow(next.charCodeAt(caretAfter))
      ) {
        return {
          index: start,
          deleteCount: 0,
          insert: next.slice(start, caretAfter),
        };
      }
    } else if (delta < 0) {
      const removed = -delta;
      if (
        caretAfter >= 0 &&
        caretAfter <= next.length &&
        prev.slice(0, caretAfter) === next.slice(0, caretAfter) &&
        prev.slice(caretAfter + removed) === next.slice(caretAfter) &&
        !isLow(prev.charCodeAt(caretAfter)) &&
        !isLow(prev.charCodeAt(caretAfter + removed))
      ) {
        return { index: caretAfter, deleteCount: removed, insert: "" };
      }
    }
  }

  const max = Math.min(prev.length, next.length);
  let start = 0;
  while (start < max && prev.charCodeAt(start) === next.charCodeAt(start)) {
    start++;
  }
  // the shared prefix must not end on a high surrogate whose low half differs
  if (start > 0 && isHigh(prev.charCodeAt(start - 1))) {
    start--;
  }

  let endPrev = prev.length;
  let endNext = next.length;
  while (
    endPrev > start &&
    endNext > start &&
    prev.charCodeAt(endPrev - 1) === next.charCodeAt(endNext - 1)
  ) {
    endPrev--;
    endNext--;
  }
  // the shared suffix must not begin with a low surrogate whose high half differs
  if (endPrev < prev.length && isLow(prev.charCodeAt(endPrev))) {
    endPrev++;
    endNext++;
  }

  return {
    index: start,
    deleteCount: endPrev - start,
    insert: next.slice(start, endNext),
  };
};
