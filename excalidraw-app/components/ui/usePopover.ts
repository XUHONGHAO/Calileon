import { useCallback, useEffect, useLayoutEffect, useState } from "react";

export type PopoverPlacement =
  | "bottom-start"
  | "bottom-end"
  | "top-start"
  | "top-end";

export type PopoverPosition = {
  top: number;
  left: number;
  /** Set when `matchTriggerWidth`: the popup is at least as wide as the trigger. */
  minWidth?: number;
  maxHeight: number;
  /** Side actually used after flipping; drives the open animation origin. */
  side: "top" | "bottom";
};

const GAP = 4;
const MARGIN = 8;

/**
 * Shared positioning and dismissal for app popups (select listboxes, action
 * menus, pickers). The popup is `position: fixed` and portalled, so it is never
 * clipped by a scroll container. It opens on the preferred side and flips when
 * that side lacks room, follows the trigger on scroll/resize (instead of
 * closing), and closes when the trigger scrolls out of view or on an outside
 * pointerdown.
 */
export const usePopover = ({
  open,
  onClose,
  triggerRef,
  popupRef,
  placement = "bottom-start",
  matchTriggerWidth = false,
  maxHeight: preferredMaxHeight = 320,
}: {
  open: boolean;
  onClose: () => void;
  triggerRef: React.RefObject<HTMLElement | null>;
  popupRef: React.RefObject<HTMLElement | null>;
  placement?: PopoverPlacement;
  matchTriggerWidth?: boolean;
  maxHeight?: number;
}) => {
  const [position, setPosition] = useState<PopoverPosition>();

  const update = useCallback(() => {
    const trigger = triggerRef.current;
    const popup = popupRef.current;
    if (!trigger || !popup) {
      return;
    }
    const rect = trigger.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      onClose();
      return;
    }
    const spaceBelow = window.innerHeight - rect.bottom - GAP - MARGIN;
    const spaceAbove = rect.top - GAP - MARGIN;
    const naturalHeight = Math.min(popup.scrollHeight, preferredMaxHeight);
    const preferTop = placement.startsWith("top");
    const side: "top" | "bottom" = preferTop
      ? spaceAbove >= naturalHeight || spaceAbove > spaceBelow
        ? "top"
        : "bottom"
      : spaceBelow >= naturalHeight || spaceBelow >= spaceAbove
      ? "bottom"
      : "top";
    const maxHeight = Math.max(
      120,
      Math.min(preferredMaxHeight, side === "bottom" ? spaceBelow : spaceAbove),
    );
    const height = Math.min(naturalHeight, maxHeight);
    const minWidth = matchTriggerWidth ? rect.width : undefined;
    const width = Math.max(popup.offsetWidth, minWidth ?? 0);
    const anchorLeft = placement.endsWith("end")
      ? rect.right - width
      : rect.left;
    const next: PopoverPosition = {
      side,
      maxHeight,
      minWidth,
      top: side === "bottom" ? rect.bottom + GAP : rect.top - GAP - height,
      left: Math.min(
        Math.max(MARGIN, anchorLeft),
        Math.max(MARGIN, window.innerWidth - width - MARGIN),
      ),
    };
    // Resize observers and scroll frames call this often; skip no-op renders.
    setPosition((current) =>
      current &&
      current.side === next.side &&
      current.top === next.top &&
      current.left === next.left &&
      current.minWidth === next.minWidth &&
      current.maxHeight === next.maxHeight
        ? current
        : next,
    );
  }, [
    triggerRef,
    popupRef,
    onClose,
    placement,
    matchTriggerWidth,
    preferredMaxHeight,
  ]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(undefined);
      return;
    }
    update();
  }, [open, update]);

  useEffect(() => {
    if (!open) {
      return;
    }
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !popupRef.current?.contains(target) &&
        !triggerRef.current?.contains(target)
      ) {
        onClose();
      }
    };
    const onScroll = (event: Event) => {
      // Scrolling inside the popup itself must not move it.
      if (popupRef.current?.contains(event.target as Node)) {
        return;
      }
      schedule();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", schedule);
    // Content that changes height (a filtered list) must stay pinned to the
    // trigger, which matters most when the popup opens upwards.
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    if (popupRef.current) {
      observer?.observe(popupRef.current);
    }
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", schedule);
    };
  }, [open, update, onClose, popupRef, triggerRef]);

  /** Style for the popup element; off-screen until measured. */
  const style: React.CSSProperties = position
    ? {
        top: position.top,
        left: position.left,
        minWidth: position.minWidth,
        maxHeight: position.maxHeight,
      }
    : { top: -9999, left: -9999, visibility: "hidden" };

  return { position, style, update };
};

/** Portal target: the nearest editor root, so tokens and theme apply. */
export const getPopoverHost = (trigger: HTMLElement | null) =>
  trigger?.closest<HTMLElement>(".excalidraw") ?? document.body;
