/**
 * The comment feed as plain data (technical design §9.2, §11.2): merging
 * server pages, ordering, one separator per natural day in the viewer's time
 * zone, and the quote summary shown on top of a reply.
 */

import type { SceneComment } from "../data/cloud/types";

export type CommentMap = ReadonlyMap<string, SceneComment>;

/** Never let an older copy of a row replace a newer one. */
export const mergeComments = (
  current: CommentMap,
  rows: readonly SceneComment[],
): Map<string, SceneComment> => {
  const next = new Map(current);
  for (const row of rows) {
    const existing = next.get(row.id);
    if (!existing || existing.updatedAt <= row.updatedAt) {
      next.set(row.id, row);
    }
  }
  return next;
};

/**
 * Applies a full reload of the latest page. Rows inside the page's time
 * window that the server no longer returns were retracted and are dropped;
 * older pages the user loaded earlier are kept.
 */
export const replaceLatestPage = (
  current: CommentMap,
  page: readonly SceneComment[],
  pageHasMore: boolean,
  serverTime: number,
): Map<string, SceneComment> => {
  const ids = new Set(page.map((row) => row.id));
  const oldest = page.length
    ? Math.min(...page.map((row) => row.createdAt))
    : -Infinity;
  const coversAll = !pageHasMore;
  const next = new Map<string, SceneComment>();
  for (const [id, row] of current) {
    const inWindow = coversAll || row.createdAt >= oldest;
    // a row that changed after the reload started is newer than the page
    if (!inWindow || ids.has(id) || row.updatedAt > serverTime) {
      next.set(id, row);
    }
  }
  return mergeComments(next, page);
};

/** Removes a retracted message and the events that pointed at it. */
export const removeComment = (
  current: CommentMap,
  id: string,
): Map<string, SceneComment> => {
  const next = new Map(current);
  next.delete(id);
  for (const [key, row] of next) {
    if (row.kind === "event" && row.targetId === id) {
      next.delete(key);
    }
  }
  return next;
};

export const sortComments = (
  comments: Iterable<SceneComment>,
): SceneComment[] =>
  Array.from(comments).sort(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1),
  );

export const getViewerTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

const dayKeyFormatters = new Map<string, Intl.DateTimeFormat>();

/** "2026-10-24" for the calendar day of `ms` in `timeZone`. */
export const getDayKey = (ms: number, timeZone: string): string => {
  let format = dayKeyFormatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayKeyFormatters.set(timeZone, format);
  }
  return format.format(ms);
};

const shiftDayKey = (key: string, days: number): string => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

export type DayLabel =
  | { kind: "today" }
  | { kind: "yesterday" }
  | { kind: "date"; text: string };

export const getDayLabel = (
  dayKey: string,
  now: number,
  timeZone: string,
  locale: string,
): DayLabel => {
  const today = getDayKey(now, timeZone);
  if (dayKey === today) {
    return { kind: "today" };
  }
  if (dayKey === shiftDayKey(today, -1)) {
    return { kind: "yesterday" };
  }
  const [y, m, d] = dayKey.split("-").map(Number);
  // noon UTC of that calendar day, formatted in UTC: the same day everywhere
  const noon = Date.UTC(y, m - 1, d, 12);
  return {
    kind: "date",
    text: new Intl.DateTimeFormat(locale, {
      timeZone: "UTC",
      month: "short",
      day: "numeric",
      weekday: "short",
      ...(dayKey.slice(0, 4) === today.slice(0, 4) ? {} : { year: "numeric" }),
    }).format(noon),
  };
};

/** The editor's language code as an Intl locale, "en" if Intl lacks it. */
export const toIntlLocale = (langCode: string): string => {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([langCode]).length
      ? langCode
      : "en";
  } catch {
    return "en";
  }
};

// a feed renders a few hundred timestamps; building a formatter is the
// expensive part
const timeFormatters = new Map<string, Intl.DateTimeFormat>();

const getTimeFormatter = (
  kind: "clock" | "full",
  timeZone: string,
  locale: string,
) => {
  const key = `${kind}|${timeZone}|${locale}`;
  let format = timeFormatters.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(
      locale,
      kind === "clock"
        ? { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
        : { timeZone, dateStyle: "medium", timeStyle: "long" },
    );
    timeFormatters.set(key, format);
  }
  return format;
};

export const formatClock = (ms: number, timeZone: string, locale: string) =>
  getTimeFormatter("clock", timeZone, locale).format(ms);

export const formatFullTime = (ms: number, timeZone: string, locale: string) =>
  getTimeFormatter("full", timeZone, locale).format(ms);

export const QUOTE_EXCERPT_LENGTH = 60;

export const toExcerpt = (body: string): string => {
  const flat = body.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > QUOTE_EXCERPT_LENGTH
    ? `${chars.slice(0, QUOTE_EXCERPT_LENGTH).join("")}…`
    : flat;
};

export type QuoteSummary = {
  id: string;
  authorName: string;
  createdAt: number;
  /** null: the quoted message is deleted or hidden, show "deleted" */
  excerpt: string | null;
};

/** Prefers the loaded original (fresher) over the server's summary. */
export const getQuoteSummary = (
  reply: SceneComment,
  comments: CommentMap,
): QuoteSummary | null => {
  if (!reply.quotedId) {
    return null;
  }
  const original = comments.get(reply.quotedId);
  if (original) {
    return {
      id: original.id,
      authorName: original.authorName,
      createdAt: original.createdAt,
      excerpt:
        original.deletedAt || original.originalHidden || !original.body
          ? null
          : toExcerpt(original.body),
    };
  }
  if (!reply.quoted) {
    return null;
  }
  return {
    id: reply.quotedId,
    authorName: reply.quoted.authorName,
    createdAt: reply.quoted.createdAt,
    excerpt:
      reply.quoted.deleted || reply.quoted.excerpt === null
        ? null
        : toExcerpt(reply.quoted.excerpt),
  };
};

export type FeedItem =
  | { type: "day"; key: string; day: string }
  | {
      type: "message";
      key: string;
      comment: SceneComment;
      quote: QuoteSummary | null;
    }
  | { type: "event"; key: string; comment: SceneComment };

export const buildFeed = (
  comments: CommentMap,
  timeZone: string,
): FeedItem[] => {
  const items: FeedItem[] = [];
  let lastDay: string | null = null;
  for (const comment of sortComments(comments.values())) {
    const day = getDayKey(comment.createdAt, timeZone);
    if (day !== lastDay) {
      items.push({ type: "day", key: `day:${day}`, day });
      lastDay = day;
    }
    items.push(
      comment.kind === "event"
        ? { type: "event", key: comment.id, comment }
        : {
            type: "message",
            key: comment.id,
            comment,
            quote: getQuoteSummary(comment, comments),
          },
    );
  }
  return items;
};

export const countMessages = (comments: CommentMap): number => {
  let count = 0;
  for (const comment of comments.values()) {
    if (comment.kind === "message" && !comment.deletedAt) {
      count++;
    }
  }
  return count;
};
