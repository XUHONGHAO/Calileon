import { detectCodeBlocks, hasMermaidCodeBlock } from "./codeBlockDetector";

describe("codeBlockDetector", () => {
  it("detects a single code block", () => {
    const blocks = detectCodeBlocks("Here:\n```\nconst x = 1;\n```");

    expect(blocks).toEqual([{ language: "", code: "const x = 1;" }]);
  });

  it("detects multiple code blocks with languages", () => {
    const blocks = detectCodeBlocks(
      "```mermaid\ngraph TD\nA-->B\n```\nText\n```html\n<div />\n```",
    );

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      language: "mermaid",
      code: "graph TD\nA-->B",
    });
    expect(blocks[1]).toEqual({ language: "html", code: "<div />" });
  });

  it("detects mermaid blocks", () => {
    expect(hasMermaidCodeBlock("```mermaid\ngraph TD\nA-->B\n```")).toBe(true);
    expect(hasMermaidCodeBlock("```\nconst x = 1;\n```")).toBe(false);
  });
});
