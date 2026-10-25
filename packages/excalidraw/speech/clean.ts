// Pure text clean-up for Web Speech API results (ADR 0034 §7).
//
// Chrome's on-device recognizer puts a space between every CJK character and
// Edge sends empty-string finals; neither adds punctuation reliably, so we
// never try to add any.

/** Han, kana and CJK punctuation; Hangul is excluded (Korean uses spaces). */
const CJK =
  "\\u2E80-\\u2FDF\\u3000-\\u303F\\u3040-\\u30FF\\u31F0-\\u31FF\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF\\uFF00-\\uFF60";
const CJK_CHAR = new RegExp(`[${CJK}]`);
const SPACE_BETWEEN_CJK = new RegExp(`(?<=[${CJK}])\\s+(?=[${CJK}])`, "g");

export const isCJKChar = (char: string | undefined) =>
  !!char && CJK_CHAR.test(char);

/** One recognition result: trims, collapses spaces, removes CJK gaps. */
export const cleanTranscriptSegment = (text: string) =>
  text.replace(/\s+/g, " ").trim().replace(SPACE_BETWEEN_CJK, "");

/**
 * Joins two cleaned segments: no space at a CJK boundary on either side,
 * one space between Latin words.
 */
export const joinTranscriptSegments = (left: string, right: string) => {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  const last = Array.from(left).pop();
  const first = Array.from(right)[0];
  return isCJKChar(last) || isCJKChar(first)
    ? `${left}${right}`
    : `${left} ${right}`;
};

/** Cleans and merges final results, dropping empty ones. */
export const cleanTranscript = (segments: readonly string[]) =>
  segments
    .map(cleanTranscriptSegment)
    .filter(Boolean)
    .reduce(joinTranscriptSegments, "");
