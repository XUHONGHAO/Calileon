import clsx from "clsx";
import React, { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { queryFocusableElements } from "@excalidraw/common";

import { getPopoverHost, usePopover } from "./usePopover";

import type { PopoverPlacement } from "./usePopover";

const MENU_ITEMS =
  "[role='menuitem']:not(:disabled), [role='menuitemradio']:not(:disabled), [role='menuitemcheckbox']:not(:disabled)";

export type PopoverProps = {
  open: boolean;
  onClose: () => void;
  /** Trigger (or field) the popup is anchored to; focus returns here. */
  anchorRef: React.RefObject<HTMLElement | null>;
  /**
   * - `menu`: items are `role="menuitem*"` buttons. Arrow keys, Home/End,
   *   focus starts on the checked item; Tab closes.
   * - `dialog`: free content (search + list). Tab moves inside; tabbing past
   *   either end closes and returns to the trigger.
   * - `listbox`: focus stays on the anchor (a combobox-style field that owns
   *   the keyboard). The popup never takes focus and keeps it on pointerdown.
   */
  role: "menu" | "dialog" | "listbox";
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  placement?: PopoverPlacement;
  matchAnchorWidth?: boolean;
  maxHeight?: number;
  /** Dialog popups: what to focus on open (defaults to the first control). */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  className?: string;
  children: React.ReactNode;
};

/**
 * Anchored app popup on the shared `.UiPopover` surface: portalled to the
 * editor root (never clipped by a scroll container), flips and follows its
 * anchor, closes on Escape and on an outside pointerdown, and hands focus back
 * to the anchor when it closed while holding focus.
 */
export const Popover = ({
  open,
  onClose,
  anchorRef,
  role,
  id,
  placement = "bottom-start",
  matchAnchorWidth = false,
  maxHeight,
  initialFocusRef,
  className,
  children,
  ...aria
}: PopoverProps) => {
  const popupRef = useRef<HTMLDivElement>(null);
  // Whether focus is inside the popup. Outside dismissal clears it, so a click
  // elsewhere never drags focus back to the anchor.
  const hasFocusRef = useRef(false);
  // Pick the portal host once per open session. Re-resolving it every render
  // would move the portal (remounting the content and dropping focus) when the
  // anchor ref only becomes available after the first render.
  const hostRef = useRef<HTMLElement | null>(null);
  if (!open) {
    hostRef.current = null;
  } else if (!hostRef.current) {
    hostRef.current = getPopoverHost(anchorRef.current);
  }

  const dismiss = useCallback(() => {
    hasFocusRef.current = false;
    onClose();
  }, [onClose]);

  const { style, position } = usePopover({
    open,
    onClose: dismiss,
    triggerRef: anchorRef,
    popupRef,
    placement,
    matchTriggerWidth: matchAnchorWidth,
    maxHeight,
  });

  const focusAnchor = useCallback(() => {
    hasFocusRef.current = false;
    anchorRef.current?.focus({ preventScroll: true });
  }, [anchorRef]);

  // Move focus in once the popup has been placed: until then it is
  // `visibility: hidden`, and browsers ignore focus() on hidden elements.
  const placed = !!position;
  const didFocusRef = useRef(false);
  useEffect(() => {
    if (!open) {
      didFocusRef.current = false;
      return;
    }
    if (!placed || didFocusRef.current || role === "listbox") {
      return;
    }
    const popup = popupRef.current;
    if (!popup) {
      return;
    }
    didFocusRef.current = true;
    const target =
      role === "menu"
        ? popup.querySelector<HTMLElement>(
            "[aria-checked='true']:not(:disabled)",
          ) ?? popup.querySelector<HTMLElement>(MENU_ITEMS)
        : initialFocusRef?.current ?? queryFocusableElements(popup)[0];
    (target ?? popup).focus({ preventScroll: true });
    // Once per open: re-renders must not pull focus back to the first item.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, placed]);

  // An item that closes the popup unmounts the focused element; give focus
  // back to the anchor instead of dropping it on <body>.
  useEffect(() => {
    if (!open) {
      return;
    }
    const anchor = anchorRef.current;
    return () => {
      if (!hasFocusRef.current) {
        return;
      }
      hasFocusRef.current = false;
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (!active || active === document.body || !active.isConnected) {
          anchor?.focus({ preventScroll: true });
        }
      });
    };
  }, [open, anchorRef]);

  if (!open) {
    return null;
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const popup = popupRef.current;
    if (!popup || event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === "Escape") {
      // Keep Escape from also closing the surrounding dialog or sidebar.
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      onClose();
      focusAnchor();
      return;
    }
    if (event.key === "Tab") {
      if (role === "menu") {
        event.preventDefault();
        onClose();
        focusAnchor();
        return;
      }
      const focusable = queryFocusableElements(popup);
      const atEdge = event.shiftKey
        ? document.activeElement === focusable[0]
        : document.activeElement === focusable[focusable.length - 1];
      if (atEdge || !focusable.length) {
        event.preventDefault();
        onClose();
        focusAnchor();
      }
      return;
    }
    if (role !== "menu") {
      return;
    }
    const items = Array.from(popup.querySelectorAll<HTMLElement>(MENU_ITEMS));
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    }
  };

  return createPortal(
    <div
      ref={popupRef}
      id={id}
      role={role}
      {...aria}
      tabIndex={-1}
      // Portalled outside its host: keep editor menus/sidebars that contain
      // the trigger from treating clicks in here as outside clicks.
      data-prevent-outside-click
      className={clsx("UiPopover", className, {
        "UiPopover--top": position?.side === "top",
        "UiPopover--end": placement.endsWith("end"),
      })}
      style={style}
      onKeyDown={onKeyDown}
      onFocus={() => {
        hasFocusRef.current = true;
      }}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null;
        if (
          next &&
          !event.currentTarget.contains(next) &&
          // The trigger's own click toggles the popup; closing here would
          // make that click reopen it.
          !anchorRef.current?.contains(next)
        ) {
          hasFocusRef.current = false;
          // Focus moved elsewhere (e.g. a click on another control).
          onClose();
        }
      }}
      onMouseDown={
        role === "listbox"
          ? // Keep the caret and focus in the anchored field.
            (event) => event.preventDefault()
          : undefined
      }
    >
      {children}
    </div>,
    hostRef.current ?? document.body,
  );
};

/** Section label inside a popup (not focusable). */
export const PopoverHeading = ({
  children,
  id,
}: {
  children: React.ReactNode;
  id?: string;
}) => (
  <div className="UiPopover__heading" id={id} role="presentation">
    {children}
  </div>
);

export const PopoverSeparator = () => (
  <div className="UiPopover__separator" role="separator" />
);
