import clsx from "clsx";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { KEYS } from "@excalidraw/common";

import { collapseDownIcon, tablerCheckIcon } from "../components/icons";

export type VoiceSelectOption = { value: string; label: string };

/** list height cap; also the room needed below before it flips upwards */
const LIST_MAX_HEIGHT = 240;
const OPTION_HEIGHT = 36;
const GAP = 4;
/** distance kept from the editor's edges */
const EDGE = 8;

/**
 * Compact dropdown for the recording overlay (microphone, recognition
 * language). Same look as the app's `UiSelect` + `UiPopover` (ADR 0034 R7):
 * the app's `--ui-*` tokens apply when the host defines them, otherwise the
 * core theme colours. The list renders inside the overlay, so it moves with
 * it; it flips above and shifts sideways when the editor would clip it.
 *
 * Keys on the trigger never reach the editor (arrows would nudge elements,
 * Escape would cancel the recording while the list is open).
 */
export const VoiceSelect = ({
  value,
  options,
  onChange,
  disabled = false,
  className,
  title,
  placeholder = "",
  icon,
  "aria-label": ariaLabel,
}: {
  value: string;
  options: readonly VoiceSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  title?: string;
  /** shown when `value` matches no option */
  placeholder?: string;
  /** leading icon; on narrow screens it replaces the value text */
  icon?: React.ReactNode;
  "aria-label": string;
}) => {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [up, setUp] = useState(false);
  /** horizontal shift that keeps the list inside the editor */
  const [shift, setShift] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = options[selectedIndex];

  const openList = () => {
    if (disabled || !options.length) {
      return;
    }
    // the editor root clips overflow, so measure against it, not the window
    const trigger = rootRef.current?.getBoundingClientRect();
    const bounds = rootRef.current
      ?.closest(".excalidraw")
      ?.getBoundingClientRect();
    if (trigger && bounds) {
      const height = Math.min(
        LIST_MAX_HEIGHT,
        options.length * OPTION_HEIGHT + 2 * GAP,
      );
      const below = bounds.bottom - trigger.bottom - GAP;
      const above = trigger.top - bounds.top - GAP;
      setUp(below < height && above > below);
    }
    setActiveIndex(Math.max(0, selectedIndex));
    setOpen(true);
  };

  const commit = (index: number) => {
    const option = options[index];
    setOpen(false);
    if (option && option.value !== value) {
      onChange(option.value);
    }
  };

  // a press outside closes the list (the canvas doesn't always move focus)
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  // the list can be wider than the trigger (long device names): once it is
  // laid out, shift it back inside the editor
  useLayoutEffect(() => {
    const list = listRef.current;
    const bounds = rootRef.current
      ?.closest(".excalidraw")
      ?.getBoundingClientRect();
    if (!open || !list || !bounds) {
      setShift(0);
      return;
    }
    // offsetWidth: the open animation scales the box, the layout width doesn't
    const left = list.getBoundingClientRect().left;
    const overflowRight = left + list.offsetWidth - (bounds.right - EDGE);
    const next =
      overflowRight > 0
        ? Math.max(-overflowRight, bounds.left + EDGE - left)
        : 0;
    setShift(next);
  }, [open]);

  // keep the active option visible while navigating; scroll only the list,
  // never the editor root (scrollIntoView would shift the overflow-hidden root)
  useLayoutEffect(() => {
    const list = listRef.current;
    const option = list?.children[activeIndex] as HTMLElement | undefined;
    if (!open || !list || !option) {
      return;
    }
    if (option.offsetTop < list.scrollTop) {
      list.scrollTop = option.offsetTop;
    } else if (
      option.offsetTop + option.offsetHeight >
      list.scrollTop + list.clientHeight
    ) {
      list.scrollTop =
        option.offsetTop + option.offsetHeight - list.clientHeight;
    }
  }, [open, activeIndex]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const { key } = event;
    const last = options.length - 1;
    const handled = (() => {
      if (!open) {
        if (
          key === KEYS.ARROW_DOWN ||
          key === KEYS.ARROW_UP ||
          key === KEYS.ENTER ||
          key === KEYS.SPACE
        ) {
          openList();
          return true;
        }
        return false;
      }
      switch (key) {
        case KEYS.ARROW_DOWN:
          setActiveIndex((index) => Math.min(last, index + 1));
          return true;
        case KEYS.ARROW_UP:
          setActiveIndex((index) => Math.max(0, index - 1));
          return true;
        case "Home":
          setActiveIndex(0);
          return true;
        case "End":
          setActiveIndex(last);
          return true;
        case KEYS.ENTER:
        case KEYS.SPACE:
          commit(activeIndex);
          return true;
        case KEYS.ESCAPE:
          setOpen(false);
          return true;
        case KEYS.TAB:
          setOpen(false);
          return false;
        default:
          return false;
      }
    })();
    if (handled) {
      event.preventDefault();
    }
    // never let the editor act on keys meant for this control
    event.stopPropagation();
  };

  return (
    <div
      ref={rootRef}
      className={clsx("excalidraw-voice-select", className)}
      data-open={open || undefined}
    >
      <button
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          open && activeIndex >= 0 ? optionId(activeIndex) : undefined
        }
        title={title ?? selected?.label}
        disabled={disabled}
        className={clsx("excalidraw-voice-select__trigger", {
          "excalidraw-voice-select__trigger--open": open,
        })}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      >
        {icon && (
          <span className="excalidraw-voice-select__icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <span className="excalidraw-voice-select__value">
          {selected?.label ?? placeholder}
        </span>
        <span className="excalidraw-voice-select__chevron" aria-hidden="true">
          {collapseDownIcon}
        </span>
      </button>
      {open && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className={clsx("excalidraw-voice-select__list", {
            "excalidraw-voice-select__list--up": up,
          })}
          style={shift ? { left: shift } : undefined}
          // keep focus (and the open state) on the trigger
          onPointerDown={(event) => event.preventDefault()}
        >
          {options.map((option, index) => (
            <div
              key={option.value}
              id={optionId(index)}
              role="option"
              aria-selected={index === selectedIndex}
              className={clsx("excalidraw-voice-select__option", {
                "is-active": index === activeIndex,
                "is-selected": index === selectedIndex,
              })}
              onPointerMove={() => setActiveIndex(index)}
              onClick={() => commit(index)}
            >
              <span className="excalidraw-voice-select__label">
                {option.label}
              </span>
              <span
                className="excalidraw-voice-select__check"
                aria-hidden="true"
              >
                {index === selectedIndex ? tablerCheckIcon : null}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
