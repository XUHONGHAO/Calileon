import { useEffect, useRef, useState } from "react";
import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  Excalidraw,
  ExcalidrawAPIProvider,
} from "@excalidraw/excalidraw";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { getLanguage, t } from "@excalidraw/excalidraw/i18n";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import {
  Callout,
  DialogActions,
  Field,
  SegmentedControl,
  UiButton,
} from "../../ui";

import { styleIcons } from "./icons";
import { MAX_FILE_SIZE } from "./audio";
import { commitArtwork, SynesthesiaSession } from "./session";

import "./SynesthesiaDialog.scss";

import type { Snapshot } from "./session";
import type { Style } from "./mapping";

const text = (key: string) =>
  t(`labs.synesthesia.${key}` as Parameters<typeof t>[0]);
export const SynesthesiaDialog = ({
  api,
  onClose,
}: {
  api: ExcalidrawImperativeAPI;
  onClose: () => void;
}) => {
  const [source, setSource] = useState<"mic" | "file">("mic");
  const [style, setStyle] = useState<Style>("lines");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot>({
    elements: [],
    elapsed: 0,
    rms: 0,
  });
  const session = useRef<SynesthesiaSession | null>(null);
  const preview = useRef<ExcalidrawImperativeAPI | null>(null);
  const pending = useRef<readonly ExcalidrawElement[]>([]);
  const mounted = useRef(true);
  const submit = () => {
    try {
      commitArtwork(api, pending.current);
      pending.current = [];
    } catch {
      if (mounted.current) {
        setMessage("commitError");
      }
    }
  };
  useEffect(() => {
    mounted.current = true;
    const stopHidden = () => {
      if (document.hidden) {
        session.current?.stop("interrupted");
      }
    };
    const stopPage = () => session.current?.stop("interrupted");
    document.addEventListener("visibilitychange", stopHidden);
    window.addEventListener("pagehide", stopPage);
    return () => {
      mounted.current = false;
      session.current?.stop("completed");
      document.removeEventListener("visibilitychange", stopHidden);
      window.removeEventListener("pagehide", stopPage);
    };
  }, []);
  const start = () => {
    if (busy || pending.current.length) {
      return;
    }
    const state = api.getAppState();
    const width = Math.max(
      100,
      Math.min(1600, (state.width / state.zoom.value) * 0.8),
    );
    const height = Math.max(
      100,
      Math.min(1000, (state.height / state.zoom.value) * 0.8),
    );
    const area = {
      x: state.width / 2 / state.zoom.value - state.scrollX - width / 2,
      y: state.height / 2 / state.zoom.value - state.scrollY - height / 2,
      width,
      height,
    };
    setMessage("");
    setBusy(true);
    setSnapshot({ elements: [], elapsed: 0, rms: 0 });
    preview.current?.updateScene({
      elements: [],
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    const previewBounds = convertToExcalidrawElements([
      { type: "rectangle", ...area },
    ]);
    preview.current?.scrollToContent(previewBounds, {
      fitToViewport: true,
      animate: false,
    });
    const next = new SynesthesiaSession({
      file: source === "file" ? file : null,
      style,
      area,
      dark: state.theme === "dark",
      seed: crypto.getRandomValues(new Uint32Array(1))[0],
      preview: (value) => {
        if (!mounted.current) {
          return;
        }
        setSnapshot(value);
        preview.current?.updateScene({
          elements: value.elements,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      },
      finish: (elements, reason) => {
        pending.current = elements;
        submit();
        if (mounted.current) {
          setBusy(false);
          setMessage(pending.current.length ? "commitError" : reason);
        }
      },
    });
    session.current = next;
    void next.start();
  };
  const close = () => {
    session.current?.stop();
    if (!pending.current.length) {
      onClose();
    }
  };
  return (
    <Dialog title={text("title")} onCloseRequest={close} size="wide">
      <div className="SynesthesiaDialog">
        <Callout>{text("privacy")}</Callout>
        <SegmentedControl
          label={text("source")}
          value={source}
          onChange={setSource}
          options={(["mic", "file"] as const).map((value) => ({
            value,
            label: text(value),
            disabled: busy,
          }))}
        />
        {source === "file" && (
          <Field label={text("file")} hint={text("fileHint")}>
            <input
              type="file"
              accept="audio/*"
              disabled={busy}
              onChange={(event) => {
                const selected = event.target.files?.[0] ?? null;
                setFile(
                  selected && selected.size <= MAX_FILE_SIZE ? selected : null,
                );
                setMessage(
                  selected && selected.size > MAX_FILE_SIZE ? "tooLarge" : "",
                );
              }}
            />
          </Field>
        )}
        <SegmentedControl
          label={text("style")}
          value={style}
          onChange={setStyle}
          fullWidth
          options={(["lines", "blocks", "stars"] as const).map((value) => ({
            value,
            label: (
              <>
                {styleIcons[value]}
                {text(value)}
              </>
            ),
            disabled: busy,
          }))}
        />
        <div
          className="SynesthesiaDialog__preview"
          aria-label={text("preview")}
        >
          <ExcalidrawAPIProvider>
            <Excalidraw
              onExcalidrawAPI={(value) => {
                preview.current = value;
              }}
              langCode={getLanguage().code}
              theme={api.getAppState().theme}
              viewModeEnabled
              zenModeEnabled
              handleKeyboardGlobally={false}
              autoFocus={false}
              detectScroll={false}
              initialData={{
                appState: {
                  viewBackgroundColor: api.getAppState().viewBackgroundColor,
                },
              }}
              UIOptions={{
                canvasActions: {
                  loadScene: false,
                  saveToActiveFile: false,
                  export: false,
                  clearCanvas: false,
                  toggleTheme: false,
                  changeViewBackgroundColor: false,
                },
              }}
            />
          </ExcalidrawAPIProvider>
        </div>
        <div>
          {Math.floor(snapshot.elapsed / 1000)} / 300 s ·{" "}
          {snapshot.elements.length} / 600{" "}
          <meter
            min={0}
            max={1}
            value={snapshot.rms}
            aria-label={text("volume")}
          />
        </div>
        <div role="status">{message && text(message)}</div>
        <DialogActions>
          {pending.current.length > 0 && (
            <UiButton
              onClick={() => {
                submit();
                if (!pending.current.length) {
                  setMessage("completed");
                }
              }}
            >
              {text("retry")}
            </UiButton>
          )}
          {busy ? (
            <UiButton variant="primary" onClick={() => session.current?.stop()}>
              {text("stop")}
            </UiButton>
          ) : (
            <UiButton
              variant="primary"
              disabled={
                pending.current.length > 0 || (source === "file" && !file)
              }
              onClick={start}
            >
              {text("start")}
            </UiButton>
          )}
        </DialogActions>
      </div>
    </Dialog>
  );
};
