/**
 * One scene's comments for one signed-in viewer (technical design §8, §9.2):
 * join → latest page → Realtime signals, with polling while the channel is not
 * live, full reloads on reconnect and when the page comes back, optimistic
 * posting, and the "your comment was deleted" marker (C9).
 *
 * Framework-free so it can be tested with fake timers; React subscribes
 * through `subscribe` / `getState` (useSyncExternalStore).
 */

import { t } from "@excalidraw/excalidraw/i18n";

import { BackendError } from "../data/cloud/errors";

import { getUnreadDeletedIds } from "./deletePolicy";
import { mergeComments, removeComment, replaceLatestPage } from "./feed";

import type {
  SceneComment,
  SceneCommentChannelStatus,
  SceneCommentDeleteOutcome,
  SceneCommentPage,
  SceneCommentRole,
  SceneCommentService,
  SceneCommentSignal,
  SceneCommentStatus,
} from "../data/cloud/types";

export const POLL_INTERVAL_MS = 20_000;
/** every Nth poll is a full reload, so quiet retractions disappear too */
export const FULL_RELOAD_EVERY = 5;
/** incremental pulls reach back this far: a slow writer may commit late */
export const CHANGE_OVERLAP_MS = 30_000;
export const SIGNAL_DEBOUNCE_MS = 150;
/** ids removed this recently are ignored if a stale response returns them */
const TOMBSTONE_MS = 120_000;
const RELOAD_THROTTLE_MS = 2_000;
const MAX_CHANGE_PAGES = 10;

export type PendingComment = {
  tempId: string;
  body: string;
  quotedId: string | null;
  status: "sending" | "failed";
  error: string | null;
  createdAt: number;
};

export type CommentsState = {
  phase: "joining" | "ready" | "error";
  error: BackendError | null;
  role: SceneCommentRole | null;
  comments: ReadonlyMap<string, SceneComment>;
  pending: readonly PendingComment[];
  hasOlder: boolean;
  loadingOlder: boolean;
  channel: SceneCommentChannelStatus;
  panelOpen: boolean;
  /** server time the viewer last opened the comments tab */
  lastSeenAt: number;
  /** server-side count of unread deletions, includes rows not loaded */
  unreadDeleted: number;
  /** highlighted while the panel is open: deleted since the last visit */
  unreadIds: ReadonlySet<string>;
  /** tab badge: one of the viewer's messages was deleted by someone else */
  badge: boolean;
};

export type CommentsControllerOptions = {
  service: SceneCommentService;
  sceneId: string;
  shareToken: string | null;
  viewerId: string;
};

const INITIAL_STATE: CommentsState = {
  phase: "joining",
  error: null,
  role: null,
  comments: new Map(),
  pending: [],
  hasOlder: false,
  loadingOlder: false,
  channel: "connecting",
  panelOpen: false,
  lastSeenAt: 0,
  unreadDeleted: 0,
  unreadIds: new Set(),
  badge: false,
};

export const toBackendError = (error: unknown): BackendError =>
  error instanceof BackendError
    ? error
    : new BackendError("network", t("comments.errors.network"), {
        recoverable: true,
      });

const isAccessError = (error: BackendError) =>
  error.code === "forbidden" ||
  error.code === "unauthorized" ||
  error.code === "not-configured";

let tempSeq = 0;

export class CommentsController {
  private state: CommentsState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly options: CommentsControllerOptions;
  private disposed = false;
  private started = false;
  /** server time to pull changes from */
  private cursor = 0;
  /** server time minus local time, from the last response */
  private clockSkew = 0;
  private inflight: Promise<void> | null = null;
  private queued: "changes" | "full" | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollCount = 0;
  private signalTimer: ReturnType<typeof setTimeout> | null = null;
  private lastReloadAt = 0;
  private everLive = false;
  private olderPagesLoaded = false;
  private markingSeen = false;
  private readonly tombstones = new Map<string, number>();
  private unsubscribe: (() => void) | null = null;

  constructor(options: CommentsControllerOptions) {
    this.options = options;
  }

  // —— store ——

  getState = (): CommentsState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setState(patch: Partial<CommentsState>) {
    if (this.disposed) {
      return;
    }
    const next = { ...this.state, ...patch };
    const unseen =
      next.phase === "ready" &&
      getUnreadDeletedIds(
        next.comments.values(),
        this.options.viewerId,
        next.lastSeenAt,
      ).length > 0;
    next.badge =
      next.phase === "ready" &&
      !next.panelOpen &&
      (next.unreadDeleted > 0 || unseen);
    this.state = next;
    if (unseen && next.panelOpen && !this.markingSeen) {
      // deleted while the viewer is looking at it: that counts as seen
      void this.markSeen();
    }
    this.listeners.forEach((listener) => listener());
  }

  /** Local time on the server's clock (for the one-hour prediction). */
  serverNow = (): number => Date.now() + this.clockSkew;

  private noteServerTime(serverTime: number) {
    this.clockSkew = serverTime - Date.now();
  }

  // —— lifecycle ——

  async start(): Promise<void> {
    if (this.started || this.disposed) {
      return;
    }
    this.started = true;
    const { service, sceneId, shareToken } = this.options;
    try {
      const joined = await service.join(sceneId, shareToken);
      this.noteServerTime(joined.serverTime);
      const page = await service.list(sceneId);
      if (this.disposed) {
        return;
      }
      this.noteServerTime(page.serverTime);
      this.cursor = page.serverTime - CHANGE_OVERLAP_MS;
      this.lastReloadAt = Date.now();
      // an open panel is handled by openedPanel below, which first takes the
      // highlight snapshot; don't mark anything seen before that
      this.markingSeen = true;
      this.setState({
        phase: "ready",
        error: null,
        role: joined.role,
        lastSeenAt: joined.lastSeenAt,
        unreadDeleted: joined.unreadDeleted,
        comments: mergeComments(new Map(), page.comments),
        hasOlder: page.hasMore,
      });
      this.markingSeen = false;
    } catch (error) {
      this.markingSeen = false;
      this.setState({ phase: "error", error: toBackendError(error) });
      return;
    }

    if (this.state.panelOpen) {
      this.openedPanel();
    }
    this.unsubscribe = service.subscribe(sceneId, {
      onSignal: this.onSignal,
      onStatus: this.onChannelStatus,
    });
    if (this.state.channel !== "live") {
      this.startPolling();
    }
    document.addEventListener("visibilitychange", this.onPageBack);
    window.addEventListener("focus", this.onPageBack);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stopPolling();
    if (this.signalTimer) {
      clearTimeout(this.signalTimer);
      this.signalTimer = null;
    }
    document.removeEventListener("visibilitychange", this.onPageBack);
    window.removeEventListener("focus", this.onPageBack);
    this.listeners.clear();
  }

  // —— sync ——

  private onSignal = (signal: SceneCommentSignal) => {
    if (signal.kind === "removed") {
      // DELETE signals are not scoped to this scene; unknown ids are noise
      if (this.state.comments.has(signal.id)) {
        this.tombstones.set(signal.id, Date.now());
        this.setState({
          comments: removeComment(this.state.comments, signal.id),
        });
      }
      return;
    }
    if (this.signalTimer) {
      clearTimeout(this.signalTimer);
    }
    this.signalTimer = setTimeout(() => {
      this.signalTimer = null;
      void this.pull("changes");
    }, SIGNAL_DEBOUNCE_MS);
  };

  private onChannelStatus = (status: SceneCommentChannelStatus) => {
    const previous = this.state.channel;
    if (status === previous) {
      return;
    }
    this.setState({ channel: status });
    if (status === "live") {
      this.stopPolling();
      if (this.everLive) {
        // back after a drop: deletions made meanwhile only show up in a
        // full reload, because changes cannot return rows that are gone
        void this.pull("full");
      }
      this.everLive = true;
    } else {
      this.startPolling();
    }
  };

  private startPolling() {
    if (this.pollTimer || this.disposed || this.state.phase !== "ready") {
      return;
    }
    this.pollCount = 0;
    this.pollTimer = setInterval(() => {
      if (document.visibilityState === "hidden") {
        return;
      }
      this.pollCount++;
      void this.pull(
        this.pollCount % FULL_RELOAD_EVERY === 0 ? "full" : "changes",
      );
    }, POLL_INTERVAL_MS);
  }

  private stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private onPageBack = () => {
    if (
      document.visibilityState === "hidden" ||
      this.state.phase !== "ready" ||
      Date.now() - this.lastReloadAt < RELOAD_THROTTLE_MS
    ) {
      return;
    }
    this.lastReloadAt = Date.now();
    void this.pull("full");
  };

  /** Pulls are serialized; overlapping requests collapse into one more. */
  pull(mode: "changes" | "full"): Promise<void> {
    if (this.disposed || this.state.phase !== "ready") {
      return Promise.resolve();
    }
    if (this.inflight) {
      this.queued = this.queued === "full" || mode === "full" ? "full" : mode;
      return this.inflight;
    }
    const run = async () => {
      try {
        if (mode === "full") {
          await this.reload();
        } else {
          await this.pullChanges();
        }
      } catch (error) {
        this.onBackgroundError(error);
      }
    };
    this.inflight = run().finally(() => {
      this.inflight = null;
      const next = this.queued;
      this.queued = null;
      if (next) {
        void this.pull(next);
      }
    });
    return this.inflight;
  }

  private withoutTombstones(page: SceneCommentPage): SceneComment[] {
    const now = Date.now();
    for (const [id, at] of this.tombstones) {
      if (now - at > TOMBSTONE_MS) {
        this.tombstones.delete(id);
      }
    }
    return page.comments.filter((row) => !this.tombstones.has(row.id));
  }

  private async reload() {
    const page = await this.options.service.list(this.options.sceneId);
    if (this.disposed) {
      return;
    }
    this.noteServerTime(page.serverTime);
    this.cursor = page.serverTime - CHANGE_OVERLAP_MS;
    this.lastReloadAt = Date.now();
    this.setState({
      comments: replaceLatestPage(
        this.state.comments,
        this.withoutTombstones(page),
        page.hasMore,
        page.serverTime,
      ),
      // once older pages are loaded, their own flag says what is left
      hasOlder: this.olderPagesLoaded ? this.state.hasOlder : page.hasMore,
    });
  }

  private async pullChanges() {
    let since = this.cursor;
    for (let i = 0; i < MAX_CHANGE_PAGES; i++) {
      const page = await this.options.service.listChanges(
        this.options.sceneId,
        since,
      );
      if (this.disposed) {
        return;
      }
      this.noteServerTime(page.serverTime);
      this.setState({
        comments: mergeComments(
          this.state.comments,
          this.withoutTombstones(page),
        ),
      });
      if (!page.hasMore || !page.comments.length) {
        this.cursor = page.serverTime - CHANGE_OVERLAP_MS;
        return;
      }
      // rows written in one transaction share a timestamp; step back 1 ms
      // so a page boundary between them cannot skip one
      since = page.comments[page.comments.length - 1].updatedAt - 1;
    }
  }

  private onBackgroundError(error: unknown) {
    const backendError = toBackendError(error);
    if (isAccessError(backendError)) {
      // e.g. the share link was revoked while the board was open
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.stopPolling();
      this.setState({ phase: "error", error: backendError });
    }
    // anything else: keep the feed, the next signal or poll retries
  }

  // —— actions ——

  /** Sends a message; it shows as "sending" until the server confirms it. */
  async post(body: string, quotedId: string | null = null): Promise<void> {
    const pending: PendingComment = {
      tempId: `pending-${++tempSeq}`,
      body,
      quotedId,
      status: "sending",
      error: null,
      createdAt: this.serverNow(),
    };
    this.setState({ pending: [...this.state.pending, pending] });
    await this.send(pending);
  }

  async retry(tempId: string): Promise<void> {
    const pending = this.state.pending.find((item) => item.tempId === tempId);
    if (!pending || pending.status === "sending") {
      return;
    }
    const next: PendingComment = { ...pending, status: "sending", error: null };
    this.replacePending(tempId, next);
    await this.send(next);
  }

  discard(tempId: string): void {
    this.setState({
      pending: this.state.pending.filter((item) => item.tempId !== tempId),
    });
  }

  private replacePending(tempId: string, next: PendingComment | null) {
    this.setState({
      pending: this.state.pending.flatMap((item) =>
        item.tempId === tempId ? (next ? [next] : []) : [item],
      ),
    });
  }

  private async send(pending: PendingComment) {
    try {
      const saved = await this.options.service.post({
        sceneId: this.options.sceneId,
        body: pending.body,
        quotedId: pending.quotedId,
      });
      this.setState({
        comments: mergeComments(this.state.comments, [saved]),
        pending: this.state.pending.filter(
          (item) => item.tempId !== pending.tempId,
        ),
      });
    } catch (error) {
      const backendError = toBackendError(error);
      this.replacePending(pending.tempId, {
        ...pending,
        status: "failed",
        error: backendError.message,
      });
      this.afterActionError(backendError);
    }
  }

  async edit(id: string, body: string): Promise<void> {
    await this.mutate(() => this.options.service.edit(id, body));
  }

  async setStatus(id: string, status: SceneCommentStatus): Promise<void> {
    await this.mutate(() => this.options.service.setStatus(id, status));
    // the status change also added an event entry to the feed
    void this.pull("changes");
  }

  async remove(
    id: string,
    opts: { reason?: string | null; hideOriginal?: boolean } = {},
  ): Promise<SceneCommentDeleteOutcome> {
    try {
      const outcome = await this.options.service.remove(id, opts);
      if (outcome === "retracted") {
        this.tombstones.set(id, Date.now());
        this.setState({ comments: removeComment(this.state.comments, id) });
      } else {
        void this.pull("changes");
      }
      return outcome;
    } catch (error) {
      const backendError = toBackendError(error);
      this.afterActionError(backendError);
      throw backendError;
    }
  }

  private async mutate(run: () => Promise<SceneComment>) {
    try {
      const saved = await run();
      this.setState({ comments: mergeComments(this.state.comments, [saved]) });
    } catch (error) {
      const backendError = toBackendError(error);
      this.afterActionError(backendError);
      throw backendError;
    }
  }

  private afterActionError(error: BackendError) {
    if (error.code === "conflict") {
      // the row changed or vanished underneath: show what the server has
      void this.pull("full");
    } else if (isAccessError(error)) {
      // confirm through a pull; it switches to the error phase if access
      // is really gone (e.g. the share link was revoked)
      void this.pull("changes");
    }
  }

  async loadOlder(): Promise<void> {
    if (this.state.loadingOlder || !this.state.hasOlder) {
      return;
    }
    let oldest = Infinity;
    for (const comment of this.state.comments.values()) {
      oldest = Math.min(oldest, comment.createdAt);
    }
    if (oldest === Infinity) {
      return;
    }
    this.setState({ loadingOlder: true });
    try {
      // +1 ms: timestamps are microseconds on the server, ms here; the
      // overlap is merged away by id
      const page = await this.options.service.list(this.options.sceneId, {
        before: oldest + 1,
      });
      this.olderPagesLoaded = true;
      this.setState({
        comments: mergeComments(
          this.state.comments,
          this.withoutTombstones(page),
        ),
        hasOlder: page.hasMore,
        loadingOlder: false,
      });
    } catch (error) {
      this.setState({ loadingOlder: false });
      throw toBackendError(error);
    }
  }

  // —— unread marker (C9) ——

  setPanelOpen(open: boolean): void {
    if (open === this.state.panelOpen) {
      return;
    }
    if (!open) {
      this.setState({ panelOpen: false, unreadIds: new Set() });
      return;
    }
    if (this.state.phase === "ready") {
      this.openedPanel();
    } else {
      // start() calls openedPanel once the feed is loaded
      this.setState({ panelOpen: true });
    }
  }

  private openedPanel() {
    // the snapshot keeps the highlight until the panel closes; markSeen is
    // started after the state update so the panel is already marked open
    this.markingSeen = true;
    this.setState({
      panelOpen: true,
      unreadIds: new Set(
        getUnreadDeletedIds(
          this.state.comments.values(),
          this.options.viewerId,
          this.state.lastSeenAt,
        ),
      ),
    });
    this.markingSeen = false;
    void this.markSeen();
  }

  private async markSeen() {
    if (this.markingSeen) {
      return;
    }
    this.markingSeen = true;
    try {
      const seenAt = await this.options.service.markSeen(this.options.sceneId);
      this.markingSeen = false;
      this.setState({
        lastSeenAt: Math.max(seenAt, this.state.lastSeenAt),
        unreadDeleted: 0,
      });
    } catch {
      // the badge just stays until the next visit
      this.markingSeen = false;
    }
  }
}
