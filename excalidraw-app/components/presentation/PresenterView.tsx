import clsx from "clsx";
import { useEffect, useState } from "react";
import { getLanguage, t } from "@excalidraw/excalidraw/i18n";

import {
  formatElapsed,
  getTimerElapsed,
} from "../../presentation/playerHelpers";
import { UiButton } from "../ui";

import {
  exitIcon,
  nextIcon,
  pauseIcon,
  playIcon,
  prevIcon,
  resetIcon,
} from "./icons";

import type { PresentationTimer } from "../../presentation/playerHelpers";

type NotesSize = "sm" | "md" | "lg";

/** Speaker-only window content (ADR 0036 §4). */
export const PresenterView = ({
  index,
  total,
  title,
  notes,
  nextTitle,
  nextThumbnail,
  timer,
  onPrev,
  onNext,
  onToggleTimer,
  onResetTimer,
  onExit,
}: {
  index: number;
  total: number;
  title: string;
  notes: string;
  nextTitle: string | null;
  nextThumbnail: string | null;
  timer: PresentationTimer;
  onPrev: () => void;
  onNext: () => void;
  onToggleTimer: () => void;
  onResetTimer: () => void;
  onExit: () => void;
}) => {
  const [now, setNow] = useState(() => Date.now());
  const [notesSize, setNotesSize] = useState<NotesSize>("md");

  useEffect(() => {
    const timerId = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timerId);
  }, []);

  const paused = timer.pausedAt !== null;
  const clock = new Date(now).toLocaleTimeString(getLanguage().code, {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="PresenterView">
      <header className="PresenterView__header">
        <div className="PresenterView__current">
          <span className="PresenterView__counter">
            {t("ai.presentation.slideOf", { index: index + 1, total })}
          </span>
          <h1 className="PresenterView__title">{title}</h1>
        </div>
        <div className="PresenterView__clocks">
          <div className="PresenterView__timer">
            <span className="PresenterView__label">
              {t("ai.presentation.elapsed")}
            </span>
            <span className="PresenterView__time" aria-live="off">
              {formatElapsed(getTimerElapsed(timer, now))}
            </span>
            <UiButton
              size="sm"
              variant="ghost"
              iconOnly
              icon={paused ? playIcon : pauseIcon}
              aria-label={
                paused
                  ? t("ai.presentation.resumeTimer")
                  : t("ai.presentation.pauseTimer")
              }
              title={
                paused
                  ? t("ai.presentation.resumeTimer")
                  : t("ai.presentation.pauseTimer")
              }
              onClick={onToggleTimer}
            />
            <UiButton
              size="sm"
              variant="ghost"
              iconOnly
              icon={resetIcon}
              aria-label={t("ai.presentation.resetTimer")}
              title={t("ai.presentation.resetTimer")}
              onClick={onResetTimer}
            />
          </div>
          <div className="PresenterView__clock">
            <span className="PresenterView__label">
              {t("ai.presentation.clock")}
            </span>
            <span className="PresenterView__time">{clock}</span>
          </div>
        </div>
      </header>

      <div className="PresenterView__body">
        <section
          className="PresenterView__notes"
          aria-label={t("ai.presentation.notes")}
        >
          <div className="PresenterView__notesBar">
            <span className="PresenterView__label">
              {t("ai.presentation.notes")}
            </span>
            <div
              className="PresenterView__sizes"
              role="group"
              aria-label={t("ai.presentation.notesSize")}
            >
              {(["sm", "md", "lg"] as const).map((size) => (
                <button
                  key={size}
                  type="button"
                  className={clsx("PresenterView__size", `is-${size}`, {
                    "is-active": notesSize === size,
                  })}
                  aria-pressed={notesSize === size}
                  title={t(`ai.presentation.notesSizes.${size}`)}
                  onClick={() => setNotesSize(size)}
                >
                  A
                  <span className="visually-hidden">
                    {t(`ai.presentation.notesSizes.${size}`)}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div
            className={clsx("PresenterView__notesText", `is-${notesSize}`, {
              "is-empty": !notes,
            })}
          >
            {notes || t("ai.presentation.noNotes")}
          </div>
        </section>

        <aside className="PresenterView__next">
          <span className="PresenterView__label">
            {t("ai.presentation.nextSlide")}
          </span>
          {nextTitle === null ? (
            <p className="PresenterView__end">
              {t("ai.presentation.lastSlide")}
            </p>
          ) : (
            <>
              <div
                className="PresenterView__nextThumb"
                style={
                  nextThumbnail
                    ? { backgroundImage: `url("${nextThumbnail}")` }
                    : undefined
                }
                aria-hidden="true"
              />
              <p className="PresenterView__nextTitle">{nextTitle}</p>
            </>
          )}
        </aside>
      </div>

      <footer className="PresenterView__footer">
        <p className="PresenterView__hint">{t("ai.presentation.mirrorHint")}</p>
        <div className="PresenterView__nav">
          <UiButton icon={prevIcon} disabled={index === 0} onClick={onPrev}>
            {t("ai.presentation.prev")}
          </UiButton>
          <UiButton
            variant="primary"
            icon={nextIcon}
            disabled={index >= total - 1}
            onClick={onNext}
          >
            {t("ai.presentation.next")}
          </UiButton>
          <UiButton variant="ghost" icon={exitIcon} onClick={onExit}>
            {t("ai.presentation.exit")}
          </UiButton>
        </div>
      </footer>
    </div>
  );
};
