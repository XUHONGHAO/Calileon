import clsx from "clsx";
import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { t } from "@excalidraw/excalidraw/i18n";

import { UiButton } from "./UiButton";
import { uiMoreIcon } from "./icons";
import { getPopoverHost, usePopover } from "./usePopover";

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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) {
      triggerRef.current?.focus();
    }
  }, []);
  const dismiss = useCallback(() => close(false), [close]);

  const { style: menuStyle, position } = usePopover({
    open,
    onClose: dismiss,
    triggerRef,
    popupRef: menuRef,
    placement: "bottom-end",
  });

  // Focus the first item once the menu has been measured and placed.
  const placed = !!position;
  useEffect(() => {
    if (open && placed) {
      menuRef.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus({ preventScroll: true });
    }
  }, [open, placed]);

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

  const host = getPopoverHost(triggerRef.current);

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
            className={clsx("UiPopover", "UiActionMenu", {
              "UiPopover--top": position?.side === "top",
            })}
            style={menuStyle}
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
