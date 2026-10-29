import clsx from "clsx";
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { uiCheckIcon, uiChevronDownIcon } from "./icons";
import { getPopoverHost, usePopover } from "./usePopover";

import type { PopoverPlacement } from "./usePopover";

type SelectOption = {
  value: string;
  label: React.ReactNode;
  /** Plain text used for typeahead and the trigger title. */
  text: string;
  /** `<option title>`: hover tooltip of the option (and the trigger). */
  title?: string;
  disabled: boolean;
};

/**
 * What handlers receive. Shaped like a native change event so existing
 * `onChange={(event) => set(event.target.value)}` call sites keep working.
 */
export type SelectChangeEvent = {
  target: { value: string };
  currentTarget: { value: string };
};

export type SelectProps = {
  value?: string | number;
  defaultValue?: string | number;
  onChange?: (event: SelectChangeEvent) => void;
  /** `<option>` children, possibly mapped or inside fragments. */
  children?: React.ReactNode;
  /** Shown when `value` matches no option. */
  placeholder?: React.ReactNode;
  /** Shown inside the open list when there are no options. */
  emptyText?: React.ReactNode;
  /** Preferred side; the list still flips when there is no room. */
  placement?: Extract<PopoverPlacement, "bottom-start" | "top-start">;
  disabled?: boolean;
  id?: string;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: React.AriaAttributes["aria-invalid"];
  "data-testid"?: string;
  onBlur?: React.FocusEventHandler<HTMLButtonElement>;
  onFocus?: React.FocusEventHandler<HTMLButtonElement>;
};

const textOf = (node: React.ReactNode): string => {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join("");
  }
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return textOf(node.props.children);
  }
  return "";
};

const collectOptions = (children: React.ReactNode): SelectOption[] => {
  const options: SelectOption[] = [];
  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) {
      return;
    }
    const props = child.props as {
      value?: string | number;
      children?: React.ReactNode;
      disabled?: boolean;
      title?: string;
    };
    if (child.type === React.Fragment) {
      options.push(...collectOptions(props.children));
      return;
    }
    if (child.type !== "option") {
      return;
    }
    const text = textOf(props.children);
    options.push({
      value: String(props.value ?? text),
      label: props.children,
      text,
      title: props.title || undefined,
      disabled: !!props.disabled,
    });
  });
  return options;
};

const TYPEAHEAD_RESET_MS = 500;

/**
 * App dropdown: a button trigger plus a portalled listbox, styled like the
 * other app popups (Shelf Life picker, action menus) instead of the OS menu.
 * Keeps the `<select>` API (`value`, `onChange(event.target.value)`, `<option>`
 * children). Keyboard: ArrowUp/Down, Home/End, PageUp/Down, typeahead,
 * Enter/Space to pick, Escape/Tab to close; focus stays on the trigger and the
 * active option is exposed through `aria-activedescendant`.
 */
export const Select = forwardRef<HTMLButtonElement, SelectProps>(
  (
    {
      value: controlledValue,
      defaultValue,
      onChange,
      children,
      placeholder,
      emptyText,
      placement = "bottom-start",
      disabled = false,
      id,
      className,
      style,
      title,
      onBlur,
      onFocus,
      ...aria
    },
    forwardedRef,
  ) => {
    const options = useMemo(() => collectOptions(children), [children]);
    const [uncontrolledValue, setUncontrolledValue] = useState(
      defaultValue === undefined
        ? options[0]?.value ?? ""
        : String(defaultValue),
    );
    const value =
      controlledValue === undefined
        ? uncontrolledValue
        : String(controlledValue);
    const selectedIndex = options.findIndex((option) => option.value === value);
    const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

    const [open, setOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(-1);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const typeahead = useRef({ text: "", at: 0 });
    const baseId = useId();
    const listId = `${baseId}-listbox`;
    const optionId = (index: number) => `${baseId}-option-${index}`;

    const setRefs = (node: HTMLButtonElement | null) => {
      triggerRef.current = node;
      if (typeof forwardedRef === "function") {
        forwardedRef(node);
      } else if (forwardedRef) {
        forwardedRef.current = node;
      }
    };

    const close = useCallback(() => setOpen(false), []);
    const { style: popupStyle, position } = usePopover({
      open,
      onClose: close,
      triggerRef,
      popupRef: listRef,
      placement,
      matchTriggerWidth: true,
    });

    const enabledIndexes = useMemo(
      () =>
        options
          .map((option, index) => (option.disabled ? -1 : index))
          .filter((index) => index >= 0),
      [options],
    );

    const openList = (preferred?: "first" | "last") => {
      if (disabled) {
        return;
      }
      const start =
        preferred === "last"
          ? enabledIndexes[enabledIndexes.length - 1]
          : preferred === "first"
          ? enabledIndexes[0]
          : selectedIndex >= 0 && !options[selectedIndex].disabled
          ? selectedIndex
          : enabledIndexes[0];
      setActiveIndex(start ?? -1);
      setOpen(true);
    };

    const commit = (index: number) => {
      const option = options[index];
      if (!option || option.disabled) {
        return;
      }
      setOpen(false);
      if (option.value !== value) {
        if (controlledValue === undefined) {
          setUncontrolledValue(option.value);
        }
        onChange?.({
          target: { value: option.value },
          currentTarget: { value: option.value },
        });
      }
    };

    const move = (from: number, step: number) => {
      if (!enabledIndexes.length) {
        return from;
      }
      const position = enabledIndexes.indexOf(from);
      if (position < 0) {
        return step > 0
          ? enabledIndexes[0]
          : enabledIndexes[enabledIndexes.length - 1];
      }
      const next = Math.min(
        enabledIndexes.length - 1,
        Math.max(0, position + step),
      );
      return enabledIndexes[next];
    };

    const matchTypeahead = (key: string) => {
      const now = Date.now();
      const state = typeahead.current;
      state.text = now - state.at > TYPEAHEAD_RESET_MS ? key : state.text + key;
      state.at = now;
      const query = state.text.toLocaleLowerCase();
      const from = open ? activeIndex : selectedIndex;
      const ordered = [
        ...enabledIndexes.filter((index) => index > from),
        ...enabledIndexes.filter((index) => index <= from),
      ];
      // A repeated single letter cycles through matches.
      const isRepeat =
        query.length > 1 && query.split("").every((char) => char === query[0]);
      const needle = isRepeat ? query[0] : query;
      return ordered.find((index) =>
        options[index].text.toLocaleLowerCase().startsWith(needle),
      );
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) {
        return;
      }
      const { key } = event;
      if (!open) {
        if (
          key === "ArrowDown" ||
          key === "ArrowUp" ||
          key === "Enter" ||
          key === " "
        ) {
          event.preventDefault();
          openList();
        } else if (key === "Home" || key === "End") {
          event.preventDefault();
          openList(key === "Home" ? "first" : "last");
        } else if (key.length === 1 && !event.ctrlKey && !event.metaKey) {
          const match = matchTypeahead(key);
          if (match !== undefined) {
            commit(match);
          }
        }
        return;
      }
      switch (key) {
        case "ArrowDown":
        case "ArrowUp":
          event.preventDefault();
          if (event.altKey) {
            commit(activeIndex);
          } else {
            setActiveIndex((index) =>
              move(index, key === "ArrowDown" ? 1 : -1),
            );
          }
          return;
        case "PageDown":
        case "PageUp":
          event.preventDefault();
          setActiveIndex((index) => move(index, key === "PageDown" ? 5 : -5));
          return;
        case "Home":
        case "End":
          event.preventDefault();
          setActiveIndex(
            key === "Home"
              ? enabledIndexes[0]
              : enabledIndexes[enabledIndexes.length - 1],
          );
          return;
        case "Enter":
        case " ":
          event.preventDefault();
          commit(activeIndex);
          return;
        case "Escape":
          // Keep Escape from also closing the surrounding dialog or sidebar.
          event.preventDefault();
          event.stopPropagation();
          event.nativeEvent.stopImmediatePropagation();
          setOpen(false);
          return;
        case "Tab":
          setOpen(false);
          return;
        default:
          if (key.length === 1 && !event.ctrlKey && !event.metaKey) {
            const match = matchTypeahead(key);
            if (match !== undefined) {
              setActiveIndex(match);
            }
          }
      }
    };

    // Keep the active option visible while navigating.
    useEffect(() => {
      if (!open || activeIndex < 0 || !position) {
        return;
      }
      const option = listRef.current?.querySelector<HTMLElement>(
        `#${CSS.escape(optionId(activeIndex))}`,
      );
      // jsdom has no scrollIntoView.
      option?.scrollIntoView?.({ block: "nearest" });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, activeIndex, position]);

    const triggerLabel = selected ? selected.label : placeholder;

    return (
      <>
        <button
          ref={setRefs}
          id={id}
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={
            open && activeIndex >= 0 ? optionId(activeIndex) : undefined
          }
          {...aria}
          data-value={value}
          disabled={disabled}
          title={
            title ??
            (selected?.title
              ? `${selected.text}\n${selected.title}`
              : selected?.text)
          }
          style={style}
          className={clsx("UiInput", "UiSelect", className, {
            "UiSelect--open": open,
            "UiSelect--placeholder": !selected,
          })}
          onClick={() => (open ? setOpen(false) : openList())}
          onKeyDown={onKeyDown}
          onBlur={(event) => {
            // Clicking an option keeps focus on the trigger (pointerdown is
            // prevented), so a blur means focus really left.
            setOpen(false);
            onBlur?.(event);
          }}
          onFocus={onFocus}
        >
          <span className="UiSelect__value">{triggerLabel}</span>
          <span className="UiSelect__chevron" aria-hidden="true">
            {uiChevronDownIcon}
          </span>
        </button>
        {open &&
          createPortal(
            <div
              ref={listRef}
              id={listId}
              role="listbox"
              // Portalled outside its host: keep editor menus/popovers that
              // contain this select (e.g. the main menu) from closing.
              data-prevent-outside-click
              aria-labelledby={aria["aria-labelledby"]}
              aria-label={
                aria["aria-labelledby"] ? undefined : aria["aria-label"]
              }
              tabIndex={-1}
              className={clsx("UiPopover", "UiSelect__list", {
                "UiPopover--top": position?.side === "top",
              })}
              style={popupStyle}
              // Keep focus (and the open state) on the trigger.
              onPointerDown={(event) => event.preventDefault()}
            >
              {options.length === 0 && (
                <div className="UiPopover__empty" role="presentation">
                  {emptyText ?? placeholder ?? "—"}
                </div>
              )}
              {options.map((option, index) => (
                <div
                  key={`${option.value}-${index}`}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === selectedIndex}
                  aria-disabled={option.disabled || undefined}
                  title={option.title}
                  className={clsx("UiPopover__item", "UiSelect__option", {
                    "is-active": index === activeIndex,
                    "is-selected": index === selectedIndex,
                    "is-disabled": option.disabled,
                  })}
                  onPointerMove={() => {
                    if (!option.disabled && index !== activeIndex) {
                      setActiveIndex(index);
                    }
                  }}
                  onClick={() => commit(index)}
                >
                  <span className="UiPopover__label">{option.label}</span>
                  <span className="UiPopover__check" aria-hidden="true">
                    {index === selectedIndex ? uiCheckIcon : null}
                  </span>
                </div>
              ))}
            </div>,
            getPopoverHost(triggerRef.current),
          )}
      </>
    );
  },
);
Select.displayName = "Select";
