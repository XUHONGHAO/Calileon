import clsx from "clsx";
import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { t } from "@excalidraw/excalidraw/i18n";

import { UiButton } from "./UiButton";
import { uiMoreIcon } from "./icons";

export type ActionMenuItem = {
  label: string;
  onSelect: () => void;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
};

/**
 * "More actions" button with a small popup menu. The popup is portalled next
 * to the modal (outside any scroll container) so it is never clipped.
 */
export const ActionMenu = ({
  items,
  label = t("ui.moreActions"),
  className,
}: {
  items: ActionMenuItem[];
  label?: string;
  className?: string;
}) => {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    const menuWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;
    const below = rect.bottom + 4 + menuHeight <= window.innerHeight;
    setPosition({
      top: below ? rect.bottom + 4 : Math.max(8, rect.top - 4 - menuHeight),
      left: Math.min(
        Math.max(8, rect.right - menuWidth),
        window.innerWidth - menuWidth - 8,
      ),
    });
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.contains(target) && !trigger.contains(target)) {
        close(false);
      }
    };
    const onScroll = () => close(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, close]);

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ) ?? [],
    );
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape" || event.key === "Tab") {
      // Keep Escape from also closing the surrounding dialog.
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      if (event.key === "Escape") {
        event.preventDefault();
      }
      close(event.key === "Escape");
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      buttons[(index + step + buttons.length) % buttons.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      buttons[event.key === "Home" ? 0 : buttons.length - 1]?.focus();
    }
  };

  const host =
    triggerRef.current?.closest<HTMLElement>(".excalidraw") ?? document.body;

  return (
    <>
      <UiButton
        ref={triggerRef}
        variant="ghost"
        size="sm"
        iconOnly
        icon={uiMoreIcon}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className={clsx("UiActionMenu__trigger", className)}
        onClick={() => setOpen((value) => !value)}
      />
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={label}
            className="UiActionMenu"
            style={{
              top: position?.top ?? -9999,
              left: position?.left ?? -9999,
            }}
            onKeyDown={onMenuKeyDown}
          >
            {items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={clsx("UiActionMenu__item", {
                  "UiActionMenu__item--danger": item.danger,
                })}
                onClick={() => {
                  close(true);
                  item.onSelect();
                }}
              >
                {item.icon && (
                  <span className="UiActionMenu__icon" aria-hidden="true">
                    {item.icon}
                  </span>
                )}
                <span className="UiActionMenu__label">{item.label}</span>
              </button>
            ))}
          </div>,
          host,
        )}
    </>
  );
};
