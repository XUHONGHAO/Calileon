import clsx from "clsx";
import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { KEYS } from "@excalidraw/common";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { CloseIcon } from "@excalidraw/excalidraw/components/icons";
import { t } from "@excalidraw/excalidraw/i18n";

import type { DialogSize } from "@excalidraw/excalidraw/components/Dialog";

import { UiButton } from "./UiButton";

export type AppDialogProps = {
  children: React.ReactNode;
  /**
   * Dialog heading. `false` only for dialogs that render their own visible
   * heading inside the content (the share picker); the close button stays.
   */
  title: React.ReactNode | false;
  onCloseRequest: () => void;
  size?: DialogSize;
  className?: string;
  /**
   * While true the dialog cannot be dismissed (close button, Escape, backdrop):
   * use it for in-flight work whose result must not land on a closed dialog.
   */
  busy?: boolean;
  /**
   * Called before any dismissal. Resolve to `false` to keep the dialog open,
   * e.g. after a "discard unsaved changes?" `confirmAction`.
   */
  onBeforeClose?: () => boolean | Promise<boolean>;
  /** Defaults to true; ignored while `busy`. */
  closeOnClickOutside?: boolean;
  /**
   * Element to focus on open. Without it the dialog surface itself takes
   * focus, so no control shows a focus ring until the user presses Tab.
   */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** Accessible name when `title` is `false`. */
  ariaLabel?: string;
};

const MAIN_MENU_TRIGGER = ".excalidraw .main-menu-trigger";

const isEscape = (event: KeyboardEvent) =>
  event.key === KEYS.ESCAPE && !event.isComposing;

/**
 * App dialog shell on top of the editor's `Dialog`:
 * - a close button on every form factor (the editor only renders one on
 *   phones, where we keep using it);
 * - calm initial focus (dialog surface or `initialFocusRef`) instead of the
 *   editor's "second focusable element", which put a ring on a random button;
 * - focus returns to the opener, or to the main menu trigger when the opener
 *   was a menu item that has since unmounted;
 * - one guarded close path for the button, Escape and the backdrop.
 */
export const AppDialog = ({
  children,
  title,
  onCloseRequest,
  size = "regular",
  className,
  busy = false,
  onBeforeClose,
  closeOnClickOutside = true,
  initialFocusRef,
  ariaLabel,
}: AppDialogProps) => {
  const titleId = useId();
  const openerRef = useRef<Element | null>(null);
  const closingRef = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // Capture the opener before the dialog takes focus.
  if (openerRef.current === null) {
    openerRef.current = document.activeElement;
  }

  const requestClose = useCallback(async () => {
    if (busyRef.current || closingRef.current) {
      return;
    }
    if (onBeforeClose) {
      closingRef.current = true;
      try {
        if (!(await onBeforeClose())) {
          return;
        }
      } finally {
        closingRef.current = false;
      }
    }
    onCloseRequest();
  }, [onBeforeClose, onCloseRequest]);

  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  // The editor Modal creates its portal container in an effect, so on the
  // first render nothing below is mounted yet. A state-backed ref re-runs the
  // setup once the close button (and with it the Island) actually exists.
  const [closeButton, setCloseButton] = useState<HTMLButtonElement | null>(
    null,
  );

  useLayoutEffect(() => {
    const island = closeButton?.closest<HTMLElement>(".Island");
    if (!island) {
      return;
    }
    island.tabIndex = -1;
    island.classList.add("AppDialog__surface");

    // Escape while the surface itself is focused never reaches the React
    // handler below (it lives inside the content), so catch it here.
    const onSurfaceKeyDown = (event: KeyboardEvent) => {
      if (event.target === island && isEscape(event)) {
        event.preventDefault();
        event.stopPropagation();
        void requestCloseRef.current();
      }
    };
    island.addEventListener("keydown", onSurfaceKeyDown);

    const placeFocus = () => {
      // Respect a dialog that already focused something inside itself
      // (e.g. its selected option) unless an explicit target was given.
      if (
        !initialFocusRef?.current &&
        island.contains(document.activeElement) &&
        document.activeElement !== island
      ) {
        return;
      }
      (initialFocusRef?.current ?? island).focus({ preventScroll: true });
    };

    // A closing menu hands focus back to its trigger a moment after the
    // dialog opens. For a short window, take focus back when it leaves for
    // something outside every dialog/popup.
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        !island.contains(target) &&
        !target.closest(".Modal, .UiPopover, [role='listbox'], [role='menu']")
      ) {
        placeFocus();
      }
    };
    document.addEventListener("focusin", onFocusIn, true);
    const settle = window.setTimeout(
      () => document.removeEventListener("focusin", onFocusIn, true),
      400,
    );
    const frame = requestAnimationFrame(placeFocus);

    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
      document.removeEventListener("focusin", onFocusIn, true);
      island.removeEventListener("keydown", onSurfaceKeyDown);
    };
    // Once per mounted Island: re-renders must not move focus back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeButton]);

  // The editor Modal points `aria-labelledby` at a fixed "dialog-title" while
  // the heading's id is container-prefixed (and shared by stacked dialogs),
  // so the dialog has no accessible name. Point it at our own title instead.
  const hasTitle = title !== false;
  useLayoutEffect(() => {
    const modal = closeButton?.closest<HTMLElement>(".Modal");
    if (!modal) {
      return;
    }
    // The editor renders the title text in a span React gives no id, so a
    // unique id set here is never overwritten.
    const titleContent = modal.querySelector<HTMLElement>(
      ".Dialog__titleContent",
    );
    if (hasTitle && titleContent) {
      titleContent.id = titleId;
      modal.setAttribute("aria-labelledby", titleId);
      modal.removeAttribute("aria-label");
    } else if (!hasTitle && ariaLabel) {
      modal.removeAttribute("aria-labelledby");
      modal.setAttribute("aria-label", ariaLabel);
    }
  }, [closeButton, hasTitle, ariaLabel, titleId]);

  useEffect(() => {
    const opener = openerRef.current;
    return () => {
      // Runs after the editor Dialog's own (often stale) focus restore.
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && active !== document.body && active.isConnected) {
          // Something else, e.g. a follow-up dialog, already took focus.
          return;
        }
        if (opener instanceof HTMLElement && opener.isConnected) {
          if (opener !== document.body) {
            opener.focus({ preventScroll: true });
          }
          return;
        }
        // The opener was a menu item that unmounted together with its menu.
        document
          .querySelector<HTMLElement>(MAIN_MENU_TRIGGER)
          ?.focus({ preventScroll: true });
      });
    };
  }, []);

  // Escape from inside the content. Handling it here (instead of letting the
  // editor Modal see it) keeps a busy or cancelled close from moving focus out
  // of a dialog that stays open. Nested popovers that own Escape stop it first.
  const onContentKeyDown = (event: React.KeyboardEvent) => {
    if (isEscape(event.nativeEvent)) {
      event.preventDefault();
      event.stopPropagation();
      void requestClose();
    }
  };

  return (
    <Dialog
      title={title}
      size={size}
      className={clsx("AppDialog", className)}
      onCloseRequest={() => void requestClose()}
      closeOnClickOutside={closeOnClickOutside && !busy}
      autofocus={false}
    >
      <div className="AppDialog__content" onKeyDown={onContentKeyDown}>
        <UiButton
          ref={setCloseButton}
          className="AppDialog__close"
          variant="ghost"
          size="sm"
          iconOnly
          icon={CloseIcon}
          aria-label={t("buttons.close")}
          title={t("buttons.close")}
          onClick={() => void requestClose()}
          disabled={busy}
        />
        {children}
      </div>
    </Dialog>
  );
};
