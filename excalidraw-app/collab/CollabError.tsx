import { ErrorDialog } from "@excalidraw/excalidraw/components/ErrorDialog";
import { Tooltip } from "@excalidraw/excalidraw/components/Tooltip";
import { warning } from "@excalidraw/excalidraw/components/icons";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";

import { atom } from "../app-jotai";
import { UiButton } from "../components/ui";

import "./CollabError.scss";

type ErrorIndicator = {
  message: string | null;
  /** used to rerun the useEffect responsible for animation */
  nonce: number;
};

export const collabErrorIndicatorAtom = atom<ErrorIndicator>({
  message: null,
  nonce: 0,
});

const CollabError = ({ collabError }: { collabError: ErrorIndicator }) => {
  const [isAnimating, setIsAnimating] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const clearAnimationRef = useRef<string | number>(0);

  useEffect(() => {
    setIsAnimating(true);
    clearAnimationRef.current = window.setTimeout(() => {
      setIsAnimating(false);
    }, 1000);

    return () => {
      window.clearTimeout(clearAnimationRef.current);
    };
  }, [collabError.message, collabError.nonce]);

  if (!collabError.message) {
    return null;
  }

  // The tooltip covers hover; the button makes the message reachable by
  // keyboard and touch (it opens the full text in a dialog).
  return (
    <>
      <Tooltip label={collabError.message} long={true}>
        <UiButton
          variant="ghost"
          size="sm"
          iconOnly
          icon={warning}
          aria-label={collabError.message}
          aria-haspopup="dialog"
          className={clsx("collab-errors-button", {
            "collab-errors-button-shake": isAnimating,
          })}
          onClick={() => setIsDialogOpen(true)}
        />
      </Tooltip>
      {isDialogOpen && (
        <ErrorDialog onClose={() => setIsDialogOpen(false)}>
          {collabError.message}
        </ErrorDialog>
      )}
    </>
  );
};

CollabError.displayName = "CollabError";

export default CollabError;
