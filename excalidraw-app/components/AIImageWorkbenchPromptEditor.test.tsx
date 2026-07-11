import { fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import { vi } from "vitest";

import { PromptEditor } from "./AIImageWorkbenchPromptEditor";

import type { PromptEditorHandle } from "./AIImageWorkbenchPromptEditor";

const getEditor = (container: HTMLElement) =>
  container.querySelector('[role="textbox"]') as HTMLElement;

describe("PromptEditor", () => {
  it("renders plain text (no highlight spans) when referenceCount is 0", () => {
    const { container } = render(
      <PromptEditor
        value="use #1 as base"
        referenceCount={0}
        onChange={vi.fn()}
        onCaretChange={vi.fn()}
      />,
    );

    const editor = getEditor(container);
    expect(editor.textContent).toBe("use #1 as base");
    expect(
      editor.querySelectorAll(".AIImageWorkbench__promptRef"),
    ).toHaveLength(0);
  });

  it("highlights in-range references and marks out-of-range ones invalid", () => {
    const { container } = render(
      <PromptEditor
        value="blend #1 and #5"
        referenceCount={2}
        onChange={vi.fn()}
        onCaretChange={vi.fn()}
      />,
    );

    const editor = getEditor(container);
    const refs = editor.querySelectorAll(".AIImageWorkbench__promptRef");
    expect(refs).toHaveLength(2);
    expect(refs[0].textContent).toBe("#1");
    expect(refs[0].classList.contains("is-invalid")).toBe(false);
    expect(refs[1].textContent).toBe("#5");
    expect(refs[1].classList.contains("is-invalid")).toBe(true);
  });

  it("repaints highlights when referenceCount changes but text does not", () => {
    // Regression: typing first, then adding a reference image, must light up
    // the existing #1 token. The old guard compared only textContent and
    // skipped the repaint because the text was unchanged.
    const { container, rerender } = render(
      <PromptEditor
        value="use #1 here"
        referenceCount={0}
        onChange={vi.fn()}
        onCaretChange={vi.fn()}
      />,
    );

    const editor = getEditor(container);
    expect(
      editor.querySelectorAll(".AIImageWorkbench__promptRef"),
    ).toHaveLength(0);

    rerender(
      <PromptEditor
        value="use #1 here"
        referenceCount={1}
        onChange={vi.fn()}
        onCaretChange={vi.fn()}
      />,
    );

    const refs = editor.querySelectorAll(".AIImageWorkbench__promptRef");
    expect(refs).toHaveLength(1);
    expect(refs[0].textContent).toBe("#1");
  });

  it("exposes a textarea-compatible value via the imperative handle", () => {
    const handle = createRef<PromptEditorHandle>();
    const onChange = vi.fn();
    const { container } = render(
      <PromptEditor
        ref={handle}
        value=""
        referenceCount={0}
        onChange={onChange}
        onCaretChange={vi.fn()}
      />,
    );

    const editor = getEditor(container);
    editor.textContent = "hello";
    fireEvent.input(editor);

    expect(onChange).toHaveBeenCalledWith("hello");
  });
});
