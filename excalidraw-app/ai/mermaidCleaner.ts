/**
 * Clean AI-generated Mermaid code to prevent parsing errors in strict mode.
 *
 * Strict security mode forbids HTML tags, so we need to:
 * 1. Remove markdown code blocks
 * 2. Convert double quotes to single quotes
 * 3. Handle line breaks correctly (inside vs outside quotes)
 * 4. Remove other HTML tags
 */

const replaceBrInQuotes = (code: string): string => {
  return code.replace(/'([^']*)'/g, (match, content) => {
    const cleaned = content.replace(/<br\s*\/?>/gi, "\\n");

    return `'${cleaned}'`;
  });
};

export const cleanMermaidCode = (code: string): string => {
  let cleaned = code.trim();

  cleaned = cleaned.replace(/^```(?:mermaid)?\s*\n?/i, "");
  cleaned = cleaned.replace(/\n?```\s*$/i, "");

  cleaned = cleaned.replace(/"/g, "'");
  cleaned = replaceBrInQuotes(cleaned);
  cleaned = cleaned.replace(/<br\s*\/>/gi, "<br>");
  cleaned = cleaned.replace(/<(?!br\b)[^>]+>/gi, "");

  return cleaned.trim();
};
