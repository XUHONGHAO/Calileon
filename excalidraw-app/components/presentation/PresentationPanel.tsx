import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_SIDEBAR } from "@excalidraw/common";
import { CaptureUpdateAction, getSceneVersion } from "@excalidraw/element";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import { t } from "@excalidraw/excalidraw/i18n";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type {
  ExcalidrawImperativeAPI,
  Offsets,
} from "@excalidraw/excalidraw/types";

import {
  SlidesPdfAbortError,
  exportScenePdf,
} from "../../presentation/pdf/exportSlidesPdf";
import {
  getPresentationSession,
  setPresenterViewPreference,
  startPresentation,
  usePresenterViewPreference,
} from "../../presentation/session";
import { SLIDE_NOTES_MAX_LENGTH } from "../../presentation/slideData";
import {
  moveSlide,
  renameSlide,
  resetSlideOrder,
  setSlideHidden,
  setSlideNotes,
} from "../../presentation/slideEdits";
import {
  getCurrentSlideId,
  getPlayableSlides,
  getSlideTitle,
  getSlides,
  hasManualOrder,
} from "../../presentation/slides";
import { useSlideThumbnails } from "../../presentation/thumbnails";
import {
  ActionMenu,
  Badge,
  Callout,
  Field,
  TextArea,
  TextInput,
  UiButton,
} from "../ui";

import {
  frameIcon,
  hiddenIcon,
  moveDownIcon,
  moveUpIcon,
  notesIcon,
  pdfIcon,
  playIcon,
  visibleIcon,
} from "./icons";

import "./PresentationPanel.scss";

import type { Slide } from "../../presentation/slides";

const THUMBNAIL_WIDTH = 96;
const NOTES_COMMIT_DELAY_MS = 800;
const DRAG_MIME = "application/x-calileon-slide";

type ExportState =
  | { status: "idle" }
  | { status: "running"; done: number; total: number }
  | { status: "error" };

// Same idea as the editor's `getEditorUIOffsets` (not on the imperative API):
// keep a focused slide clear of the toolbar, the properties panel and this
// sidebar. Skipped when they would leave almost no canvas (phone sidebar).
const getCanvasOffsets = (panel: HTMLElement | null): Offsets | undefined => {
  const container = panel?.closest<HTMLElement>(".excalidraw");
  if (!panel || !container) {
    return undefined;
  }
  const PADDING = 16;
  const box = container.getBoundingClientRect();
  const offsets = {
    top: PADDING,
    right: PADDING,
    bottom: PADDING,
    left: PADDING,
  };
  const toolbar = container
    .querySelector(".App-toolbar")
    ?.getBoundingClientRect();
  if (toolbar) {
    offsets.top += Math.max(toolbar.bottom - box.top, 0);
  }
  for (const el of [
    panel.closest(".sidebar"),
    container.querySelector(".selected-shape-actions"),
  ]) {
    const rect = el?.getBoundingClientRect();
    if (!rect || !rect.width) {
      continue;
    }
    if (rect.left + rect.width / 2 < box.left + box.width / 2) {
      offsets.left = Math.max(offsets.left, rect.right - box.left + PADDING);
    } else {
      offsets.right = Math.max(offsets.right, box.right - rect.left + PADDING);
    }
  }
  const MIN_CANVAS = 160;
  return box.width - offsets.left - offsets.right < MIN_CANVAS ||
    box.height - offsets.top - offsets.bottom < MIN_CANVAS
    ? undefined
    : offsets;
};

const useSceneSnapshot = (api: ExcalidrawImperativeAPI | null) => {
  const read = useCallback(() => {
    if (!api) {
      return { elements: [] as readonly ExcalidrawElement[], version: 0 };
    }
    const elements = api.getSceneElementsIncludingDeleted();
    return {
      elements,
      version:
        getSceneVersion(elements) * 1000 +
        (Object.keys(api.getFiles()).length % 1000),
    };
  }, [api]);
  const [snapshot, setSnapshot] = useState(read);
  useEffect(() => {
    setSnapshot(read());
    if (!api) {
      return;
    }
    return api.onChange(() => {
      const next = read();
      setSnapshot((prev) => (prev.version === next.version ? prev : next));
    });
  }, [api, read]);
  return snapshot;
};

export const PresentationPanel = ({
  excalidrawAPI: api,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
}) => {
  const { theme, viewModeEnabled, viewBackgroundColor, exportWithDarkMode } =
    useUIAppState();
  const readOnly = viewModeEnabled;
  const { elements, version } = useSceneSnapshot(api);
  const slides = getSlides(elements);
  const playable = getPlayableSlides(slides);
  const presenterPref = usePresenterViewPreference();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [includeNotes, setIncludeNotes] = useState(false);
  const [exportState, setExportState] = useState<ExportState>({
    status: "idle",
  });
  const exportAbortRef = useRef<AbortController | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const getThumbnail = useSlideThumbnails({
    slides,
    elements,
    files: api?.getFiles() ?? null,
    darkMode: theme === "dark",
    viewBackgroundColor,
    width: THUMBNAIL_WIDTH,
    sceneVersion: version,
  });

  useEffect(() => () => exportAbortRef.current?.abort(), []);

  const commit = useCallback(
    (
      edit: (
        elements: readonly ExcalidrawElement[],
      ) => readonly ExcalidrawElement[] | null,
    ) => {
      if (!api || api.getAppState().viewModeEnabled) {
        return;
      }
      const next = edit(api.getSceneElementsIncludingDeleted());
      if (next) {
        api.updateScene({
          elements: next,
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        });
      }
    },
    [api],
  );

  const play = (startFrameId: string | null) => {
    if (!api || getPresentationSession() || !playable.length) {
      return;
    }
    startPresentation({ startFrameId, presenterView: presenterPref });
  };

  const playFromCurrent = () => {
    if (!api) {
      return;
    }
    play(getCurrentSlideId(slides, api.getSceneElements(), api.getAppState()));
  };

  const focusSlide = (slide: Slide) => {
    if (!api) {
      return;
    }
    if (!readOnly) {
      api.updateScene({
        appState: { selectedElementIds: { [slide.frame.id]: true } },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
    // a frame after the selection lands, so the properties panel it opens is
    // part of the offsets
    requestAnimationFrame(() => {
      if (api.isDestroyed) {
        return;
      }
      api.scrollToContent(slide.frame, {
        fitToContent: true,
        animate: true,
        viewportZoomFactor: 0.9,
        canvasOffsets: getCanvasOffsets(rootRef.current),
      });
    });
  };

  const toggleSlide = (slide: Slide) => {
    if (expandedId === slide.frame.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(slide.frame.id);
    focusSlide(slide);
  };

  // Same as the toolbar's "More tools → Frame tool" (F). Where the sidebar
  // covers the canvas (phone overlay) close it, or there is nowhere to draw.
  const addFrame = () => {
    if (!api) {
      return;
    }
    api.setActiveTool({ type: "frame" });
    if (rootRef.current && !getCanvasOffsets(rootRef.current)) {
      api.toggleSidebar({ name: DEFAULT_SIDEBAR.name, force: false });
    }
  };

  const addFrameBlock = !readOnly && (
    <div className="PresentationPanel__add">
      <UiButton
        variant={slides.length ? "secondary" : "primary"}
        size="sm"
        icon={frameIcon}
        onClick={addFrame}
      >
        {t("ai.presentation.addFrame")}
      </UiButton>
      <p className="PresentationPanel__hint">
        {t("ai.presentation.addFrameHint")}
      </p>
    </div>
  );

  const exportPdf = async () => {
    if (!api || exportState.status === "running" || !playable.length) {
      return;
    }
    const controller = new AbortController();
    exportAbortRef.current = controller;
    setExportState({ status: "running", done: 0, total: playable.length });
    try {
      await exportScenePdf(api, {
        includeNotes,
        signal: controller.signal,
        onProgress: (done, total) =>
          setExportState({ status: "running", done, total }),
      });
      setExportState({ status: "idle" });
    } catch (error) {
      setExportState(
        error instanceof SlidesPdfAbortError
          ? { status: "idle" }
          : { status: "error" },
      );
    } finally {
      if (exportAbortRef.current === controller) {
        exportAbortRef.current = null;
      }
    }
  };

  if (!slides.length) {
    return (
      <div className="PresentationPanel" ref={rootRef}>
        <PanelHeader count={0} />
        <div className="PresentationPanel__empty">
          <p>{t("ai.presentation.emptyHint")}</p>
          {addFrameBlock}
        </div>
      </div>
    );
  }

  const exporting = exportState.status === "running";

  return (
    <div className="PresentationPanel" ref={rootRef}>
      <PanelHeader count={slides.length} />

      <div className="PresentationPanel__play">
        <UiButton
          variant="primary"
          size="sm"
          icon={playIcon}
          disabled={!playable.length}
          onClick={() => play(null)}
        >
          {t("ai.presentation.playFromStart")}
        </UiButton>
        <UiButton
          size="sm"
          disabled={!playable.length}
          onClick={playFromCurrent}
        >
          {t("ai.presentation.playFromCurrent")}
        </UiButton>
        <label className="PresentationPanel__checkbox">
          <input
            type="checkbox"
            checked={presenterPref}
            onChange={(event) =>
              setPresenterViewPreference(event.target.checked)
            }
          />
          <span>{t("ai.presentation.openPresenterView")}</span>
        </label>
        {!playable.length && (
          <Callout tone="warning" live={false}>
            {t("ai.presentation.allHidden")}
          </Callout>
        )}
      </div>

      <ol
        className="PresentationPanel__list"
        aria-label={t("ai.presentation.slideList")}
      >
        {slides.map((slide, index) => (
          <SlideRow
            key={slide.frame.id}
            slide={slide}
            index={index}
            count={slides.length}
            readOnly={readOnly}
            expanded={expandedId === slide.frame.id}
            thumbnail={getThumbnail(slide.frame.id)}
            onToggle={() => toggleSlide(slide)}
            onPlay={() => play(slide.frame.id)}
            canPlay={!slide.data.hidden}
            onMove={(to) =>
              commit((current) => moveSlide(current, slide.frame.id, to))
            }
            onHide={(hidden) =>
              commit((current) =>
                setSlideHidden(current, slide.frame.id, hidden),
              )
            }
            onRename={(name) =>
              commit((current) => renameSlide(current, slide.frame.id, name))
            }
            onNotes={(notes) =>
              commit((current) => setSlideNotes(current, slide.frame.id, notes))
            }
            onDropSlide={(draggedId, side) =>
              commit((current) => {
                const from = getSlides(current).findIndex(
                  (item) => item.frame.id === draggedId,
                );
                if (from === -1) {
                  return null;
                }
                const to =
                  side === "before"
                    ? from < index
                      ? index - 1
                      : index
                    : from < index
                    ? index
                    : index + 1;
                return moveSlide(current, draggedId, to);
              })
            }
          />
        ))}
      </ol>

      {addFrameBlock}

      <div className="PresentationPanel__footer">
        {exportState.status === "error" && (
          <Callout tone="danger">{t("ai.presentation.exportFailed")}</Callout>
        )}
        {exporting ? (
          <div className="PresentationPanel__exportProgress" role="status">
            <span>
              {t("ai.presentation.exporting", {
                done: exportState.done,
                total: exportState.total,
              })}
            </span>
            <UiButton size="sm" onClick={() => exportAbortRef.current?.abort()}>
              {t("ai.common.cancel")}
            </UiButton>
          </div>
        ) : (
          <div className="PresentationPanel__exportRow">
            <UiButton
              size="sm"
              icon={pdfIcon}
              disabled={!playable.length}
              onClick={() => void exportPdf()}
            >
              {t("ai.presentation.exportPdf")}
            </UiButton>
            {!readOnly && (
              <ActionMenu
                items={[
                  {
                    label: t("ai.presentation.resetOrder"),
                    disabled: !hasManualOrder(slides),
                    onSelect: () => commit(resetSlideOrder),
                  },
                ]}
              />
            )}
          </div>
        )}
        <label className="PresentationPanel__checkbox">
          <input
            type="checkbox"
            checked={includeNotes}
            disabled={exporting}
            onChange={(event) => setIncludeNotes(event.target.checked)}
          />
          <span>{t("ai.presentation.includeNotes")}</span>
        </label>
        {includeNotes && (
          <p className="PresentationPanel__hint">
            {t("ai.presentation.includeNotesHint")}
          </p>
        )}
        {exportWithDarkMode && (
          <p className="PresentationPanel__hint">
            {t("ai.presentation.exportDarkHint")}
          </p>
        )}
      </div>
    </div>
  );
};

const PanelHeader = ({ count }: { count: number }) => (
  <div className="PresentationPanel__header">
    <strong>{t("ai.sidebar.presentations")}</strong>
    {count > 0 && <span>{t("ai.presentation.slideCount", { count })}</span>}
  </div>
);

type SlideRowProps = {
  slide: Slide;
  index: number;
  count: number;
  readOnly: boolean;
  expanded: boolean;
  thumbnail: string | null;
  canPlay: boolean;
  onToggle: () => void;
  onPlay: () => void;
  onMove: (toIndex: number) => void;
  onHide: (hidden: boolean) => void;
  onRename: (name: string) => void;
  onNotes: (notes: string) => void;
  onDropSlide: (draggedId: string, side: "before" | "after") => void;
};

const SlideRow = ({
  slide,
  index,
  count,
  readOnly,
  expanded,
  thumbnail,
  canPlay,
  onToggle,
  onPlay,
  onMove,
  onHide,
  onRename,
  onNotes,
  onDropSlide,
}: SlideRowProps) => {
  const title = getSlideTitle(slide);
  const hidden = !!slide.data.hidden;
  const notes = slide.data.notes ?? "";
  const [dropSide, setDropSide] = useState<"before" | "after" | null>(null);

  return (
    <li
      className={clsx("PresentationPanel__slide", {
        "is-expanded": expanded,
        "is-hidden": hidden,
        "is-dropBefore": dropSide === "before",
        "is-dropAfter": dropSide === "after",
      })}
      draggable={!readOnly}
      onDragStart={(event) => {
        if (readOnly) {
          return;
        }
        event.dataTransfer.setData(DRAG_MIME, slide.frame.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(event) => {
        if (readOnly || !event.dataTransfer.types.includes(DRAG_MIME)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        setDropSide(
          event.clientY < rect.top + rect.height / 2 ? "before" : "after",
        );
      }}
      onDragLeave={() => setDropSide(null)}
      onDrop={(event) => {
        if (readOnly || !event.dataTransfer.types.includes(DRAG_MIME)) {
          return;
        }
        // keep the editor's drop handler (files, text) out of it
        event.preventDefault();
        event.stopPropagation();
        const side = dropSide;
        setDropSide(null);
        const draggedId = event.dataTransfer.getData(DRAG_MIME);
        if (draggedId && draggedId !== slide.frame.id && side) {
          onDropSlide(draggedId, side);
        }
      }}
    >
      <button
        type="button"
        className="PresentationPanel__slideButton"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="PresentationPanel__number" aria-hidden="true">
          {slide.number}
        </span>
        <span
          className="PresentationPanel__thumb"
          style={
            thumbnail ? { backgroundImage: `url("${thumbnail}")` } : undefined
          }
          aria-hidden="true"
        />
        <span className="PresentationPanel__slideText">
          <span className="PresentationPanel__slideTitle">{title}</span>
          <span className="PresentationPanel__slideMeta">
            {hidden && (
              <Badge tone="neutral">{t("ai.presentation.hidden")}</Badge>
            )}
            {notes && (
              <span
                className="PresentationPanel__notesMark"
                title={t("ai.presentation.hasNotes")}
              >
                {notesIcon}
                <span className="visually-hidden">
                  {t("ai.presentation.hasNotes")}
                </span>
              </span>
            )}
          </span>
        </span>
      </button>

      {expanded && (
        <div className="PresentationPanel__details">
          {readOnly ? (
            <>
              <p className="PresentationPanel__detailsLabel">
                {t("ai.presentation.notes")}
              </p>
              <p className="PresentationPanel__readonlyNotes">
                {notes || t("ai.presentation.noNotes")}
              </p>
            </>
          ) : (
            <>
              <DraftInput
                label={t("ai.presentation.slideName")}
                value={slide.frame.name ?? ""}
                placeholder={title}
                onCommit={onRename}
              />
              <DraftNotes value={notes} onCommit={onNotes} />
            </>
          )}
          <div className="PresentationPanel__actions">
            <UiButton
              size="sm"
              variant="ghost"
              icon={playIcon}
              disabled={!canPlay}
              onClick={onPlay}
            >
              {t("ai.presentation.playFromHere")}
            </UiButton>
            {!readOnly && (
              <>
                <UiButton
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={moveUpIcon}
                  aria-label={t("ai.presentation.moveUp")}
                  title={t("ai.presentation.moveUp")}
                  disabled={index === 0}
                  onClick={() => onMove(index - 1)}
                />
                <UiButton
                  size="sm"
                  variant="ghost"
                  iconOnly
                  icon={moveDownIcon}
                  aria-label={t("ai.presentation.moveDown")}
                  title={t("ai.presentation.moveDown")}
                  disabled={index === count - 1}
                  onClick={() => onMove(index + 1)}
                />
                <UiButton
                  size="sm"
                  variant="ghost"
                  icon={hidden ? visibleIcon : hiddenIcon}
                  aria-pressed={hidden}
                  onClick={() => onHide(!hidden)}
                >
                  {hidden
                    ? t("ai.presentation.showSlide")
                    : t("ai.presentation.hideSlide")}
                </UiButton>
              </>
            )}
          </div>
        </div>
      )}
    </li>
  );
};

/** Text field that keeps the user's draft while focused, commits on blur / Enter. */
const DraftInput = ({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder: string;
  onCommit: (value: string) => void;
}) => {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value) {
      onCommit(draft);
    }
    setDraft(null);
  };
  return (
    <Field label={label}>
      <TextInput
        value={draft ?? value}
        placeholder={placeholder}
        onFocus={() => setDraft(value)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.stopPropagation();
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
      />
    </Field>
  );
};

/** Notes: committed 800 ms after typing stops and on blur (one undo step each). */
const DraftNotes = ({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (value: string) => void;
}) => {
  const [draft, setDraft] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const latest = useRef({ draft, value, onCommit });
  latest.current = { draft, value, onCommit };

  const flush = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const { draft, value, onCommit } = latest.current;
    if (draft !== null && draft !== value) {
      onCommit(draft);
    }
  }, []);

  useEffect(() => flush, [flush]);

  const length = (draft ?? value).length;
  return (
    <Field
      label={t("ai.presentation.notes")}
      hint={
        <>
          <span>{t("ai.presentation.notesVisibility")}</span>{" "}
          <span className="PresentationPanel__counter">
            {t("ai.presentation.notesCount", {
              count: length,
              max: SLIDE_NOTES_MAX_LENGTH,
            })}
          </span>
        </>
      }
    >
      <TextArea
        rows={4}
        maxLength={SLIDE_NOTES_MAX_LENGTH}
        value={draft ?? value}
        placeholder={t("ai.presentation.notesPlaceholder")}
        onFocus={() => setDraft(value)}
        onChange={(event) => {
          setDraft(event.target.value);
          if (timerRef.current !== null) {
            window.clearTimeout(timerRef.current);
          }
          timerRef.current = window.setTimeout(flush, NOTES_COMMIT_DELAY_MS);
        }}
        onBlur={() => {
          flush();
          setDraft(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            event.currentTarget.blur();
          }
        }}
      />
    </Field>
  );
};
