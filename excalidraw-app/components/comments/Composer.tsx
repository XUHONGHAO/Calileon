import clsx from "clsx";
import { forwardRef, useId, useState } from "react";

import { CloseIcon } from "@excalidraw/excalidraw/components/icons";
import { t } from "@excalidraw/excalidraw/i18n";

import { toExcerpt } from "../../comments/feed";
import {
  COMMENT_COUNTER_FROM,
  COMMENT_MAX_LENGTH,
  countChars,
  isComposingEnter,
} from "../../comments/limits";
import { TextArea, UiButton } from "../ui";

import { getDisplayName } from "./CommentItem";

import type { SceneComment } from "../../data/cloud/types";

type ComposerProps = {
  replyTo: SceneComment | null;
  disabled: boolean;
  onCancelReply: () => void;
  onSend: (body: string, quotedId: string | null) => void;
};

export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(
  ({ replyTo, disabled, onCancelReply, onSend }, ref) => {
    const [value, setValue] = useState("");
    const hintId = useId();
    const count = countChars(value);
    const tooLong = count > COMMENT_MAX_LENGTH;
    const canSend = !disabled && count > 0 && !tooLong;

    const send = () => {
      if (!canSend) {
        return;
      }
      onSend(value.trim(), replyTo?.id ?? null);
      setValue("");
    };

    return (
      <form
        className="CommentsComposer"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        {replyTo && (
          <div className="CommentsComposer__reply">
            <span className="CommentsComposer__replyText">
              {t("comments.composer.replyingTo", {
                name: getDisplayName(replyTo),
                excerpt: toExcerpt(replyTo.body ?? ""),
              })}
            </span>
            <UiButton
              size="sm"
              variant="ghost"
              iconOnly
              icon={CloseIcon}
              aria-label={t("comments.composer.cancelReply")}
              title={t("comments.composer.cancelReply")}
              onClick={onCancelReply}
            />
          </div>
        )}
        <div className="CommentsComposer__row">
          <TextArea
            ref={ref}
            value={value}
            rows={2}
            disabled={disabled}
            placeholder={t("comments.composer.placeholder")}
            aria-label={t("comments.composer.label")}
            aria-describedby={hintId}
            aria-invalid={tooLong || undefined}
            className="CommentsField"
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (isComposingEnter(event)) {
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              } else if (event.key === "Escape" && replyTo) {
                event.preventDefault();
                event.stopPropagation();
                onCancelReply();
              }
            }}
          />
          <UiButton type="submit" variant="primary" disabled={!canSend}>
            {t("comments.composer.send")}
          </UiButton>
        </div>
        <div className="CommentsComposer__meta">
          <span id={hintId} className="CommentsComposer__hint">
            {t("comments.composer.hint")}
          </span>
          {count > COMMENT_COUNTER_FROM && (
            <span
              className={clsx("CommentsCounter", {
                "CommentsCounter--over": tooLong,
              })}
              aria-live="polite"
            >
              {t("comments.composer.counter", { count })}
            </span>
          )}
        </div>
      </form>
    );
  },
);
Composer.displayName = "Composer";
