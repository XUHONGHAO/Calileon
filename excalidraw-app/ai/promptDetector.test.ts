import { detectPrompt } from "./promptDetector";

describe("promptDetector", () => {
  it("detects image prompts in code blocks", () => {
    const result = detectPrompt(
      "Optimized:\n```\nA cat, realistic photography, soft lighting, detailed fur, 4k quality\n```",
    );

    expect(result?.text).toContain("realistic photography");
    expect(result?.confidence).toBeGreaterThan(0);
  });

  it("does not detect regular code", () => {
    expect(detectPrompt("```\nconst x = 1;\n```")).toBeNull();
  });
});
