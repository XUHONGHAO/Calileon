import { cleanMermaidCode } from "./mermaidCleaner";

describe("cleanMermaidCode", () => {
  it("should remove markdown code blocks", () => {
    const input = "```mermaid\nflowchart TD\n  A[Test]\n```";
    const expected = "flowchart TD\n  A[Test]";

    expect(cleanMermaidCode(input)).toBe(expected);
  });

  it("should convert double quotes to single quotes", () => {
    const input = 'flowchart TD\n  A["Test"]';
    const expected = "flowchart TD\n  A['Test']";

    expect(cleanMermaidCode(input)).toBe(expected);
  });

  it("should replace <br/> with \\n inside quotes", () => {
    const input = "flowchart TD\n  A['Line1<br/>Line2']";
    const expected = "flowchart TD\n  A['Line1\\nLine2']";

    expect(cleanMermaidCode(input)).toBe(expected);
  });

  it("should remove slash from <br/> outside quotes", () => {
    const input = "flowchart TD\n  A[Line1<br/>Line2]";
    const expected = "flowchart TD\n  A[Line1<br>Line2]";

    expect(cleanMermaidCode(input)).toBe(expected);
  });

  it("should remove other HTML tags", () => {
    const input = "flowchart TD\n  A['<div>Test</div>']";
    const expected = "flowchart TD\n  A['Test']";

    expect(cleanMermaidCode(input)).toBe(expected);
  });

  it("should handle complex mixed cases", () => {
    const input =
      '```mermaid\nflowchart TD\n  A["<b>Bold</b><br/>Text"]\n  B[Simple<br/>Line]\n```';
    const expected = "flowchart TD\n  A['Bold\\nText']\n  B[Simple<br>Line]";

    expect(cleanMermaidCode(input)).toBe(expected);
  });

  it("should preserve valid Mermaid code", () => {
    const input = "flowchart TD\n  A[Start] --> B[End]";

    expect(cleanMermaidCode(input)).toBe(input);
  });
});
