import { detectCodeBlocks } from "./codeBlockDetector";

import type { DetectedPrompt } from "./types";

const IMAGE_PROMPT_KEYWORDS = [
  "photography",
  "photo",
  "realistic",
  "style",
  "lighting",
  "composition",
  "quality",
  "detailed",
  "4k",
  "8k",
  "render",
  "art",
  "painting",
  "illustration",
  "cinematic",
  "portrait",
  "background",
  "texture",
];

export const detectPrompt = (content: string): DetectedPrompt | null => {
  const codeBlocks = detectCodeBlocks(content);

  for (const block of codeBlocks) {
    const lowerCode = block.code.toLowerCase();
    const keywordCount = IMAGE_PROMPT_KEYWORDS.filter((keyword) =>
      lowerCode.includes(keyword),
    ).length;

    if (keywordCount >= 3) {
      return {
        text: block.code,
        confidence: Math.min(keywordCount / 8, 1),
      };
    }
  }

  return null;
};
