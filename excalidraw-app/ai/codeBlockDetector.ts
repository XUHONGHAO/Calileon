import type { ChatCodeBlock } from "./types";

export const detectCodeBlocks = (content: string): ChatCodeBlock[] => {
  const codeBlockRegex = /```([^\n`]*)\n?([\s\S]*?)```/g;
  const blocks: ChatCodeBlock[] = [];
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    const code = match[2].trim();

    if (!code) {
      continue;
    }

    blocks.push({
      language: match[1].trim(),
      code,
    });
  }

  return blocks;
};

export const hasMermaidCodeBlock = (content: string) => {
  return detectCodeBlocks(content).some((block) => {
    const language = block.language.toLowerCase();
    const code = block.code.trim().toLowerCase();

    return (
      language === "mermaid" ||
      /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie)\b/.test(
        code,
      )
    );
  });
};
