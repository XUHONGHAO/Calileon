import { getDictationInsertion } from "./dictation";
import {
  cleanTranscript,
  cleanTranscriptSegment,
  joinTranscriptSegments,
} from "./clean";
import { getSpeechLang } from "./lang";

describe("transcript clean-up (ADR 0034 §7)", () => {
  it("removes single spaces between CJK characters", () => {
    expect(cleanTranscriptSegment("你 好 世 界")).toBe("你好世界");
    expect(cleanTranscriptSegment("こ ん に ち は")).toBe("こんにちは");
  });

  it("keeps spaces between Latin words and at CJK/Latin boundaries", () => {
    expect(cleanTranscriptSegment("  hello   world ")).toBe("hello world");
    expect(cleanTranscriptSegment("我 用 Chrome 浏 览 器")).toBe(
      "我用 Chrome 浏览器",
    );
    // Korean separates words with spaces
    expect(cleanTranscriptSegment("안녕 하세요")).toBe("안녕 하세요");
  });

  it("drops empty finals and merges the rest without adding punctuation", () => {
    expect(cleanTranscript(["", "  ", "你 好", "", "世 界"])).toBe("你好世界");
    expect(cleanTranscript(["hello", "", "world"])).toBe("hello world");
    expect(cleanTranscript(["", " "])).toBe("");
  });

  it("joins segments with a space only between Latin words", () => {
    expect(joinTranscriptSegments("你好", "世界")).toBe("你好世界");
    expect(joinTranscriptSegments("hello", "world")).toBe("hello world");
    expect(joinTranscriptSegments("打开", "Chrome")).toBe("打开Chrome");
    expect(joinTranscriptSegments("", "x")).toBe("x");
    expect(joinTranscriptSegments("x", "")).toBe("x");
  });
});

describe("recognition language", () => {
  it("maps every zh-* to zh-CN and fills in common regions", () => {
    expect(getSpeechLang("zh-CN")).toBe("zh-CN");
    expect(getSpeechLang("zh-TW")).toBe("zh-CN");
    expect(getSpeechLang("zh-HK")).toBe("zh-CN");
    expect(getSpeechLang("en")).toBe("en-US");
    expect(getSpeechLang("ja-JP")).toBe("ja-JP");
    expect(getSpeechLang("fi-FI")).toBe("fi-FI");
  });
});

describe("dictation insertion", () => {
  it("adds a space only between Latin words", () => {
    expect(getDictationInsertion("hello", "world")).toBe(" world");
    expect(getDictationInsertion("hello ", "world")).toBe("world");
    expect(getDictationInsertion("你好", "世界")).toBe("世界");
    expect(getDictationInsertion("", " start")).toBe("start");
    expect(getDictationInsertion("abc", "  ")).toBe("");
  });
});
