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
// Repainted content uses text nodes, but native editing may temporarily create
// <br>, <div>, or <p> line structure. Extraction and selection restoration use
// the same index so structural newlines cannot make the caret drift.

const BLOCK_TAGS = new Set([
  "ADDRESS",
  "BLOCKQUOTE",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "OL",
  "P",
  "PRE",
  "UL",
]);

type PromptTextIndex = {
  text: string;
  boundaries: Map<Node, number[]>;
  points: Map<number, { node: Node; offset: number }>;
};

const isBlockNode = (node: Node): node is HTMLElement =>
  node.nodeType === Node.ELEMENT_NODE &&
  BLOCK_TAGS.has((node as HTMLElement).tagName);

const isPlaceholderBreak = (node: Node) => {
  if (!isBlockNode(node)) {
    return false;
  }
  const meaningfulChildren = Array.from(node.childNodes).filter(
    (child) =>
      child.nodeType !== Node.COMMENT_NODE &&
      !(child.nodeType === Node.TEXT_NODE && !child.textContent),
  );
  return (
    meaningfulChildren.length === 1 &&
    meaningfulChildren[0].nodeType === Node.ELEMENT_NODE &&
    (meaningfulChildren[0] as HTMLElement).tagName === "BR"
  );
};

export const buildPromptTextIndex = (root: HTMLElement): PromptTextIndex => {
  let text = "";
  const boundaries = new Map<Node, number[]>();
  const points = new Map<number, { node: Node; offset: number }>();

  const recordPoint = (node: Node, offset: number) => {
    points.set(text.length, { node, offset });
  };

  const visit = (node: Node, suppressBreak = false) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? "";
      const offsets: number[] = [];
      for (let index = 0; index <= value.length; index++) {
        offsets[index] = text.length;
        recordPoint(node, index);
        if (index < value.length) {
          text += value[index];
        }
      }
      boundaries.set(node, offsets);
      return;
    }

    if (
      node.nodeType === Node.ELEMENT_NODE &&
      (node as Element).tagName === "BR"
    ) {
      boundaries.set(node, [
        text.length,
        text.length + (suppressBreak ? 0 : 1),
      ]);
      if (!suppressBreak) {
        text += "\n";
      }
      return;
    }

    const children = Array.from(node.childNodes);
    const offsets: number[] = [text.length];
    boundaries.set(node, offsets);
    recordPoint(node, 0);
    const placeholderBreak = isPlaceholderBreak(node);

    let previousChildWasBlock = false;
    let previousChildWasPlaceholderBlock = false;
    children.forEach((child, index) => {
      const childIsBlock = isBlockNode(child);
      const childIsPlaceholderBlock = isPlaceholderBreak(child);
      if (
        index > 0 &&
        (childIsBlock || previousChildWasBlock) &&
        (!text.endsWith("\n") || previousChildWasPlaceholderBlock)
      ) {
        text += "\n";
      }
      visit(child, placeholderBreak);
      offsets[index + 1] = text.length;
      recordPoint(node, index + 1);
      previousChildWasBlock = childIsBlock;
      previousChildWasPlaceholderBlock = childIsPlaceholderBlock;
    });
  };

  visit(root);
  return { text, boundaries, points };
};

export const getPromptPlainText = (root: HTMLElement) =>
  buildPromptTextIndex(root).text;

export const getPromptTextOffset = (
  root: HTMLElement,
  node: Node,
  nodeOffset: number,
) => {
  const index = buildPromptTextIndex(root);
  const offsets = index.boundaries.get(node);
  if (!offsets) {
    return index.text.length;
  }
  return offsets[Math.max(0, Math.min(nodeOffset, offsets.length - 1))];
};

const getSelectionOffsets = (
  root: HTMLElement,
): { start: number; end: number } => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    const length = getPromptPlainText(root).length;
    return { start: length, end: length };
  }

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) {
    const length = getPromptPlainText(root).length;
    return { start: length, end: length };
  }

  const start = getPromptTextOffset(
    root,
    range.startContainer,
    range.startOffset,
  );
  const end = getPromptTextOffset(root, range.endContainer, range.endOffset);
  return { start, end };
};

// Locates the DOM point for an absolute plain-text offset.
export const locatePromptTextOffset = (
  root: HTMLElement,
  target: number,
): { node: Node; offset: number } => {
  const index = buildPromptTextIndex(root);
  const clamped = Math.max(0, Math.min(target, index.text.length));
  return index.points.get(clamped) || { node: root, offset: 0 };
};

const setSelectionOffsets = (root: HTMLElement, start: number, end: number) => {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const clampedStart = Math.max(0, start);
  const clampedEnd = Math.max(clampedStart, end);

  const startPoint = locatePromptTextOffset(root, clampedStart);
  const endPoint = locatePromptTextOffset(root, clampedEnd);

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
    // Plain-text selection to restore after a controlled repaint.
    const pendingSelectionRef = useRef<{
      start: number;
      end: number;
    } | null>(null);
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
        pendingSelectionRef.current == null
      ) {
        return;
      }

      const selection =
        pendingSelectionRef.current || getSelectionOffsets(root);

      paintHighlights(root, value, referenceCount);
      paintedValueRef.current = value;
      paintedRefCountRef.current = referenceCount;

      // Only restore the caret when the editor is focused; otherwise leave the
      // selection alone (e.g. value changed while another field has focus).
      if (document.activeElement === root) {
        setSelectionOffsets(root, selection.start, selection.end);
      }
      pendingSelectionRef.current = null;
    }, [value, referenceCount]);

    const commitFromDom = useCallback(() => {
      const root = rootRef.current;
      if (!root) {
        return;
      }
      // Normalize browser-created line structure with the same model used by
      // the caret bridge before repainting highlighted tokens.
      const text = getPromptPlainText(root);
      if (text === valueRef.current) {
        onCaretChange();
        return;
      }
      // Remember where the caret is now so the repaint can put it back.
      pendingSelectionRef.current = getSelectionOffsets(root);
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
