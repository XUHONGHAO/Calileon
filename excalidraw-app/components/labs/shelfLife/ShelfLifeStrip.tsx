import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { createIcon } from "@excalidraw/excalidraw/components/icons";
import { getLanguage, t } from "@excalidraw/excalidraw/i18n";
import { CaptureUpdateAction } from "@excalidraw/element";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { readShowLabs } from "../../labsPreference";

import {
  getShelfLifeEntries,
  setShelfLifeStripMode,
  setShelfLifeVisuals,
  useShelfLifeStripMode,
  useShelfLifeVisuals,
} from "./strip";

import "./shelfLife.scss";

import type { ShelfLifeEntry } from "./strip";

const lineIcon = (children: React.ReactNode) =>
  createIcon(children, {
    width: 24,
    height: 24,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  });
const clockIcon = lineIcon(
  <>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 8v4l2.5 2" />
  </>,
);
const collapseIcon = lineIcon(<path d="M15 6l-6 6 6 6" />);
const eyeIcon = lineIcon(
  <>
    <path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="2.75" />
  </>,
);
const eyeOffIcon = lineIcon(
  <>
    <path d="M10.6 5.6A9.8 9.8 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.6 3.4M6.4 6.9C3.9 8.6 2.5 12 2.5 12s3.5 6.5 9.5 6.5c1.6 0 3-.4 4.2-1" />
    <path d="M9.9 9.9a2.75 2.75 0 0 0 3.9 3.9M3.5 3.5l17 17" />
  </>,
);

const pad2 = (value: number) => `${value}`.padStart(2, "0");

/** "已过期" / "今天 18:00" / "明天结束" / "10/28 09:00". */
export const formatStripTime = (entry: ShelfLifeEntry, now = Date.now()) => {
  if (entry.state === "expired") {
    return t("labs.shelfLife.stripExpired");
  }
  const at = new Date(entry.expiresAt);
  const wholeDay = at.getHours() === 0 && at.getMinutes() === 0;
  // Whole days end at the next midnight: name the last good day.
  const day = new Date(wholeDay ? entry.expiresAt - 1 : entry.expiresAt);
  const today = new Date(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayLabel =
    day.toDateString() === today.toDateString()
      ? t("labs.shelfLife.stripToday")
      : day.toDateString() === tomorrow.toDateString()
      ? t("labs.shelfLife.stripTomorrow")
      : `${day.getMonth() + 1}/${day.getDate()}`;
  return wholeDay
    ? t("labs.shelfLife.stripEndOf", { day: dayLabel })
    : `${dayLabel} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
};

const getEntryName = (entry: ShelfLifeEntry) =>
  entry.text || t("labs.shelfLife.stripUntitled");

const signatureOf = (
  entries: ShelfLifeEntry[],
  selected: Readonly<Record<string, true>>,
  labs: boolean,
) =>
  `${labs}|${entries
    .map((e) => `${e.id}:${e.expiresAt}:${e.state}:${e.text}`)
    .join(",")}|${entries.filter((e) => selected[e.id]).map((e) => e.id)}`;

/**
 * Floating row above the bottom toolbar: every note with a shelf life on
 * this canvas, soonest first. Clicking a chip selects the note and scrolls
 * to it. Collapses to its toggle; the panel can hide it entirely.
 */
export const ShelfLifeStrip = ({
  excalidrawAPI: api,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
}) => {
  const mode = useShelfLifeStripMode();
  const visuals = useShelfLifeVisuals();
  const listRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<{
    entries: ShelfLifeEntry[];
    selected: Readonly<Record<string, true>>;
    labs: boolean;
  }>({ entries: [], selected: {}, labs: false });
  const [focusIndex, setFocusIndex] = useState(0);
  const [edges, setEdges] = useState({ start: false, end: false });

  useEffect(() => {
    if (!api || mode === "hidden") {
      return;
    }
    let lastElements: unknown = null;
    let entries: ShelfLifeEntry[] = [];
    let signature = "";
    const update = (force = false) => {
      const elements = api.getSceneElementsIncludingDeleted();
      // Pointer moves fire onChange too: only rescan when the scene changed.
      if (force || elements !== lastElements) {
        lastElements = elements;
        entries = getShelfLifeEntries(elements);
      }
      const selected = api.getAppState().selectedElementIds;
      const labs = readShowLabs();
      const next = signatureOf(entries, selected, labs);
      if (next !== signature) {
        signature = next;
        setView({ entries, selected, labs });
      }
    };
    update(true);
    const unsubscribe = api.onChange(() => update());
    // Relative labels ("today", expired) change with the clock.
    const timer = setInterval(() => {
      if (!document.hidden) {
        update(true);
      }
    }, 60_000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [api, mode]);

  const { entries, selected, labs } = view;
  const open = mode === "open";
  const visible = !!api && mode !== "hidden" && labs && entries.length > 0;

  // Mouse wheels scroll the row sideways instead of zooming the canvas.
  useEffect(() => {
    const list = listRef.current;
    if (!list || !visible || !open) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      if (list.scrollWidth <= list.clientWidth) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      list.scrollLeft +=
        Math.abs(event.deltaY) > Math.abs(event.deltaX)
          ? event.deltaY
          : event.deltaX;
    };
    list.addEventListener("wheel", onWheel, { passive: false });
    return () => list.removeEventListener("wheel", onWheel);
  }, [visible, open]);

  const updateEdges = () => {
    const list = listRef.current;
    if (list) {
      setEdges({
        start: list.scrollLeft > 1,
        end: list.scrollLeft + list.clientWidth < list.scrollWidth - 1,
      });
    }
  };
  useEffect(updateEdges, [entries, open]);

  if (!visible || !api) {
    return null;
  }

  const attention = entries.filter((e) => e.state !== "fresh").length;
  const current = Math.min(focusIndex, entries.length - 1);
  const lang = getLanguage().code;

  const jump = (entry: ShelfLifeEntry) => {
    const element = api
      .getSceneElements()
      .find((candidate) => candidate.id === entry.id);
    if (!element) {
      return;
    }
    api.updateScene({
      appState: {
        selectedElementIds: { [element.id]: true },
        selectedGroupIds: {},
        editingGroupId: null,
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
    api.scrollToContent(element, { animate: true, duration: 300 });
  };

  const onListKeyDown = (event: React.KeyboardEvent) => {
    const last = entries.length - 1;
    const next =
      event.key === "ArrowRight"
        ? Math.min(last, current + 1)
        : event.key === "ArrowLeft"
        ? Math.max(0, current - 1)
        : event.key === "Home"
        ? 0
        : event.key === "End"
        ? last
        : null;
    if (next === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setFocusIndex(next);
    listRef.current
      ?.querySelectorAll<HTMLButtonElement>(".shelf-life-strip__chip")
      [next]?.focus();
  };

  return (
    <div
      className={clsx("shelf-life-strip", { "shelf-life-strip--open": open })}
      role="region"
      aria-label={t("labs.shelfLife.stripLabel")}
      data-testid="shelf-life-strip"
    >
      <button
        type="button"
        className="shelf-life-strip__toggle"
        aria-expanded={open}
        aria-label={
          open
            ? t("labs.shelfLife.stripCollapse")
            : t("labs.shelfLife.stripExpand", { count: entries.length })
        }
        title={
          open
            ? t("labs.shelfLife.stripCollapse")
            : t("labs.shelfLife.stripExpand", { count: entries.length })
        }
        onClick={() => setShelfLifeStripMode(open ? "collapsed" : "open")}
      >
        <span className="shelf-life-strip__toggleIcon" aria-hidden="true">
          {open ? collapseIcon : clockIcon}
        </span>
        {!open && (
          <span
            className={clsx("shelf-life-strip__count", {
              "shelf-life-strip__count--attention": attention > 0,
            })}
            aria-hidden="true"
          >
            {entries.length}
          </span>
        )}
      </button>
      {open && (
        <div
          ref={listRef}
          className="shelf-life-strip__list"
          role="toolbar"
          aria-label={t("labs.shelfLife.stripLabel")}
          data-fade-start={edges.start || undefined}
          data-fade-end={edges.end || undefined}
          onScroll={updateEdges}
          onKeyDown={onListKeyDown}
        >
          {entries.map((entry, index) => {
            const time = formatStripTime(entry);
            const name = getEntryName(entry);
            return (
              <button
                key={entry.id}
                type="button"
                tabIndex={index === current ? 0 : -1}
                aria-pressed={!!selected[entry.id]}
                aria-label={`${name}, ${time}`}
                title={`${name} · ${new Date(entry.expiresAt).toLocaleString(
                  lang,
                  {
                    month: "short",
                    day: "numeric",
                    weekday: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  },
                )}`}
                className={clsx(
                  "shelf-life-strip__chip",
                  `shelf-life-strip__chip--${entry.state}`,
                  { "shelf-life-strip__chip--selected": selected[entry.id] },
                )}
                onFocus={() => setFocusIndex(index)}
                onClick={() => jump(entry)}
              >
                <span className="shelf-life-strip__dot" aria-hidden="true" />
                <span className="shelf-life-strip__name">{name}</span>
                <span className="shelf-life-strip__time">{time}</span>
              </button>
            );
          })}
        </div>
      )}
      <button
        type="button"
        className={clsx("shelf-life-strip__visuals", {
          "shelf-life-strip__visuals--off": !visuals,
        })}
        aria-pressed={visuals}
        aria-label={t("labs.shelfLife.visualsLabel")}
        title={
          visuals
            ? t("labs.shelfLife.visualsHide")
            : t("labs.shelfLife.visualsShow")
        }
        onClick={() => setShelfLifeVisuals(!visuals, api)}
      >
        <span className="shelf-life-strip__toggleIcon" aria-hidden="true">
          {visuals ? eyeIcon : eyeOffIcon}
        </span>
      </button>
    </div>
  );
};
