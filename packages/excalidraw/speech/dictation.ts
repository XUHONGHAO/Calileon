import { EDITOR_LS_KEYS } from "@excalidraw/common";

import { EditorLocalStorage } from "../data/EditorLocalStorage";
import { t } from "../i18n";
import { acquireMicLock } from "../voice/micLock";
import { VoiceRecorderFailure, openMicrophone } from "../voice/recorder";

import { isCJKChar } from "./clean";
import { getSpeechLang } from "./lang";
import {
  hasSeenTranscriptionNotice,
  markTranscriptionNoticeSeen,
} from "./prefs";
import {
  createTranscriber,
  getLocalSpeechAvailability,
  installLocalSpeech,
} from "./transcriber";

import type { OpenMicrophone } from "../voice/recorder";

import type { TranscriptionMode, Transcriber } from "./transcriber";

// Text-box voice input (ADR 0034 §8): a mic button floats next to the
// wysiwyg textarea. Finals are inserted at the caret through the normal input
// flow; interim words are drawn greyed at the caret by a ghost overlay that
// mirrors the textarea, because a textarea can't colour part of its text.

const MIC_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0z"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>';

const BUTTON_SIZE = 28;
const BUTTON_GAP = 6;
const TIP_DURATION = 3_500;
const PANEL_WIDTH = 280;
const TEXT_FILL = "-webkit-text-fill-color";

type State = "idle" | "prompt" | "starting" | "listening" | "stopping";

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
};

/** text to insert so it reads naturally after `before` */
export const getDictationInsertion = (before: string, piece: string) => {
  const text = piece.replace(/^\s+/, "");
  if (!text) {
    return "";
  }
  const prev = Array.from(before).pop();
  const needsSpace =
    !!prev && !/\s/.test(prev) && !isCJKChar(prev) && !isCJKChar(text[0]);
  return needsSpace ? ` ${text}` : text;
};

export const attachTextDictation = ({
  textarea,
  container,
  mode,
  langCode,
  onStart,
}: {
  textarea: HTMLTextAreaElement;
  /** the wysiwyg's parent, inside `.excalidraw` so theme variables apply */
  container: HTMLElement;
  mode: TranscriptionMode;
  langCode: string;
  /** e.g. pause bubble playback so it isn't dictated */
  onStart?: () => void;
}) => {
  const lang = getSpeechLang(langCode);
  let state: State = "idle";
  let mic: OpenMicrophone | null = null;
  let transcriber: Transcriber | null = null;
  let releaseLock: (() => void) | null = null;
  /** final text already inserted into the textarea */
  let inserted = "";
  let interim = "";
  let tipTimer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  let detached = false;

  const button = el("button", "excalidraw-dictation__button");
  button.type = "button";
  button.innerHTML = MIC_SVG;
  button.tabIndex = -1;
  button.dataset.testid = "text-dictation";

  const ghost = el("div", "excalidraw-dictation__ghost");
  ghost.setAttribute("aria-hidden", "true");
  const panel = el("div", "excalidraw-dictation__panel");
  panel.setAttribute("role", "status");

  // ---------------------------------------------------------------------------
  // layout

  const position = () => {
    frame = 0;
    if (detached) {
      return;
    }
    // same offset parent as the textarea, so host transforms don't matter
    const parent = (textarea.offsetParent as HTMLElement | null) ?? container;
    const bounds = parent.getBoundingClientRect();
    const rect = textarea.getBoundingClientRect();
    // grey interim words overflow the auto-sized textarea; stay clear of them
    const interimNode = renderGhost();
    const right = Math.max(
      rect.right,
      interimNode?.getBoundingClientRect().right ?? 0,
    );
    const left = Math.min(
      right - bounds.left + BUTTON_GAP,
      bounds.width - BUTTON_SIZE - 4,
    );
    const top = Math.max(4, rect.top - bounds.top - BUTTON_SIZE / 2 + 4);
    Object.assign(button.style, { left: `${left}px`, top: `${top}px` });
    Object.assign(panel.style, {
      left: `${Math.max(4, Math.min(left, bounds.width - PANEL_WIDTH - 4))}px`,
      top: `${top + BUTTON_SIZE + 4}px`,
    });
  };

  const schedulePosition = () => {
    if (!frame) {
      frame = requestAnimationFrame(position);
    }
  };

  /**
   * mirrors the textarea; interim words are inserted at the caret, greyed.
   * Returns the interim span, if shown.
   */
  const renderGhost = (): HTMLElement | null => {
    if (!interim) {
      ghost.hidden = true;
      // only touch the style when it changes: the observer watches it
      if (textarea.style.getPropertyValue(TEXT_FILL)) {
        textarea.style.removeProperty(TEXT_FILL);
      }
      return null;
    }
    ghost.style.cssText = textarea.style.cssText;
    Object.assign(ghost.style, {
      overflow: "visible",
      pointerEvents: "none",
      background: "transparent",
      zIndex: "calc(var(--zIndex-wysiwyg) + 1)",
    });
    ghost.style.removeProperty(TEXT_FILL);
    const caret = textarea.selectionEnd ?? textarea.value.length;
    const before = textarea.value.slice(0, caret);
    const piece = getDictationInsertion(before, interim);
    const interimNode = el("span", "excalidraw-dictation__interim", piece);
    ghost.replaceChildren(
      document.createTextNode(before),
      interimNode,
      document.createTextNode(textarea.value.slice(caret)),
    );
    ghost.hidden = false;
    // the textarea keeps its caret and selection; the ghost shows the text
    if (textarea.style.getPropertyValue(TEXT_FILL) !== "transparent") {
      textarea.style.setProperty(TEXT_FILL, "transparent");
    }
    return interimNode;
  };

  // ---------------------------------------------------------------------------
  // feedback

  const hidePanel = () => {
    clearTimeout(tipTimer);
    panel.hidden = true;
    panel.replaceChildren();
  };

  const showTip = (message: string) => {
    hidePanel();
    panel.append(el("span", "excalidraw-dictation__message", message));
    panel.hidden = false;
    tipTimer = setTimeout(hidePanel, TIP_DURATION);
  };

  /** resolves true when the user accepts */
  const ask = (message: string, accept: string) =>
    new Promise<boolean>((resolve) => {
      hidePanel();
      const ok = el(
        "button",
        "excalidraw-voice-recorder__button excalidraw-voice-recorder__button--primary",
        accept,
      );
      const cancel = el(
        "button",
        "excalidraw-voice-recorder__button",
        t("voice.dictation.cancel"),
      );
      ok.type = cancel.type = "button";
      const answer = (value: boolean) => {
        hidePanel();
        resolve(value);
      };
      ok.onclick = () => answer(true);
      cancel.onclick = () => answer(false);
      const actions = el("span", "excalidraw-dictation__actions");
      actions.append(ok, cancel);
      panel.append(
        el("span", "excalidraw-dictation__message", message),
        actions,
      );
      panel.hidden = false;
    });

  const getState = (): State => state;

  const setState = (next: State) => {
    state = next;
    const listening = next === "listening" || next === "starting";
    button.classList.toggle("excalidraw-dictation__button--live", listening);
    button.setAttribute("aria-pressed", String(listening));
    const label = t(
      listening ? "voice.dictation.stop" : "voice.dictation.start",
    );
    button.title = label;
    button.setAttribute("aria-label", label);
  };

  // ---------------------------------------------------------------------------
  // text

  const insertFinal = (final: string) => {
    if (!final.startsWith(inserted)) {
      // the recognizer re-cut its words; only append what's new
      inserted = final.slice(0, inserted.length);
    }
    const piece = final.slice(inserted.length);
    inserted = final;
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    const text = getDictationInsertion(textarea.value.slice(0, start), piece);
    if (!text) {
      return;
    }
    textarea.setRangeText(text, start, end, "end");
    // the wysiwyg updates the element (and normalizes) on `input`
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  };

  // ---------------------------------------------------------------------------
  // lifecycle

  const teardown = () => {
    transcriber?.abort();
    transcriber = null;
    mic?.close();
    mic = null;
    releaseLock?.();
    releaseLock = null;
    interim = "";
    renderGhost();
    schedulePosition();
  };

  const stop = async () => {
    if (state !== "listening") {
      if (state === "starting") {
        teardown();
        setState("idle");
      }
      return;
    }
    setState("stopping");
    const current = transcriber;
    transcriber = null;
    const final = current ? await current.finish() : inserted;
    if (!detached && textarea.isConnected) {
      interim = "";
      insertFinal(final);
    }
    teardown();
    if (!detached) {
      setState("idle");
    }
  };

  const ensureConsent = async () => {
    if (mode === "local-only") {
      const availability = await getLocalSpeechAvailability(lang);
      if (availability === "available") {
        return true;
      }
      if (availability === "unavailable") {
        showTip(t("voice.dictation.localUnavailable"));
        return false;
      }
      if (
        availability === "downloadable" &&
        !(await ask(
          t("voice.transcription.downloadConsent"),
          t("voice.transcription.download"),
        ))
      ) {
        return false;
      }
      showTip(t("voice.transcription.downloading"));
      const installed = await installLocalSpeech(lang);
      hidePanel();
      if (!installed) {
        showTip(t("voice.dictation.localUnavailable"));
      }
      return installed;
    }
    if (hasSeenTranscriptionNotice()) {
      return true;
    }
    const accepted = await ask(
      t("voice.dictation.notice"),
      t("voice.dictation.accept"),
    );
    if (accepted) {
      markTranscriptionNoticeSeen();
    }
    return accepted;
  };

  const start = async () => {
    if (state !== "idle") {
      return;
    }
    setState("prompt");
    const consented = await ensureConsent();
    if (detached) {
      return;
    }
    if (!consented) {
      setState("idle");
      return;
    }
    releaseLock = acquireMicLock("text-dictation");
    if (!releaseLock) {
      setState("idle");
      showTip(t("voice.errors.busy"));
      return;
    }
    setState("starting");
    onStart?.();
    try {
      mic = await openMicrophone({
        deviceId: EditorLocalStorage.get<string>(
          EDITOR_LS_KEYS.VOICE_INPUT_DEVICE,
        ),
        onEnded: () => void stop(),
      });
    } catch (error) {
      teardown();
      if (!detached) {
        setState("idle");
        showTip(
          t(
            `voice.errors.${
              error instanceof VoiceRecorderFailure
                ? error.reason
                : "audioError"
            }`,
          ),
        );
      }
      return;
    }
    // `stop()` may have run while the microphone was opening
    if (detached || getState() !== "starting") {
      teardown();
      return;
    }
    inserted = "";
    const current = mic;
    transcriber = createTranscriber({
      track: current.track,
      lang,
      mode,
      getLevel: () => current.level(),
      onUpdate: (update) => {
        if (state !== "listening") {
          return;
        }
        insertFinal(update.final);
        interim = update.interim;
        position();
      },
      onUnavailable: () => {
        showTip(t("voice.dictation.unavailable"));
        teardown();
        setState("idle");
      },
    });
    if (!transcriber) {
      teardown();
      setState("idle");
      showTip(t("voice.dictation.unavailable"));
      return;
    }
    setState("listening");
    textarea.focus();
  };

  // keep the textarea focused: a blur would submit the text element
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    if (state === "idle") {
      void start();
    } else {
      void stop();
    }
  });
  panel.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    if (!(event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
    }
  });
  panel.addEventListener("mousedown", (event) => event.preventDefault());

  const observer =
    typeof MutationObserver !== "undefined"
      ? new MutationObserver(schedulePosition)
      : null;
  observer?.observe(textarea, { attributes: true, attributeFilter: ["style"] });
  const onCaretMove = () => {
    if (interim) {
      position();
    }
  };
  textarea.addEventListener("input", onCaretMove);
  textarea.addEventListener("keyup", onCaretMove);
  textarea.addEventListener("click", onCaretMove);
  window.addEventListener("resize", schedulePosition);

  setState("idle");
  panel.hidden = true;
  ghost.hidden = true;
  container.append(ghost, button, panel);
  position();

  return () => {
    detached = true;
    cancelAnimationFrame(frame);
    clearTimeout(tipTimer);
    observer?.disconnect();
    textarea.removeEventListener("input", onCaretMove);
    textarea.removeEventListener("keyup", onCaretMove);
    textarea.removeEventListener("click", onCaretMove);
    window.removeEventListener("resize", schedulePosition);
    teardown();
    button.remove();
    ghost.remove();
    panel.remove();
  };
};
