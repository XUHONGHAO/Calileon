import { fireEvent, render } from "@testing-library/react";
import { createRef, useState } from "react";
import { vi } from "vitest";

import {
  getPromptPlainText,
  getPromptTextOffset,
  locatePromptTextOffset,
  PromptEditor,
} from "./AIImageWorkbenchPromptEditor";

import type { RefObject } from "react";
import type { PromptEditorHandle } from "./AIImageWorkbenchPromptEditor";

const getEditor = (container: HTMLElement) =>
  container.querySelector('[role="textbox"]') as HTMLElement;

const ControlledEditor = ({
  editorRef,
  onChange = vi.fn(),
}: {
  editorRef: RefObject<PromptEditorHandle | null>;
  onChange?: (value: string) => void;
}) => {
  const [value, setValue] = useState("");
  return (
    <PromptEditor
      ref={editorRef}
      value={value}
      referenceCount={2}
      onChange={(nextValue) => {
        onChange(nextValue);
        setValue(nextValue);
      }}
      onCaretChange={vi.fn()}
    />
  );
};

const setDomCaret = (node: Node, offset: number) => {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
};

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

  it("normalizes browser multiline DOM and maps both offset directions", () => {
    const root = document.createElement("div");
    root.innerHTML = "first<div>second<br>third</div><p><br></p>";

    expect(getPromptPlainText(root)).toBe("first\nsecond\nthird\n");

    const second = root.querySelector("div")!.firstChild!;
    expect(getPromptTextOffset(root, second, 3)).toBe(9);
    const point = locatePromptTextOffset(root, 6);
    expect(point.node).toBe(second);
    expect(point.offset).toBe(0);

    root.innerHTML = "<div>block</div>inline";
    expect(getPromptPlainText(root)).toBe("block\ninline");
  });

  it("keeps the caret after an Enter-created empty block and continued input", () => {
    const handle = createRef<PromptEditorHandle>();
    const onChange = vi.fn();
    const { container } = render(
      <ControlledEditor editorRef={handle} onChange={onChange} />,
    );
    const editor = getEditor(container);
    editor.focus();
    editor.innerHTML = "first<div><br></div>";
    const emptyLine = editor.querySelector("div")!;
    setDomCaret(emptyLine, 0);

    fireEvent.input(editor);

    expect(onChange).toHaveBeenLastCalledWith("first\n");
    expect(handle.current?.value).toBe("first\n");
    expect(handle.current?.selectionStart).toBe(6);

    editor.textContent = "first\nx";
    setDomCaret(editor.firstChild!, 7);
    fireEvent.input(editor);
    expect(onChange).toHaveBeenLastCalledWith("first\nx");
    expect(handle.current?.selectionStart).toBe(7);
  });

  it("preserves consecutive empty lines and offsets across them", () => {
    const root = document.createElement("div");
    root.innerHTML = "first<div><br></div><div>third</div>";
    expect(getPromptPlainText(root)).toBe("first\n\nthird");

    root.innerHTML =
      "first<div><br></div><div><br></div><div><br></div><div>third</div>";

    expect(getPromptPlainText(root)).toBe("first\n\n\n\nthird");

    const third = root.lastElementChild!.firstChild!;
    expect(getPromptTextOffset(root, third, 0)).toBe(9);
    const point = locatePromptTextOffset(root, 8);
    expect(root.contains(point.node)).toBe(true);
  });

  it("preserves a cross-line selection through highlighted repaint", () => {
    const handle = createRef<PromptEditorHandle>();
    const { container } = render(<ControlledEditor editorRef={handle} />);
    const editor = getEditor(container);
    editor.focus();
    editor.innerHTML = "one<div>#1 two</div>";
    const firstText = editor.firstChild!;
    const secondText = editor.querySelector("div")!.firstChild!;
    const range = document.createRange();
    range.setStart(firstText, 1);
    range.setEnd(secondText, 4);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.input(editor);

    expect(handle.current?.value).toBe("one\n#1 two");
    expect(handle.current?.selectionStart).toBe(1);
    expect(handle.current?.selectionEnd).toBe(8);
  });

  it("commits IME multiline text once without moving the caret backward", () => {
    const handle = createRef<PromptEditorHandle>();
    const onChange = vi.fn();
    const { container } = render(
      <ControlledEditor editorRef={handle} onChange={onChange} />,
    );
    const editor = getEditor(container);
    editor.focus();
    fireEvent.compositionStart(editor);
    editor.innerHTML = "第一行<div>第二行</div>";
    const secondLine = editor.querySelector("div")!.firstChild!;
    setDomCaret(secondLine, secondLine.textContent!.length);
    fireEvent.input(editor);
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.compositionEnd(editor);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("第一行\n第二行");
    expect(handle.current?.selectionStart).toBe("第一行\n第二行".length);

    fireEvent.input(editor);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
