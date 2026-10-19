/**
 * Vault v2 (P4c) binding between the open text editor (wysiwyg textarea) and
 * the element's `Y.Text`. ADR 0030 §2.3 "textarea follows remote" + "IME
 * deferred", 6-D report (only the `deferred` strategy passed 21/21).
 *
 * - outside composition: every `input` is diffed into ONE splice (caret hint)
 *   and applied with the local-text origin; remote changes patch the textarea
 *   immediately and the caret is transformed through the remote delta;
 * - during composition (`compositionstart` → `compositionend`): no diff and no
 *   `textarea.value` writes (Chromium silently kills the composition and never
 *   fires `compositionend`). Remote changes still go into the document — other
 *   elements keep syncing — only the textarea patch waits;
 * - on `compositionend` the composed string is spliced at the position the
 *   composition started (RelativePosition, assoc -1) in the *current* text,
 *   then the textarea is rewritten from the merged text.
 *
 * Invariant outside composition: `ytext.toString() === lastValue`.
 *
 * Known limitation: if a remote insert lands *inside* a selection that the IME
 * composition replaces, that insert is removed together with the selection.
 */
import * as Y from "yjs";

import { VAULT_V2_LOCAL_TEXT_ORIGIN } from "./sceneDoc";
import { diffText, isNoop } from "./textDiff";

import type { VaultSceneDoc } from "./sceneDoc";

export class VaultTextBinding {
  readonly ytext: Y.Text;

  private lastValue: string;
  private composing = false;
  private remoteWhileComposing = false;
  private compositionAnchor: {
    start: Y.RelativePosition;
    end: Y.RelativePosition;
    startIndex: number;
    endIndex: number;
  } | null = null;
  private disposed = false;

  constructor(
    private readonly scene: VaultSceneDoc,
    readonly elementId: string,
    private readonly textarea: HTMLTextAreaElement,
  ) {
    const ytext = scene.getText(elementId);
    if (!ytext) {
      throw new Error(`no Y.Text for element ${elementId}`);
    }
    this.ytext = ytext;
    this.lastValue = ytext.toString();
    if (textarea.value !== this.lastValue) {
      this.writeTextarea(
        this.lastValue,
        this.lastValue.length,
        this.lastValue.length,
      );
    }
    textarea.addEventListener("compositionstart", this.onCompositionStart);
    textarea.addEventListener("compositionend", this.onCompositionEnd);
    textarea.addEventListener("input", this.onInput);
    ytext.observe(this.onTextChange);
  }

  get isComposing() {
    return this.composing;
  }

  private onCompositionStart = () => {
    this.composing = true;
    this.remoteWhileComposing = false;
    const length = this.ytext.length;
    const startIndex = Math.min(this.textarea.selectionStart ?? length, length);
    const endIndex = Math.min(this.textarea.selectionEnd ?? length, length);
    this.compositionAnchor = {
      start: Y.createRelativePositionFromTypeIndex(this.ytext, startIndex, -1),
      end: Y.createRelativePositionFromTypeIndex(this.ytext, endIndex, -1),
      startIndex,
      endIndex,
    };
  };

  private onCompositionEnd = () => {
    this.composing = false;
    this.commitComposition();
  };

  private onInput = (event: Event) => {
    if (this.composing || (event as InputEvent).isComposing) {
      return;
    }
    this.flushLocal();
  };

  /** textarea → one splice on the Y.Text */
  private flushLocal() {
    const next = this.textarea.value;
    const splice = diffText(
      this.lastValue,
      next,
      this.textarea.selectionEnd ?? undefined,
    );
    this.lastValue = next;
    if (isNoop(splice)) {
      return;
    }
    this.scene.transact(
      () => this.scene.applySplice(this.elementId, splice),
      VAULT_V2_LOCAL_TEXT_ORIGIN,
    );
  }

  private commitComposition() {
    const anchor = this.compositionAnchor;
    this.compositionAnchor = null;
    if (!this.remoteWhileComposing || !anchor) {
      this.flushLocal();
      return;
    }
    this.remoteWhileComposing = false;
    const value = this.textarea.value;
    const before = this.lastValue;
    const suffixLength = before.length - anchor.endIndex;
    const prefixOk =
      value.slice(0, anchor.startIndex) === before.slice(0, anchor.startIndex);
    const suffixOk =
      value.length - suffixLength >= anchor.startIndex &&
      value.slice(value.length - suffixLength) ===
        before.slice(anchor.endIndex);
    let composed: string;
    let start: number;
    let end: number;
    if (prefixOk && suffixOk) {
      composed = value.slice(anchor.startIndex, value.length - suffixLength);
      start =
        Y.createAbsolutePositionFromRelativePosition(
          anchor.start,
          this.scene.doc,
        )?.index ?? this.ytext.length;
      end =
        Y.createAbsolutePositionFromRelativePosition(anchor.end, this.scene.doc)
          ?.index ?? start;
      end = Math.max(start, end);
    } else {
      // unexpected shape (the IME touched text outside the selection): fall
      // back to a diff against the pre-composition value, clamped
      const splice = diffText(
        before,
        value,
        this.textarea.selectionEnd ?? undefined,
      );
      composed = splice.insert;
      start = Math.min(splice.index, this.ytext.length);
      end = Math.min(start + splice.deleteCount, this.ytext.length);
    }
    if (composed.length > 0 || end > start) {
      this.scene.transact(
        () =>
          this.scene.applySplice(this.elementId, {
            index: start,
            deleteCount: end - start,
            insert: composed,
          }),
        VAULT_V2_LOCAL_TEXT_ORIGIN,
      );
    }
    const merged = this.ytext.toString();
    const caret = start + composed.length;
    this.lastValue = merged;
    this.writeTextarea(merged, caret, caret);
  }

  private onTextChange = (event: Y.YTextEvent, transaction: Y.Transaction) => {
    if (transaction.origin === VAULT_V2_LOCAL_TEXT_ORIGIN || this.disposed) {
      return;
    }
    if (this.composing) {
      this.remoteWhileComposing = true;
      return;
    }
    // transform the caret through the remote delta (assoc -1: a remote insert
    // exactly at the caret lands to the right of it)
    let selStart = this.textarea.selectionStart ?? this.lastValue.length;
    let selEnd = this.textarea.selectionEnd ?? this.lastValue.length;
    let index = 0;
    for (const op of event.delta) {
      if (op.retain !== undefined) {
        index += op.retain;
      } else if (op.insert !== undefined) {
        const length = typeof op.insert === "string" ? op.insert.length : 1;
        if (index < selStart) {
          selStart += length;
        }
        if (index < selEnd) {
          selEnd += length;
        }
        index += length;
      } else if (op.delete !== undefined) {
        const from = index;
        const to = index + op.delete;
        const shift = (pos: number) =>
          pos <= from ? pos : pos >= to ? pos - op.delete! : from;
        selStart = shift(selStart);
        selEnd = shift(selEnd);
      }
    }
    const merged = this.ytext.toString();
    this.lastValue = merged;
    this.writeTextarea(merged, selStart, selEnd);
  };

  /** patches the textarea and lets the editor see it (`input` event) */
  private writeTextarea(
    value: string,
    selectionStart: number,
    selectionEnd: number,
  ) {
    this.textarea.value = value;
    this.textarea.setSelectionRange(selectionStart, selectionEnd);
    this.textarea.dispatchEvent(new Event("input"));
  }

  /**
   * Called when the editor closes, before submit: commits pending input. An
   * unfinished composition is committed as typed.
   */
  dispose() {
    if (this.disposed) {
      return;
    }
    if (this.composing) {
      this.composing = false;
      this.commitComposition();
    } else {
      this.flushLocal();
    }
    this.disposed = true;
    this.textarea.removeEventListener(
      "compositionstart",
      this.onCompositionStart,
    );
    this.textarea.removeEventListener("compositionend", this.onCompositionEnd);
    this.textarea.removeEventListener("input", this.onInput);
    this.ytext.unobserve(this.onTextChange);
  }
}
