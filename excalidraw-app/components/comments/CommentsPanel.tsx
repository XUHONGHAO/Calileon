import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import Spinner from "@excalidraw/excalidraw/components/Spinner";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import { t, useI18n } from "@excalidraw/excalidraw/i18n";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  hasLoadedReplies,
  isLiveMessage,
  predictDeleteDialog,
} from "../../comments/deletePolicy";
import {
  buildFeed,
  countMessages,
  getDayLabel,
  getViewerTimeZone,
  toIntlLocale,
} from "../../comments/feed";
import {
  useCommentsPanelOpen,
  useCommentsState,
} from "../../comments/useSceneComments";
import { Callout, UiButton } from "../ui";

import { CommentEvent, CommentMessage, PendingItem } from "./CommentItem";
import { Composer } from "./Composer";
import { DeleteCommentDialog } from "./DeleteCommentDialog";
import { arrowDownIcon } from "./icons";

import "./CommentsPanel.scss";

import type { CommentFormat } from "./CommentItem";
import type { CommentAvailability } from "../../comments/availability";
import type {
  CommentsController,
  CommentsState,
} from "../../comments/commentsController";
import type { DeleteDialogKind, Viewer } from "../../comments/deletePolicy";
import type { SceneComment } from "../../data/cloud/types";

/** within this many px of the bottom, new comments scroll into view */
const NEAR_BOTTOM_PX = 80;
const HIGHLIGHT_MS = 1500;
/** how many older pages a jump to a quoted comment may load */
const MAX_JUMP_PAGES = 10;
/** a reconnect blip shorter than this shows no polling notice */
const POLLING_NOTICE_DELAY_MS = 3000;

export type CommentsPanelProps = {
  availability: CommentAvailability;
  controller: CommentsController | null;
  viewerId: string | null;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  onRetry: () => void;
  onSignIn: () => void;
  onSaveToCloud: () => void;
};

export const CommentsPanel = ({
  availability,
  controller,
  viewerId,
  excalidrawAPI,
  onRetry,
  onSignIn,
  onSaveToCloud,
}: CommentsPanelProps) => {
  useCommentsPanelOpen(controller);

  if (availability.kind !== "ready") {
    return (
      <div className="CommentsPanel">
        <CommentsPlaceholder
          availability={availability}
          onSignIn={onSignIn}
          onSaveToCloud={onSaveToCloud}
        />
      </div>
    );
  }
  if (!controller || !viewerId) {
    return (
      <div className="CommentsPanel">
        <CommentsLoading />
      </div>
    );
  }
  return (
    <CommentsFeed
      controller={controller}
      viewerId={viewerId}
      excalidrawAPI={excalidrawAPI}
      onRetry={onRetry}
    />
  );
};

const CommentsLoading = () => (
  <div className="CommentsPanel__placeholder" role="status">
    <Spinner />
    <p>{t("comments.loading")}</p>
  </div>
);

const PLACEHOLDER_TEXT = {
  local: "comments.placeholder.local",
  room: "comments.placeholder.room",
  vault: "comments.placeholder.vault",
  embed: "comments.placeholder.embed",
  "single-file": "comments.placeholder.singleFile",
  encrypted: "comments.placeholder.encrypted",
} as const;

const CommentsPlaceholder = ({
  availability,
  onSignIn,
  onSaveToCloud,
}: {
  availability: Exclude<CommentAvailability, { kind: "ready" }>;
  onSignIn: () => void;
  onSaveToCloud: () => void;
}) => {
  let text: string;
  let action: React.ReactNode = null;
  if (availability.kind === "unsupported-deployment") {
    text = t("comments.placeholder.deployment");
  } else if (availability.kind === "signed-out") {
    text = t("comments.placeholder.signedOut");
    action = (
      <UiButton variant="primary" onClick={onSignIn}>
        {t("comments.placeholder.signIn")}
      </UiButton>
    );
  } else {
    text = t(PLACEHOLDER_TEXT[availability.reason]);
    if (availability.reason === "local") {
      action = (
        <UiButton variant="primary" onClick={onSaveToCloud}>
          {t("comments.placeholder.saveToCloud")}
        </UiButton>
      );
    }
  }
  return (
    <div className="CommentsPanel__placeholder">
      <p>{text}</p>
      {action}
    </div>
  );
};
const CommentsFeed = ({
  controller,
  viewerId,
  excalidrawAPI,
  onRetry,
}: {
  controller: CommentsController;
  viewerId: string;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  onRetry: () => void;
}) => {
  const state = useCommentsState(controller);
  if (!state || state.phase === "joining") {
    return (
      <div className="CommentsPanel">
        <CommentsLoading />
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <div className="CommentsPanel">
        <div className="CommentsPanel__placeholder">
          <Callout
            tone="danger"
            action={
              <UiButton size="sm" onClick={onRetry}>
                {t("comments.retry")}
              </UiButton>
            }
          >
            {state.error?.message ?? t("comments.errors.network")}
          </Callout>
        </div>
      </div>
    );
  }
  return (
    <CommentsReady
      state={state}
      controller={controller}
      viewerId={viewerId}
      excalidrawAPI={excalidrawAPI}
    />
  );
};

/** True once `value` has stayed true for `delay` ms. */
const useDelayedFlag = (value: boolean, delay: number) => {
  const [flag, setFlag] = useState(false);
  useEffect(() => {
    if (!value) {
      setFlag(false);
      return;
    }
    const timer = window.setTimeout(() => setFlag(true), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return flag;
};

const findCommentNode = (
  container: HTMLElement | null,
  id: string,
): HTMLElement | null => {
  if (!container) {
    return null;
  }
  // compare dataset values instead of building a selector from the id
  return (
    Array.from(
      container.querySelectorAll<HTMLElement>("[data-comment-id]"),
    ).find((node) => node.dataset.commentId === id) ?? null
  );
};

const prefersReducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const DaySeparator = ({
  day,
  format,
}: {
  day: string;
  format: CommentFormat;
}) => {
  const label = getDayLabel(day, Date.now(), format.timeZone, format.locale);
  const text =
    label.kind === "today"
      ? t("comments.today")
      : label.kind === "yesterday"
      ? t("comments.yesterday")
      : label.text;
  return (
    <div className="CommentsDay" role="separator" aria-label={text}>
      <span aria-hidden="true">{text}</span>
    </div>
  );
};
type DeleteRequest = { comment: SceneComment; kind: DeleteDialogKind };

const CommentsReady = ({
  state,
  controller,
  viewerId,
  excalidrawAPI,
}: {
  state: CommentsState;
  controller: CommentsController;
  viewerId: string;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
}) => {
  const { langCode } = useI18n();
  const { theme } = useUIAppState();
  const locale = useMemo(() => toIntlLocale(langCode), [langCode]);
  const timeZone = useMemo(getViewerTimeZone, []);
  const format = useMemo<CommentFormat>(
    () => ({ locale, timeZone, theme }),
    [locale, timeZone, theme],
  );
  const viewer = useMemo<Viewer>(
    () => ({ id: viewerId, role: state.role ?? "participant" }),
    [viewerId, state.role],
  );
  const { comments } = state;
  const feed = useMemo(
    () => buildFeed(comments, timeZone),
    [comments, timeZone],
  );
  const messageCount = useMemo(() => countMessages(comments), [comments]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<DeleteRequest | null>(
    null,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [jumpTarget, setJumpTarget] = useState<string | null>(null);
  const [unseen, setUnseen] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const highlightTimer = useRef<number | null>(null);
  const jumpingRef = useRef(false);

  // a reply target that was deleted meanwhile can't be quoted any more
  const replyCandidate = replyToId ? comments.get(replyToId) : undefined;
  const replyTo =
    replyCandidate && isLiveMessage(replyCandidate) ? replyCandidate : null;

  useEffect(
    () => () => {
      if (highlightTimer.current !== null) {
        window.clearTimeout(highlightTimer.current);
      }
    },
    [],
  );

  const focusComment = useCallback((id: string) => {
    requestAnimationFrame(() => {
      findCommentNode(scrollRef.current, id)?.focus({ preventScroll: true });
    });
  }, []);

  const showError = useCallback((error: unknown) => {
    setActionError(
      error instanceof Error ? error.message : t("comments.errors.network"),
    );
  }, []);

  const onReply = useCallback((comment: SceneComment) => {
    setReplyToId(comment.id);
    setEditingId(null);
    requestAnimationFrame(() => composerRef.current?.focus());
  }, []);

  const onEdit = useCallback((comment: SceneComment) => {
    setEditingId(comment.id);
  }, []);

  const onSaveEdit = useCallback(
    async (comment: SceneComment, body: string) => {
      // throws into the inline editor, which shows the error
      await controller.edit(comment.id, body);
      setEditingId(null);
      focusComment(comment.id);
    },
    [controller, focusComment],
  );

  const onCancelEdit = useCallback(
    (comment: SceneComment) => {
      setEditingId(null);
      focusComment(comment.id);
    },
    [focusComment],
  );

  const onSetStatus = useCallback(
    (comment: SceneComment) => {
      setActionError(null);
      controller
        .setStatus(
          comment.id,
          comment.status === "resolved" ? "open" : "resolved",
        )
        .catch(showError);
    },
    [controller, showError],
  );

  const onDelete = useCallback(
    (comment: SceneComment) => {
      const current = controller.getState();
      const kind = predictDeleteDialog({
        comment,
        viewer,
        hasReplies: hasLoadedReplies(current.comments.values(), comment.id),
        serverNow: controller.serverNow(),
      });
      if (kind) {
        setActionError(null);
        setDeleteRequest({ comment, kind });
      }
    },
    [controller, viewer],
  );

  const reveal = useCallback((id: string) => {
    const node = findCommentNode(scrollRef.current, id);
    if (!node) {
      return false;
    }
    node.scrollIntoView?.({
      block: "center",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    node.focus({ preventScroll: true });
    setHighlightId(id);
    if (highlightTimer.current !== null) {
      window.clearTimeout(highlightTimer.current);
    }
    highlightTimer.current = window.setTimeout(() => {
      highlightTimer.current = null;
      setHighlightId(null);
    }, HIGHLIGHT_MS);
    return true;
  }, []);

  const onJump = useCallback(
    async (id: string) => {
      if (reveal(id) || jumpingRef.current) {
        return;
      }
      // the original is older than the loaded pages: page back to it
      jumpingRef.current = true;
      try {
        for (let page = 0; page < MAX_JUMP_PAGES; page++) {
          const current = controller.getState();
          if (current.comments.has(id) || !current.hasOlder) {
            break;
          }
          await controller.loadOlder();
        }
      } catch (error) {
        showError(error);
      } finally {
        jumpingRef.current = false;
      }
      if (controller.getState().comments.has(id)) {
        setJumpTarget(id);
      }
    },
    [controller, reveal, showError],
  );

  const onLoadOlder = useCallback(() => {
    setActionError(null);
    controller.loadOlder().catch(showError);
  }, [controller, showError]);
  // —— scrolling: oldest on top, like a chat (§11.2) ——
  const nearBottomRef = useRef(true);
  const forceBottomRef = useRef(true);
  const prevHeightRef = useRef(0);
  const prevFirstKeyRef = useRef<string | null>(null);
  const prevPendingRef = useRef(0);
  const knownIdsRef = useRef<Set<string> | null>(null);
  const newestRef = useRef(0);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const near =
      el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    nearBottomRef.current = near;
    if (near) {
      setUnseen(0);
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
    nearBottomRef.current = true;
    setUnseen(0);
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const firstKey = feed.find((item) => item.type !== "day")?.key ?? null;
    let fresh: SceneComment[] = [];
    if (knownIdsRef.current) {
      const known = knownIdsRef.current;
      fresh = Array.from(comments.values()).filter(
        (comment) =>
          comment.kind === "message" &&
          !known.has(comment.id) &&
          comment.createdAt > newestRef.current &&
          comment.authorId !== viewerId,
      );
    }
    knownIdsRef.current = new Set(comments.keys());
    for (const comment of comments.values()) {
      newestRef.current = Math.max(newestRef.current, comment.createdAt);
    }

    const prepended =
      prevFirstKeyRef.current !== null &&
      firstKey !== prevFirstKeyRef.current &&
      !nearBottomRef.current;
    const pendingGrew = state.pending.length > prevPendingRef.current;
    if (forceBottomRef.current || pendingGrew) {
      forceBottomRef.current = false;
      scrollToBottom();
    } else if (prepended) {
      // older pages went in above: keep the visible comments in place
      el.scrollTop += el.scrollHeight - prevHeightRef.current;
    } else if (nearBottomRef.current) {
      scrollToBottom();
    } else if (fresh.length) {
      setUnseen((count) => count + fresh.length);
    }
    if (fresh.length) {
      setAnnouncement(
        fresh.length === 1
          ? t("comments.announceOne", {
              name: fresh[0].authorName.trim() || t("comments.unnamed"),
            })
          : t("comments.announceMany", { count: fresh.length }),
      );
    }
    prevHeightRef.current = el.scrollHeight;
    prevFirstKeyRef.current = firstKey;
    prevPendingRef.current = state.pending.length;
  }, [feed, comments, state.pending.length, viewerId, scrollToBottom]);

  // after the page with the jump target has rendered (and been anchored)
  useLayoutEffect(() => {
    if (jumpTarget) {
      reveal(jumpTarget);
      setJumpTarget(null);
    }
  }, [jumpTarget, feed, reveal]);

  const onSend = useCallback(
    (body: string, quotedId: string | null) => {
      setReplyToId(null);
      setActionError(null);
      forceBottomRef.current = true;
      void controller.post(body, quotedId);
    },
    [controller],
  );

  const onRetryPending = useCallback(
    (tempId: string) => void controller.retry(tempId),
    [controller],
  );
  const onDiscardPending = useCallback(
    (tempId: string) => controller.discard(tempId),
    [controller],
  );

  const showPolling = useDelayedFlag(
    state.channel === "unavailable",
    POLLING_NOTICE_DELAY_MS,
  );

  const title =
    messageCount > 0
      ? t("comments.titleCount", {
          count: state.hasOlder ? `${messageCount}+` : messageCount,
        })
      : t("comments.title");
  return (
    <div className="CommentsPanel">
      <div className="CommentsPanel__header">
        <h2 className="CommentsPanel__title">{title}</h2>
      </div>
      {showPolling && (
        <p className="CommentsPanel__notice" role="status">
          {t("comments.polling")}
        </p>
      )}
      <div className="CommentsPanel__body">
        <div
          ref={scrollRef}
          className="CommentsPanel__scroll"
          onScroll={onScroll}
        >
          {state.hasOlder && (
            <div className="CommentsPanel__older">
              <UiButton
                size="sm"
                variant="ghost"
                loading={state.loadingOlder}
                onClick={onLoadOlder}
              >
                {t("comments.loadOlder")}
              </UiButton>
            </div>
          )}
          {feed.length === 0 && state.pending.length === 0 && (
            <p className="CommentsPanel__empty">{t("comments.empty")}</p>
          )}
          <div
            role="feed"
            aria-label={t("comments.feedLabel")}
            aria-busy={state.loadingOlder}
            className="CommentsPanel__feed"
          >
            {feed.map((item) =>
              item.type === "day" ? (
                <DaySeparator key={item.key} day={item.day} format={format} />
              ) : item.type === "event" ? (
                <CommentEvent
                  key={item.key}
                  comment={item.comment}
                  format={format}
                  onJump={onJump}
                />
              ) : (
                <CommentMessage
                  key={item.key}
                  comment={item.comment}
                  quote={item.quote}
                  viewer={viewer}
                  format={format}
                  highlighted={highlightId === item.comment.id}
                  unread={state.unreadIds.has(item.comment.id)}
                  editing={editingId === item.comment.id}
                  onReply={onReply}
                  onEdit={onEdit}
                  onSaveEdit={onSaveEdit}
                  onCancelEdit={onCancelEdit}
                  onSetStatus={onSetStatus}
                  onDelete={onDelete}
                  onJump={onJump}
                />
              ),
            )}
            {state.pending.map((pending) => (
              <PendingItem
                key={pending.tempId}
                pending={pending}
                onRetry={onRetryPending}
                onDiscard={onDiscardPending}
              />
            ))}
          </div>
        </div>
        {unseen > 0 && (
          <UiButton
            size="sm"
            icon={arrowDownIcon}
            className="CommentsPanel__newButton"
            onClick={scrollToBottom}
          >
            {unseen === 1
              ? t("comments.newComment")
              : t("comments.newComments", { count: unseen })}
          </UiButton>
        )}
      </div>
      <span className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </span>
      {actionError && (
        <Callout
          tone="danger"
          className="CommentsPanel__error"
          action={
            <UiButton
              size="sm"
              variant="ghost"
              onClick={() => setActionError(null)}
            >
              {t("buttons.close")}
            </UiButton>
          }
        >
          {actionError}
        </Callout>
      )}
      <Composer
        ref={composerRef}
        replyTo={replyTo}
        disabled={false}
        onCancelReply={() => setReplyToId(null)}
        onSend={onSend}
      />
      {deleteRequest && (
        <DeleteCommentDialog
          kind={deleteRequest.kind}
          onClose={() => setDeleteRequest(null)}
          onConfirm={async (opts) => {
            await controller.remove(deleteRequest.comment.id, opts);
          }}
        />
      )}
    </div>
  );
};
