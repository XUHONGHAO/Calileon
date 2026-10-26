import clsx from "clsx";
import { memo, useEffect, useRef, useState } from "react";

import { getDefaultAudioAvatar } from "@excalidraw/element";
import { pencilIcon, TrashIcon } from "@excalidraw/excalidraw/components/icons";
import { t } from "@excalidraw/excalidraw/i18n";
import { AudioAvatar } from "@excalidraw/excalidraw/voice/AudioAvatar";

import type { AppState } from "@excalidraw/excalidraw/types";

import {
  canChangeStatus,
  canDelete,
  canEdit,
  canReply,
  isAuthor,
} from "../../comments/deletePolicy";
import { formatClock, formatFullTime } from "../../comments/feed";
import {
  COMMENT_COUNTER_FROM,
  COMMENT_MAX_LENGTH,
  countChars,
  isComposingEnter,
} from "../../comments/limits";
import { toBackendError } from "../../comments/commentsController";
import { ActionMenu, Badge, TextArea, UiButton } from "../ui";

import { replyIcon, resolvedIcon } from "./icons";

import type { Viewer } from "../../comments/deletePolicy";
import type { QuoteSummary } from "../../comments/feed";
import type { PendingComment } from "../../comments/commentsController";
import type { SceneComment } from "../../data/cloud/types";
import type { ActionMenuItem } from "../ui";

export const AVATAR_SIZE = 28;
const LONG_PRESS_MS = 500;
const LONG_PRESS_SHOW_MS = 4000;

export type CommentFormat = {
  locale: string;
  timeZone: string;
  theme: AppState["theme"];
};

export const getDisplayName = (comment: Pick<SceneComment, "authorName">) =>
  comment.authorName.trim() || t("comments.unnamed");

/** `HH:mm`; the full date and time on hover, or on a long press (touch). */
const CommentTime = ({ ms, format }: { ms: number; format: CommentFormat }) => {
  const [revealed, setRevealed] = useState(false);
  const pressTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const full = formatFullTime(ms, format.timeZone, format.locale);

  const cancelPress = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  useEffect(
    () => () => {
      cancelPress();
      if (hideTimer.current !== null) {
        window.clearTimeout(hideTimer.current);
      }
    },
    [],
  );

  return (
    <time
      className="CommentItem__time"
      dateTime={new Date(ms).toISOString()}
      title={full}
      onPointerDown={(event) => {
        if (event.pointerType !== "touch") {
          return;
        }
        cancelPress();
        pressTimer.current = window.setTimeout(() => {
          pressTimer.current = null;
          setRevealed(true);
          if (hideTimer.current !== null) {
            window.clearTimeout(hideTimer.current);
          }
          hideTimer.current = window.setTimeout(
            () => setRevealed(false),
            LONG_PRESS_SHOW_MS,
          );
        }, LONG_PRESS_MS);
      }}
      onPointerUp={cancelPress}
      onPointerLeave={cancelPress}
      onPointerCancel={cancelPress}
    >
      {revealed ? full : formatClock(ms, format.timeZone, format.locale)}
    </time>
  );
};

const InlineEditor = ({
  comment,
  onSave,
  onCancel,
}: {
  comment: SceneComment;
  onSave: (body: string) => Promise<void>;
  onCancel: () => void;
}) => {
  const [draft, setDraft] = useState(comment.body ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const count = countChars(draft);
  const tooLong = count > COMMENT_MAX_LENGTH;

  useEffect(() => {
    const field = ref.current;
    if (field) {
      field.focus({ preventScroll: true });
      field.setSelectionRange(field.value.length, field.value.length);
    }
  }, []);

  const save = async () => {
    const body = draft.trim();
    if (saving || !body || tooLong) {
      return;
    }
    if (body === (comment.body ?? "").trim()) {
      onCancel();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(body);
    } catch (err) {
      setError(toBackendError(err).message);
      setSaving(false);
    }
  };

  return (
    <div className="CommentItem__editor">
      <TextArea
        ref={ref}
        value={draft}
        rows={2}
        aria-label={t("comments.edit.label")}
        aria-invalid={tooLong || undefined}
        className="CommentsField"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (isComposingEnter(event)) {
            return;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          }
        }}
      />
      {count > COMMENT_COUNTER_FROM && (
        <span
          className={clsx("CommentsCounter", {
            "CommentsCounter--over": tooLong,
          })}
        >
          {t("comments.composer.counter", { count })}
        </span>
      )}
      {error && (
        <p className="CommentItem__error" role="alert">
          {error}
        </p>
      )}
      <div className="CommentItem__editorActions">
        <UiButton
          size="sm"
          variant="ghost"
          onClick={onCancel}
          disabled={saving}
        >
          {t("comments.edit.cancel")}
        </UiButton>
        <UiButton
          size="sm"
          variant="primary"
          onClick={() => void save()}
          loading={saving}
          disabled={!draft.trim() || tooLong}
        >
          {t("comments.edit.save")}
        </UiButton>
      </div>
    </div>
  );
};

type CommentMessageProps = {
  comment: SceneComment;
  quote: QuoteSummary | null;
  viewer: Viewer;
  format: CommentFormat;
  highlighted: boolean;
  unread: boolean;
  editing: boolean;
  onReply: (comment: SceneComment) => void;
  onEdit: (comment: SceneComment) => void;
  onSaveEdit: (comment: SceneComment, body: string) => Promise<void>;
  onCancelEdit: (comment: SceneComment) => void;
  onSetStatus: (comment: SceneComment) => void;
  onDelete: (comment: SceneComment) => void;
  onJump: (id: string) => void;
};

export const CommentMessage = memo(
  ({
    comment,
    quote,
    viewer,
    format,
    highlighted,
    unread,
    editing,
    onReply,
    onEdit,
    onSaveEdit,
    onCancelEdit,
    onSetStatus,
    onDelete,
    onJump,
  }: CommentMessageProps) => {
    const name = getDisplayName(comment);
    const deleted = comment.deletedAt !== null;
    const own = isAuthor(comment, viewer);
    const clock = (ms: number) =>
      formatClock(ms, format.timeZone, format.locale);

    const items: ActionMenuItem[] = [];
    if (canReply(comment)) {
      items.push({
        label: t("comments.actions.reply"),
        icon: replyIcon,
        onSelect: () => onReply(comment),
      });
    }
    if (canEdit(comment, viewer)) {
      items.push({
        label: t("comments.actions.edit"),
        icon: pencilIcon,
        onSelect: () => onEdit(comment),
      });
    }
    if (canChangeStatus(comment, viewer)) {
      items.push({
        label:
          comment.status === "resolved"
            ? t("comments.actions.reopen")
            : t("comments.actions.resolve"),
        icon: resolvedIcon,
        onSelect: () => onSetStatus(comment),
      });
    }
    if (canDelete(comment, viewer)) {
      items.push({
        label: t("comments.actions.delete"),
        icon: TrashIcon,
        danger: true,
        onSelect: () => onDelete(comment),
      });
    }

    let body: React.ReactNode;
    if (editing && !deleted) {
      body = (
        <InlineEditor
          comment={comment}
          onSave={(next) => onSaveEdit(comment, next)}
          onCancel={() => onCancelEdit(comment)}
        />
      );
    } else if (comment.originalHidden && comment.body === null) {
      body =
        comment.originalBody !== null ? (
          <>
            <p className="CommentItem__body CommentItem__body--struck">
              {comment.originalBody}
            </p>
            <Badge tone="warning" className="CommentItem__privateMark">
              {t("comments.hiddenVisibleTo")}
            </Badge>
          </>
        ) : (
          <p className="CommentItem__body CommentItem__body--placeholder">
            {t("comments.hiddenPlaceholder")}
          </p>
        );
    } else {
      body = (
        <p
          className={clsx("CommentItem__body", {
            "CommentItem__body--struck": deleted,
          })}
        >
          {comment.body}
        </p>
      );
    }

    return (
      <article
        className={clsx("CommentItem", {
          "CommentItem--own": own,
          "CommentItem--deleted": deleted,
          "CommentItem--highlighted": highlighted,
          "CommentItem--unread": unread,
        })}
        data-comment-id={comment.id}
        tabIndex={-1}
        aria-label={t("comments.articleLabel", {
          name,
          time: formatFullTime(
            comment.createdAt,
            format.timeZone,
            format.locale,
          ),
        })}
      >
        <span className="CommentItem__avatar">
          <AudioAvatar
            avatar={comment.authorAvatar ?? getDefaultAudioAvatar(name)}
            size={AVATAR_SIZE}
            theme={format.theme}
          />
        </span>
        <div className="CommentItem__main">
          <div className="CommentItem__header">
            <span className="CommentItem__author">{name}</span>
            {comment.isOwnerAuthor && (
              <Badge tone="info" className="CommentItem__badge">
                {t("comments.owner")}
              </Badge>
            )}
            <CommentTime ms={comment.createdAt} format={format} />
            {comment.status === "resolved" && !deleted && (
              <Badge tone="success" className="CommentItem__badge">
                {t("comments.resolved")}
              </Badge>
            )}
            {items.length > 0 && !editing && (
              <ActionMenu
                items={items}
                label={t("comments.actions.label")}
                className="CommentItem__menu"
              />
            )}
          </div>
          {quote && (
            <button
              type="button"
              className="CommentQuote"
              onClick={() => onJump(quote.id)}
            >
              <span className="CommentQuote__meta">
                {t("comments.quoteLabel", {
                  name: quote.authorName.trim() || t("comments.unnamed"),
                  time: clock(quote.createdAt),
                })}
              </span>
              <span
                className={clsx("CommentQuote__text", {
                  "CommentQuote__text--deleted": quote.excerpt === null,
                })}
              >
                {quote.excerpt ?? t("comments.quoteDeleted")}
              </span>
            </button>
          )}
          {body}
          {deleted && comment.deletedAt !== null && (
            <div className="CommentReason">
              <span className="CommentReason__meta">
                {t(
                  comment.deletedRole === "owner"
                    ? "comments.deletedByOwner"
                    : "comments.deletedByAuthor",
                  { time: clock(comment.deletedAt) },
                )}
              </span>
              {comment.deleteReason && (
                <span className="CommentReason__text">
                  {comment.deleteReason}
                </span>
              )}
            </div>
          )}
          {unread && (
            <p className="CommentItem__unreadNote">
              {t("comments.deletedHighlight")}
            </p>
          )}
          {comment.editedAt !== null && !deleted && !editing && (
            <span className="CommentItem__edited">
              {t("comments.edited", { time: clock(comment.editedAt) })}
            </span>
          )}
        </div>
      </article>
    );
  },
);
CommentMessage.displayName = "CommentMessage";

export const CommentEvent = memo(
  ({
    comment,
    format,
    onJump,
  }: {
    comment: SceneComment;
    format: CommentFormat;
    onJump: (id: string) => void;
  }) => {
    const label = t(
      comment.eventType === "reopened"
        ? "comments.eventReopened"
        : "comments.eventResolved",
      {
        name: getDisplayName(comment),
        time: formatClock(comment.createdAt, format.timeZone, format.locale),
      },
    );
    return (
      <article
        className="CommentEvent"
        data-comment-id={comment.id}
        tabIndex={-1}
        aria-label={label}
      >
        {comment.targetId ? (
          <button
            type="button"
            className="CommentEvent__button"
            title={t("comments.eventJump")}
            onClick={() => onJump(comment.targetId!)}
          >
            {label}
          </button>
        ) : (
          <span className="CommentEvent__button">{label}</span>
        )}
      </article>
    );
  },
);
CommentEvent.displayName = "CommentEvent";

export const PendingItem = ({
  pending,
  onRetry,
  onDiscard,
}: {
  pending: PendingComment;
  onRetry: (tempId: string) => void;
  onDiscard: (tempId: string) => void;
}) => (
  <article
    className={clsx("CommentItem", "CommentItem--pending", {
      "CommentItem--failed": pending.status === "failed",
    })}
    aria-busy={pending.status === "sending"}
  >
    <span className="CommentItem__avatar" aria-hidden="true" />
    <div className="CommentItem__main">
      <p className="CommentItem__body">{pending.body}</p>
      {pending.status === "sending" ? (
        <span className="CommentItem__edited">
          {t("comments.composer.sending")}
        </span>
      ) : (
        <div className="CommentItem__failed" role="alert">
          <span>
            {t("comments.composer.failed", { error: pending.error ?? "" })}
          </span>
          <span className="CommentItem__failedActions">
            <UiButton size="sm" onClick={() => onRetry(pending.tempId)}>
              {t("comments.retry")}
            </UiButton>
            <UiButton
              size="sm"
              variant="ghost"
              onClick={() => onDiscard(pending.tempId)}
            >
              {t("comments.composer.discard")}
            </UiButton>
          </span>
        </div>
      )}
    </div>
  </article>
);
