import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";

import { tokenizePromptReferences } from "./AIImageWorkbenchReferences";

import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from "react";

// A textarea-compatible imperative surface. The surrounding workbench code was
// written against a real <textarea> (character offsets, setSelectionRange,
// value). Exposing the same shape lets contenteditable drop in without
// rewriting insertPromptText / the reference picker / placeholder jumping.
export interface PromptEditorHandle {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  setSelectionRange: (start: number, end: number) => void;
  focus: () => void;
}

interface PromptEditorProps {
  value: string;
  // Number of reference images available; drives which `#n` are in-range. When
  // 0 the editor renders plain text (no highlight) — e.g. text-to-image mode.
  referenceCount: number;
  className?: string;
  placeholder?: string;
  // Accessible name. A contenteditable in a <label> isn't associated the way a
  // form control is, so the name must be set explicitly. Falls back to the
  // placeholder when omitted.
  ariaLabel?: string;
  onChange: (value: string) => void;
  // Fires after value/caret settle so the parent can (re)open the `#` picker.
  onCaretChange: () => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onClick?: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

// --- caret <-> character-offset bridge --------------------------------------
// We only ever build text nodes (bare or inside a single-level span) and rely
// on `white-space: pre-wrap` to render "\n". So a character offset is just the
// cumulative length of textContent walked in document order — no <br> to
// special-case, which keeps the offset math exact and drift-free.

const getCharOffsetOfPoint = (
  root: HTMLElement,
  node: Node,
  nodeOffset: number,
): number => {
  let offset = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

  let current = walker.nextNode();
  while (current) {
    if (current === node) {
      return offset + nodeOffset;
    }
    offset += current.textContent?.length ?? 0;
    current = walker.nextNode();
  }

  // If the point is on an element node (e.g. the root itself), fall back to the
  // total length up to that element's text.
  if (node === root) {
    let elementOffset = 0;
    for (let i = 0; i < nodeOffset && i < node.childNodes.length; i++) {
      elementOffset += node.childNodes[i].textContent?.length ?? 0;
    }
    return elementOffset;
  }

  return offset;
};

const getSelectionOffsets = (
  root: HTMLElement,
): { start: number; end: number } => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    const length = root.textContent?.length ?? 0;
    return { start: length, end: length };
  }

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) {
    const length = root.textContent?.length ?? 0;
    return { start: length, end: length };
  }

  const start = getCharOffsetOfPoint(
    root,
    range.startContainer,
    range.startOffset,
  );
  const end = getCharOffsetOfPoint(root, range.endContainer, range.endOffset);
  return { start, end };
};

// Locates the text node + local offset for an absolute character offset.
const locateOffset = (
  root: HTMLElement,
  target: number,
): { node: Node; offset: number } => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = target;
  let lastText: Text | null = null;

  let current = walker.nextNode() as Text | null;
  while (current) {
    const length = current.textContent?.length ?? 0;
    if (remaining <= length) {
      return { node: current, offset: remaining };
    }
    remaining -= length;
    lastText = current;
    current = walker.nextNode() as Text | null;
  }

  if (lastText) {
    return { node: lastText, offset: lastText.textContent?.length ?? 0 };
  }
  return { node: root, offset: 0 };
};

const setSelectionOffsets = (root: HTMLElement, start: number, end: number) => {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const clampedStart = Math.max(0, start);
  const clampedEnd = Math.max(clampedStart, end);

  const startPoint = locateOffset(root, clampedStart);
  const endPoint = locateOffset(root, clampedEnd);

  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);

  selection.removeAllRanges();
  selection.addRange(range);
};

// --- highlight rendering -----------------------------------------------------
// Rebuilds the editor's DOM from the current value: reference tokens wrapped in
// colored spans, everything else as bare text. Because the colored text *is*
// the real text (single layer), the caret can never drift from it.

const paintHighlights = (
  root: HTMLElement,
  value: string,
  referenceCount: number,
) => {
  const fragment = document.createDocumentFragment();

  if (!referenceCount) {
    fragment.appendChild(document.createTextNode(value));
  } else {
    const segments = tokenizePromptReferences(value, referenceCount);
    for (const segment of segments) {
      if (segment.type === "text") {
        fragment.appendChild(document.createTextNode(segment.text));
        continue;
      }
      const span = document.createElement("span");
      span.className =
        segment.type === "reference"
          ? "AIImageWorkbench__promptRef"
          : "AIImageWorkbench__promptRef is-invalid";
      span.textContent = segment.text;
      fragment.appendChild(span);
    }
  }

  root.replaceChildren(fragment);
};

export const PromptEditor = forwardRef<PromptEditorHandle, PromptEditorProps>(
  (
    {
      value,
      referenceCount,
      className,
      placeholder,
      ariaLabel,
      onChange,
      onCaretChange,
      onKeyDown,
      onClick,
    },
    ref,
  ) => {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const valueRef = useRef(value);
    const isComposingRef = useRef(false);
    // Char offset to restore after a React-driven value change repaints the DOM.
    const pendingCaretRef = useRef<number | null>(null);
    // The (value, referenceCount) the DOM was last painted for. Comparing plain
    // textContent isn't enough: when referenceCount flips (e.g. a reference
    // image is added after text is typed) the text is identical but the span
    // structure must change, so we track the paint inputs explicitly.
    const paintedValueRef = useRef<string | null>(null);
    const paintedRefCountRef = useRef<number | null>(null);

    valueRef.current = value;

    useImperativeHandle(
      ref,
      (): PromptEditorHandle => ({
        get value() {
          return valueRef.current;
        },
        get selectionStart() {
          const root = rootRef.current;
          return root ? getSelectionOffsets(root).start : 0;
        },
        get selectionEnd() {
          const root = rootRef.current;
          return root ? getSelectionOffsets(root).end : 0;
        },
        setSelectionRange(start: number, end: number) {
          const root = rootRef.current;
          if (root) {
            root.focus();
            setSelectionOffsets(root, start, end);
          }
        },
        focus() {
          rootRef.current?.focus();
        },
      }),
      [],
    );

    // Keep the DOM in sync with `value` (highlights included). Runs on every
    // value change — whether from typing, template insertion, or reference
    // token insertion — then restores the caret to the intended offset.
    useLayoutEffect(() => {
      const root = rootRef.current;
      if (!root) {
        return;
      }
      // Never rebuild mid-composition: it would tear the IME's pending text.
      if (isComposingRef.current) {
        return;
      }
      // Nothing to do if neither the text nor the highlight inputs changed and
      // there's no pending caret to restore.
      if (
        paintedValueRef.current === value &&
        paintedRefCountRef.current === referenceCount &&
        pendingCaretRef.current == null
      ) {
        return;
      }

      const caret =
        pendingCaretRef.current != null
          ? pendingCaretRef.current
          : getSelectionOffsets(root).start;

      paintHighlights(root, value, referenceCount);
      paintedValueRef.current = value;
      paintedRefCountRef.current = referenceCount;

      // Only restore the caret when the editor is focused; otherwise leave the
      // selection alone (e.g. value changed while another field has focus).
      if (document.activeElement === root) {
        setSelectionOffsets(root, caret, caret);
      }
      pendingCaretRef.current = null;
    }, [value, referenceCount]);

    const commitFromDom = useCallback(() => {
      const root = rootRef.current;
      if (!root) {
        return;
      }
      // innerText normalizes browser-inserted <div>/<br> line breaks back to
      // "\n", giving us a clean canonical string to re-tokenize from. jsdom
      // doesn't implement innerText, so fall back to textContent there (our DOM
      // never contains <br>/<div>, so the two agree in that environment).
      const text =
        typeof root.innerText === "string"
          ? root.innerText
          : root.textContent ?? "";
      // Remember where the caret is now so the repaint can put it back.
      pendingCaretRef.current = getSelectionOffsets(root).start;
      valueRef.current = text;
      onChange(text);
      onCaretChange();
    }, [onChange, onCaretChange]);

    const handleInput = useCallback(() => {
      if (isComposingRef.current) {
        return;
      }
      commitFromDom();
    }, [commitFromDom]);

    const handleCompositionEnd = useCallback(() => {
      isComposingRef.current = false;
      commitFromDom();
    }, [commitFromDom]);

    const handleCompositionStart = useCallback(() => {
      isComposingRef.current = true;
    }, []);

    // Initial paint on mount.
    useEffect(() => {
      const root = rootRef.current;
      if (root && root.textContent !== value) {
        paintHighlights(root, value, referenceCount);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const isEmpty = value.length === 0;

    return (
      <div
        ref={rootRef}
        className={className}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel ?? placeholder}
        data-placeholder={placeholder}
        data-empty={isEmpty ? "true" : undefined}
        spellCheck={false}
        onInput={handleInput}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onKeyUp={onCaretChange}
        onKeyDown={onKeyDown}
        onClick={onClick}
      />
    );
  },
);

PromptEditor.displayName = "PromptEditor";
