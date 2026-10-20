import React, { useEffect, useRef } from "react";

import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { t } from "@excalidraw/excalidraw/i18n";

import { appJotaiStore, atom, useAtom } from "../../app-jotai";

import { DialogActions } from "./Layout";
import { UiButton } from "./UiButton";

type ConfirmRequest = {
  message: React.ReactNode;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  resolve: (confirmed: boolean) => void;
};

const confirmRequestAtom = atom<ConfirmRequest | null>(null);
let hostMounted = 0;

/**
 * Themed replacement for `window.confirm`. Resolves `true` when confirmed.
 * Falls back to the native prompt where no `<ConfirmHost />` is mounted
 * (isolated component tests, the single-file runtime).
 */
export const confirmAction = (
  message: string,
  options: Omit<ConfirmRequest, "message" | "resolve"> = {},
): Promise<boolean> => {
  if (!hostMounted) {
    return Promise.resolve(window.confirm(message));
  }
  return new Promise<boolean>((resolve) => {
    appJotaiStore.get(confirmRequestAtom)?.resolve(false);
    appJotaiStore.set(confirmRequestAtom, { message, resolve, ...options });
  });
};

/** Mount once inside the editor (it renders an editor Dialog). */
export const ConfirmHost = () => {
  const [request, setRequest] = useAtom(confirmRequestAtom);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    hostMounted += 1;
    return () => {
      hostMounted -= 1;
      appJotaiStore.get(confirmRequestAtom)?.resolve(false);
      appJotaiStore.set(confirmRequestAtom, null);
    };
  }, []);

  useEffect(() => {
    if (request) {
      // Destructive prompts start on the safe choice.
      const timer = window.setTimeout(() => cancelRef.current?.focus());
      return () => window.clearTimeout(timer);
    }
  }, [request]);

  if (!request) {
    return null;
  }

  const settle = (confirmed: boolean) => {
    request.resolve(confirmed);
    setRequest(null);
  };

  return (
    <Dialog
      size="small"
      title={request.title ?? t("ui.confirmTitle")}
      onCloseRequest={() => settle(false)}
      autofocus={false}
      className="UiConfirmDialog"
    >
      <div className="UiConfirmDialog__message">{request.message}</div>
      <DialogActions>
        <UiButton ref={cancelRef} onClick={() => settle(false)}>
          {request.cancelLabel ?? t("buttons.cancel")}
        </UiButton>
        <UiButton
          variant={request.danger === false ? "primary" : "danger"}
          onClick={() => settle(true)}
        >
          {request.confirmLabel ?? t("buttons.confirm")}
        </UiButton>
      </DialogActions>
    </Dialog>
  );
};
