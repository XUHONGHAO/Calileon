import { describe, expect, it } from "vitest";

import {
  RorschachParseError,
  countCodePoints,
  countWords,
  parseRorschachReading,
} from "./rorschachReading";

const answer = (reading: string, imagePrompt = "a bird made of strokes") =>
  JSON.stringify({ reading, imagePrompt });

describe("rorschachReading", () => {
  it("parses a plain JSON answer", () => {
    expect(
      parseRorschachReading(answer("我看到一只想飞的鸟"), "zh-CN"),
    ).toEqual({
      reading: "我看到一只想飞的鸟",
      imagePrompt: "a bird made of strokes",
    });
  });

  it("tolerates a single json markdown fence", () => {
    const fenced = `\`\`\`json\n${answer("I see a running figure")}\n\`\`\``;
    expect(parseRorschachReading(fenced, "en").reading).toBe(
      "I see a running figure",
    );
    const bareFence = `\`\`\`\n${answer("I see a bird")}\n\`\`\``;
    expect(parseRorschachReading(bareFence, "en").reading).toBe("I see a bird");
  });

  it.each([
    ["", "not-json"],
    ["not json at all", "not-json"],
    ["[1,2,3]", "not-object"],
    ['"just a string"', "not-object"],
    [JSON.stringify({ imagePrompt: "x" }), "missing-reading"],
    [JSON.stringify({ reading: "x" }), "missing-image-prompt"],
    [JSON.stringify({ reading: "  ", imagePrompt: "x" }), "missing-reading"],
    [JSON.stringify({ reading: 5, imagePrompt: "x" }), "missing-reading"],
  ])("rejects %s", (raw, code) => {
    expect(() => parseRorschachReading(raw, "zh-CN")).toThrowError(
      RorschachParseError,
    );
    try {
      parseRorschachReading(raw, "zh-CN");
    } catch (error) {
      expect((error as RorschachParseError).code).toBe(code);
    }
  });

  it("rejects prose around the JSON object", () => {
    expect(() =>
      parseRorschachReading(`Here you go: ${answer("我看到一只鸟")}`, "zh-CN"),
    ).toThrowError(RorschachParseError);
  });

  it("enforces 40 code points for Chinese locales", () => {
    const ok = "我".repeat(40);
    expect(countCodePoints(ok)).toBe(40);
    expect(parseRorschachReading(answer(ok), "zh-CN").reading).toBe(ok);
    // Surrogate pairs count as one code point, not two UTF-16 units.
    const emoji = "🐦".repeat(40);
    expect(parseRorschachReading(answer(emoji), "zh-TW").reading).toBe(emoji);
    expect(() =>
      parseRorschachReading(answer("我".repeat(41)), "zh-CN"),
    ).toThrowError(RorschachParseError);
  });

  it("enforces 20 words for English", () => {
    const twenty = Array.from(
      { length: 20 },
      (_, index) => `word${index}`,
    ).join(" ");
    expect(countWords(twenty)).toBe(20);
    expect(parseRorschachReading(answer(twenty), "en").reading).toBe(twenty);
    expect(() =>
      parseRorschachReading(answer(`${twenty} extra`), "en"),
    ).toThrowError(RorschachParseError);
    // Long-but-few-words English is allowed; the rule is words, not chars.
    const longWords = "a".repeat(120);
    expect(
      parseRorschachReading(answer(`${longWords} ${longWords}`), "en").reading,
    ).toBe(`${longWords} ${longWords}`);
  });

  it("rejects an over-long image prompt", () => {
    expect(() =>
      parseRorschachReading(answer("我看到一只鸟", "x".repeat(2001)), "zh-CN"),
    ).toThrowError(RorschachParseError);
  });

  it("ignores unknown extra fields instead of trusting them", () => {
    const raw = JSON.stringify({
      reading: "我看到一只鸟",
      imagePrompt: "bird",
      apiKey: "secret",
      hidden: { url: "https://example.test" },
    });
    expect(parseRorschachReading(raw, "zh-CN")).toEqual({
      reading: "我看到一只鸟",
      imagePrompt: "bird",
    });
  });
});
