import clsx from "clsx";
import React, { useRef } from "react";

type Option<T extends string> = {
  value: T;
  label: React.ReactNode;
  disabled?: boolean;
  title?: string;
};

const moveFocus = (
  event: React.KeyboardEvent<HTMLElement>,
  container: HTMLElement | null,
  selector: string,
) => {
  const keys = [
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
  ];
  if (!container || !keys.includes(event.key)) {
    return null;
  }
  const items = Array.from(
    container.querySelectorAll<HTMLButtonElement>(selector),
  ).filter((item) => !item.disabled);
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  let next = index;
  if (event.key === "Home") {
    next = 0;
  } else if (event.key === "End") {
    next = items.length - 1;
  } else {
    const step = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    next = (index + step + items.length) % items.length;
  }
  event.preventDefault();
  items[next]?.focus();
  return items[next] ?? null;
};

/**
 * Mutually exclusive options shown as a segmented bar (radio group with a
 * roving tab stop). Use for modes and filters, not for page-level tabs.
 */
export const SegmentedControl = <T extends string>({
  options,
  value,
  onChange,
  label,
  fullWidth = false,
  size = "md",
  className,
}: {
  options: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  fullWidth?: boolean;
  size?: "sm" | "md";
  className?: string;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      className={clsx(
        "UiSegmented",
        `UiSegmented--${size}`,
        { "UiSegmented--fullWidth": fullWidth },
        className,
      )}
      onKeyDown={(event) => {
        const next = moveFocus(event, ref.current, "[role=radio]");
        const nextValue = next?.dataset.value as T | undefined;
        if (nextValue) {
          onChange(nextValue);
        }
      }}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={option.disabled}
            title={option.title}
            data-value={option.value}
            className={clsx("UiSegmented__option", {
              "UiSegmented__option--checked": checked,
            })}
            onClick={() => onChange(option.value)}
          >
            <span className="UiSegmented__label">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
};

/**
 * Page-level tab list (ARIA tabs pattern). Render panels with
 * `getTabPanelProps(idPrefix, value)` so tabs and panels are linked.
 */
export const TabList = <T extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix,
  className,
}: {
  tabs: readonly Option<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  idPrefix: string;
  className?: string;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      role="tablist"
      aria-label={label}
      className={clsx("UiTabs", className)}
      onKeyDown={(event) => {
        const next = moveFocus(event, ref.current, "[role=tab]");
        const nextValue = next?.dataset.value as T | undefined;
        if (nextValue) {
          onChange(nextValue);
        }
      }}
    >
      {tabs.map((tab) => {
        const selected = tab.value === value;
        return (
          <button
            key={tab.value}
            id={`${idPrefix}-tab-${tab.value}`}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${tab.value}`}
            tabIndex={selected ? 0 : -1}
            disabled={tab.disabled}
            title={tab.title}
            data-value={tab.value}
            className={clsx("UiTabs__tab", {
              "UiTabs__tab--selected": selected,
            })}
            onClick={() => onChange(tab.value)}
          >
            <span className="UiTabs__label">{tab.label}</span>
          </button>
        );
      })}
    </div>
  );
};

export const getTabPanelProps = (idPrefix: string, value: string) => ({
  id: `${idPrefix}-panel-${value}`,
  role: "tabpanel" as const,
  "aria-labelledby": `${idPrefix}-tab-${value}`,
  tabIndex: 0,
});
