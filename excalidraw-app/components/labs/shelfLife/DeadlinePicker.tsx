import clsx from "clsx";
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { createIcon } from "@excalidraw/excalidraw/components/icons";
import { getLanguage, t } from "@excalidraw/excalidraw/i18n";

import { UiButton, SegmentedControl } from "../../ui";

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
const calendarIcon = lineIcon(
  <>
    <rect x="4" y="5" width="16" height="15" rx="2" />
    <path d="M4 10h16M9 3v4M15 3v4" />
  </>,
);
const prevIcon = lineIcon(<path d="M15 6l-6 6 6 6" />);
const nextIcon = lineIcon(<path d="M9 6l6 6-6 6" />);
const upIcon = lineIcon(<path d="M7 14l5-5 5 5" />);
const downIcon = lineIcon(<path d="M7 10l5 5 5-5" />);

// ------------------------------------------------------------ date helpers
// Local calendar arithmetic (DST-safe: never add raw 24h steps).

export const startOfDay = (time: number) => {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};
export const addDays = (day: number, count: number) => {
  const date = new Date(day);
  date.setDate(date.getDate() + count);
  return date.getTime();
};
const addMonths = (day: number, count: number) => {
  const date = new Date(day);
  const dom = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + count);
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(dom, last));
  return date.getTime();
};

/** Whole days end at the next midnight; timed deadlines are exact. */
export const composeDeadline = (
  day: number,
  allDay: boolean,
  minutes: number,
) => {
  if (allDay) {
    return addDays(day, 1);
  }
  const date = new Date(day);
  date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return date.getTime();
};

/** Inverse of composeDeadline, for prefilling the picker. */
export const splitDeadline = (value: number | null, now = Date.now()) => {
  if (value === null) {
    return { day: startOfDay(now), allDay: true, minutes: 18 * 60 };
  }
  const at = new Date(value);
  const minutes = at.getHours() * 60 + at.getMinutes();
  return minutes === 0
    ? { day: startOfDay(value - 1), allDay: true, minutes: 18 * 60 }
    : { day: startOfDay(value), allDay: false, minutes };
};

/**
 * Always six weeks from the locale's first weekday: a constant height keeps
 * the popup from jumping when the month changes.
 */
export const getMonthGrid = (month: number, weekStart: number) => {
  const first = new Date(month);
  first.setDate(1);
  const lead = (first.getDay() - weekStart + 7) % 7;
  const start = addDays(startOfDay(first.getTime()), -lead);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
};

const getWeekStart = (code: string) => (code.startsWith("en") ? 0 : 1);
const pad2 = (value: number) => `${value}`.padStart(2, "0");
const QUICK_TIMES = [9 * 60, 12 * 60, 18 * 60, 21 * 60];

// ------------------------------------------------------------- time input
/** Two-digit spin field: type, use ↑/↓, or the small steppers (±step). */
const TimeSpin = ({
  label,
  value,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) => {
  const [text, setText] = useState<string | null>(null);
  const wrap = (next: number) => (next + max + 1) % (max + 1);
  const commit = () => {
    if (text !== null) {
      const parsed = Number.parseInt(text, 10);
      if (Number.isFinite(parsed)) {
        onChange(Math.min(max, Math.max(0, parsed)));
      }
      setText(null);
    }
  };
  return (
    <div className="shelf-life-picker__spin">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="shelf-life-picker__step"
        onClick={() => onChange(wrap(value + step))}
      >
        {upIcon}
      </button>
      <input
        role="spinbutton"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        inputMode="numeric"
        maxLength={2}
        className="shelf-life-picker__spinInput"
        value={text ?? pad2(value)}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setText(event.target.value.replace(/\D/g, ""))}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            setText(null);
            onChange(wrap(value + (event.key === "ArrowUp" ? 1 : -1)));
          } else if (event.key === "Enter") {
            commit();
          }
        }}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="shelf-life-picker__step"
        onClick={() => onChange(wrap(value - step))}
      >
        {downIcon}
      </button>
    </div>
  );
};

// ------------------------------------------------------------ the picker
type DeadlinePickerProps = {
  /** Current deadline of the selection (null: none, undefined: mixed). */
  value: number | null | undefined;
  /** Text for the trigger, e.g. "Good until Oct 28". */
  display: string;
  disabled?: boolean;
  onApply: (deadline: number) => void;
  id?: string;
  "aria-describedby"?: string;
};

/**
 * Date + time dropdown in the app's own style. The popup is portalled to the
 * editor root (outside the dialog's scroll box) and applies on confirm.
 */
export const DeadlinePicker = forwardRef<
  HTMLButtonElement,
  DeadlinePickerProps
>(({ value, display, disabled, onApply, id, ...rest }, forwardedRef) => {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [today, setToday] = useState(() => startOfDay(Date.now()));
  const [day, setDay] = useState(today);
  const [cursor, setCursor] = useState(today);
  const [month, setMonth] = useState(today);
  const [allDay, setAllDay] = useState(true);
  const [minutes, setMinutes] = useState(18 * 60);
  const [focusDay, setFocusDay] = useState(false);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    maxHeight: number;
  }>();
  const lang = getLanguage().code;
  const weekStart = getWeekStart(lang);
  const popupId = `${id ?? "shelf-life"}-picker`;

  const setRefs = (node: HTMLButtonElement | null) => {
    triggerRef.current = node;
    if (typeof forwardedRef === "function") {
      forwardedRef(node);
    } else if (forwardedRef) {
      forwardedRef.current = node;
    }
  };

  const show = () => {
    const now = Date.now();
    const nextToday = startOfDay(now);
    const draft = splitDeadline(value ?? null, now);
    const start = Math.max(draft.day, nextToday);
    setToday(nextToday);
    setDay(start);
    setCursor(start);
    setMonth(start);
    setAllDay(draft.allDay);
    setMinutes(draft.minutes);
    setPosition(undefined);
    setFocusDay(true);
    setOpen(true);
  };
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const popup = popupRef.current;
    if (!open || !trigger || !popup) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = popup;
    // The side is chosen once per opening and the popup keeps a constant
    // height (6-week grid, time column beside it), so switching modes or
    // months never makes it jump. Below, else above; on very short screens
    // it uses the viewport (covering the trigger beats hiding "Set").
    const spaceBelow = window.innerHeight - 8 - (rect.bottom + 4);
    const spaceAbove = rect.top - 4 - 8;
    setPosition({
      maxHeight: window.innerHeight - 16,
      top:
        height <= spaceBelow
          ? rect.bottom + 4
          : height <= spaceAbove
          ? rect.top - 4 - height
          : Math.max(8, window.innerHeight - 8 - height),
      left: Math.min(
        Math.max(8, rect.left),
        Math.max(8, window.innerWidth - width - 8),
      ),
    });
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !popupRef.current?.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        close(false);
      }
    };
    const onResize = () => close(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, close]);

  useEffect(() => {
    if (open && focusDay && position) {
      gridRef.current
        ?.querySelector<HTMLButtonElement>("[tabindex='0']")
        ?.focus({ preventScroll: true });
      setFocusDay(false);
    }
  }, [open, focusDay, position, cursor]);

  const moveCursor = (next: number) => {
    const clamped = Math.max(today, next);
    setCursor(clamped);
    setMonth(clamped);
    setFocusDay(true);
  };
  const onGridKeyDown = (event: React.KeyboardEvent) => {
    const date = new Date(cursor);
    const offset = (date.getDay() - weekStart + 7) % 7;
    const moves: Record<string, () => number> = {
      ArrowLeft: () => addDays(cursor, -1),
      ArrowRight: () => addDays(cursor, 1),
      ArrowUp: () => addDays(cursor, -7),
      ArrowDown: () => addDays(cursor, 7),
      Home: () => addDays(cursor, -offset),
      End: () => addDays(cursor, 6 - offset),
      PageUp: () => addMonths(cursor, -1),
      PageDown: () => addMonths(cursor, 1),
    };
    const move = moves[event.key];
    if (move) {
      event.preventDefault();
      moveCursor(move());
    }
  };
  const onPopupKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Keep keys (Esc, arrows, Delete...) away from the dialog and the canvas.
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") {
      const focusable = Array.from(
        popupRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled):not([tabindex='-1']), input",
        ) ?? [],
      );
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      const last = focusable.length - 1;
      if (event.shiftKey ? index <= 0 : index === last) {
        event.preventDefault();
        focusable[event.shiftKey ? last : 0]?.focus();
      }
    }
  };

  const deadline = composeDeadline(day, allDay, minutes);
  const past = deadline <= Date.now();
  const monthDate = new Date(month);
  const grid = getMonthGrid(month, weekStart);
  const weekdays = grid
    .slice(0, 7)
    .map((d) => new Date(d).toLocaleDateString(lang, { weekday: "narrow" }));
  const summary = new Date(allDay ? day : deadline).toLocaleString(lang, {
    month: "short",
    day: "numeric",
    weekday: "short",
    ...(allDay ? {} : { hour: "2-digit", minute: "2-digit" }),
  });
  const atMonthStart =
    monthDate.getFullYear() === new Date(today).getFullYear() &&
    monthDate.getMonth() === new Date(today).getMonth();
  const host =
    triggerRef.current?.closest<HTMLElement>(".excalidraw") ?? document.body;

  return (
    <>
      <button
        ref={setRefs}
        id={id}
        type="button"
        aria-describedby={rest["aria-describedby"]}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        disabled={disabled}
        className={clsx("UiInput", "shelf-life-picker__trigger", {
          "shelf-life-picker__trigger--empty": value === null,
        })}
        onClick={() => (open ? close(false) : show())}
      >
        <span className="shelf-life-picker__triggerIcon" aria-hidden="true">
          {calendarIcon}
        </span>
        <span className="shelf-life-picker__triggerText">{display}</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={popupRef}
            id={popupId}
            role="dialog"
            aria-label={t("labs.shelfLife.pickerTitle")}
            className="shelf-life-picker"
            style={{
              top: position?.top ?? -9999,
              left: position?.left ?? -9999,
              maxHeight: position?.maxHeight,
            }}
            onKeyDown={onPopupKeyDown}
          >
            <div className="shelf-life-picker__body">
              <div className="shelf-life-picker__calendar">
                <div className="shelf-life-picker__header">
                  <UiButton
                    variant="ghost"
                    size="sm"
                    iconOnly
                    icon={prevIcon}
                    aria-label={t("labs.shelfLife.prevMonth")}
                    disabled={atMonthStart}
                    onClick={() => moveCursor(addMonths(cursor, -1))}
                  />
                  <span className="shelf-life-picker__month" aria-live="polite">
                    {monthDate.toLocaleDateString(lang, {
                      year: "numeric",
                      month: "long",
                    })}
                  </span>
                  <UiButton
                    variant="ghost"
                    size="sm"
                    iconOnly
                    icon={nextIcon}
                    aria-label={t("labs.shelfLife.nextMonth")}
                    onClick={() => moveCursor(addMonths(cursor, 1))}
                  />
                </div>
                <div className="shelf-life-picker__weekdays" aria-hidden="true">
                  {weekdays.map((label, i) => (
                    <span key={i}>{label}</span>
                  ))}
                </div>
                <div
                  ref={gridRef}
                  className="shelf-life-picker__grid"
                  onKeyDown={onGridKeyDown}
                >
                  {grid.map((d) => {
                    const date = new Date(d);
                    return (
                      <button
                        key={d}
                        type="button"
                        tabIndex={d === cursor ? 0 : -1}
                        disabled={d < today}
                        aria-pressed={d === day}
                        aria-current={d === today ? "date" : undefined}
                        aria-label={date.toLocaleDateString(lang, {
                          year: "numeric",
                          month: "long",
                          day: "numeric",
                          weekday: "long",
                        })}
                        className={clsx("shelf-life-picker__day", {
                          "shelf-life-picker__day--outside":
                            date.getMonth() !== monthDate.getMonth(),
                          "shelf-life-picker__day--today": d === today,
                          "shelf-life-picker__day--selected": d === day,
                        })}
                        onClick={() => {
                          setDay(d);
                          setCursor(d);
                          setMonth(d);
                        }}
                      >
                        {date.getDate()}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="shelf-life-picker__time">
                <SegmentedControl
                  size="sm"
                  fullWidth
                  label={t("labs.shelfLife.timeMode")}
                  value={allDay ? "allDay" : "at"}
                  onChange={(mode) => setAllDay(mode === "allDay")}
                  options={[
                    { value: "allDay", label: t("labs.shelfLife.endOfDay") },
                    { value: "at", label: t("labs.shelfLife.atTime") },
                  ]}
                />
                {!allDay && (
                  <div className="shelf-life-picker__clock">
                    <div className="shelf-life-picker__spins">
                      <TimeSpin
                        label={t("labs.shelfLife.hour")}
                        value={Math.floor(minutes / 60)}
                        max={23}
                        step={1}
                        onChange={(h) => setMinutes(h * 60 + (minutes % 60))}
                      />
                      <span aria-hidden="true">:</span>
                      <TimeSpin
                        label={t("labs.shelfLife.minute")}
                        value={minutes % 60}
                        max={59}
                        step={5}
                        onChange={(m) =>
                          setMinutes(Math.floor(minutes / 60) * 60 + m)
                        }
                      />
                    </div>
                    <div className="shelf-life-picker__quick">
                      {QUICK_TIMES.map((quick) => (
                        <button
                          key={quick}
                          type="button"
                          aria-pressed={quick === minutes}
                          className={clsx("shelf-life-picker__chip", {
                            "shelf-life-picker__chip--active":
                              quick === minutes,
                          })}
                          onClick={() => setMinutes(quick)}
                        >
                          {`${pad2(Math.floor(quick / 60))}:00`}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {allDay && (
                  <p className="shelf-life-picker__allDayHint">
                    {t("labs.shelfLife.endOfDayHint")}
                  </p>
                )}
              </div>
            </div>
            <div className="shelf-life-picker__footer">
              <p
                className={clsx("shelf-life-picker__summary", {
                  "shelf-life-picker__summary--past": past,
                })}
                role={past ? "alert" : undefined}
              >
                {past
                  ? t("labs.shelfLife.immediate")
                  : t(
                      allDay
                        ? "labs.shelfLife.untilDay"
                        : "labs.shelfLife.untilTime",
                      { date: summary },
                    )}
              </p>
              <div className="shelf-life-picker__actions">
                <UiButton variant="ghost" size="sm" onClick={() => close(true)}>
                  {t("buttons.cancel")}
                </UiButton>
                <UiButton
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    onApply(deadline);
                    close(true);
                  }}
                >
                  {t("labs.shelfLife.apply")}
                </UiButton>
              </div>
            </div>
          </div>,
          host,
        )}
    </>
  );
});
DeadlinePicker.displayName = "DeadlinePicker";
