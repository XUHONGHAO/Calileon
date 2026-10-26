import { describe, expect, it } from "vitest";

import {
  buildFeed,
  countMessages,
  formatClock,
  getDayKey,
  getDayLabel,
  getQuoteSummary,
  mergeComments,
  removeComment,
  replaceLatestPage,
  sortComments,
  toExcerpt,
  toIntlLocale,
} from "./feed";
import { makeComment, toMap } from "./testFixtures";

const SHANGHAI = "Asia/Shanghai";
const LA = "America/Los_Angeles";

describe("mergeComments", () => {
  it("adds new rows and lets the newer copy win", () => {
    const a = makeComment({ updatedAt: 100, createdAt: 100 });
    const b = makeComment();
    const merged = mergeComments(toMap([a]), [
      { ...a, body: "stale", updatedAt: 50 },
      b,
    ]);
    expect(merged.get(a.id)?.body).toBe(a.body);
    expect(merged.get(b.id)).toBe(b);

    const newer = { ...a, body: "edited", updatedAt: 200 };
    expect(mergeComments(merged, [newer]).get(a.id)?.body).toBe("edited");
  });
});

describe("replaceLatestPage", () => {
  it("drops rows inside the page window that the server no longer has", () => {
    const old = makeComment({ createdAt: 10, updatedAt: 10 });
    const pageStart = makeComment({ createdAt: 20, updatedAt: 20 });
    const gone = makeComment({ createdAt: 30, updatedAt: 30 });
    const kept = makeComment({ createdAt: 40, updatedAt: 40 });
    const next = replaceLatestPage(
      toMap([old, pageStart, gone, kept]),
      [pageStart, kept],
      true,
      1000,
    );
    // `old` is older than the page: loaded earlier, kept
    expect([...next.keys()].sort()).toEqual(
      [old.id, pageStart.id, kept.id].sort(),
    );
  });

  it("covers everything when the page has no more rows", () => {
    const gone = makeComment({ createdAt: 1, updatedAt: 1 });
    expect(replaceLatestPage(toMap([gone]), [], false, 1000).size).toBe(0);
  });

  it("keeps a row that changed after the reload started", () => {
    const late = makeComment({ createdAt: 2000, updatedAt: 2000 });
    expect(replaceLatestPage(toMap([late]), [], false, 1000).has(late.id)).toBe(
      true,
    );
  });
});

describe("removeComment", () => {
  it("removes the message and the events that point at it", () => {
    const message = makeComment();
    const event = makeComment({
      kind: "event",
      eventType: "resolved",
      targetId: message.id,
      body: null,
    });
    const other = makeComment();
    const next = removeComment(toMap([message, event, other]), message.id);
    expect([...next.keys()]).toEqual([other.id]);
  });
});

describe("sortComments", () => {
  it("orders by creation time, then id", () => {
    const b = makeComment({ id: "b", createdAt: 5 });
    const a = makeComment({ id: "a", createdAt: 5 });
    const first = makeComment({ id: "z", createdAt: 1 });
    expect(sortComments([b, a, first]).map((c) => c.id)).toEqual([
      "z",
      "a",
      "b",
    ]);
  });
});

describe("day grouping", () => {
  it("splits at local midnight in Asia/Shanghai", () => {
    // 15:59 and 16:00 UTC are 23:59 and 00:00 the next day in Shanghai
    const before = Date.UTC(2026, 9, 24, 15, 59);
    const after = Date.UTC(2026, 9, 24, 16, 0);
    expect(getDayKey(before, SHANGHAI)).toBe("2026-10-24");
    expect(getDayKey(after, SHANGHAI)).toBe("2026-10-25");
    const feed = buildFeed(
      toMap([
        makeComment({ createdAt: before }),
        makeComment({ createdAt: after }),
      ]),
      SHANGHAI,
    );
    expect(feed.map((item) => item.type)).toEqual([
      "day",
      "message",
      "day",
      "message",
    ]);
  });

  it("keeps the same instants on one day in Los Angeles", () => {
    const feed = buildFeed(
      toMap([
        makeComment({ createdAt: Date.UTC(2026, 9, 24, 15, 59) }),
        makeComment({ createdAt: Date.UTC(2026, 9, 24, 16, 0) }),
      ]),
      LA,
    );
    expect(feed.filter((item) => item.type === "day")).toHaveLength(1);
  });

  it("handles the DST change in Los Angeles", () => {
    // 2026-11-01: clocks go back at 02:00 PDT (09:00 UTC); that day has 25 h
    const start = Date.UTC(2026, 10, 1, 7, 0); // 00:00 PDT
    const end = Date.UTC(2026, 10, 2, 7, 59); // 23:59 PST
    const next = Date.UTC(2026, 10, 2, 8, 0); // 00:00 PST Nov 2
    expect(getDayKey(start, LA)).toBe("2026-11-01");
    expect(getDayKey(end, LA)).toBe("2026-11-01");
    expect(getDayKey(next, LA)).toBe("2026-11-02");
    expect(formatClock(end, LA, "en")).toBe("23:59");
  });

  it("labels today, yesterday and older days", () => {
    const now = Date.UTC(2026, 9, 25, 2, 0); // 10:00 in Shanghai
    expect(getDayLabel("2026-10-25", now, SHANGHAI, "en")).toEqual({
      kind: "today",
    });
    expect(getDayLabel("2026-10-24", now, SHANGHAI, "en")).toEqual({
      kind: "yesterday",
    });
    const older = getDayLabel("2026-10-20", now, SHANGHAI, "en");
    expect(older).toEqual({ kind: "date", text: "Tue, Oct 20" });
    const lastYear = getDayLabel("2025-12-31", now, SHANGHAI, "en");
    expect(lastYear.kind === "date" && lastYear.text).toContain("2025");
  });

  it("falls back to en for a locale Intl does not know", () => {
    expect(toIntlLocale("zh-CN")).toBe("zh-CN");
    expect(toIntlLocale("not a locale")).toBe("en");
  });
});

describe("quote summary", () => {
  it("prefers the loaded original", () => {
    const original = makeComment({ body: "  first\n\nline  " });
    const reply = makeComment({
      quotedId: original.id,
      quoted: {
        authorName: "Old",
        createdAt: 0,
        deleted: false,
        excerpt: "stale",
      },
    });
    expect(getQuoteSummary(reply, toMap([original, reply]))).toEqual({
      id: original.id,
      authorName: original.authorName,
      createdAt: original.createdAt,
      excerpt: "first line",
    });
  });

  it("shows 'deleted' for a deleted or hidden original, never its text", () => {
    const struck = makeComment({ deletedAt: 5, deletedRole: "author" });
    const hidden = makeComment({
      deletedAt: 5,
      deletedRole: "owner",
      originalHidden: true,
      body: null,
      originalBody: "secret",
    });
    for (const original of [struck, hidden]) {
      const reply = makeComment({ quotedId: original.id });
      expect(
        getQuoteSummary(reply, toMap([original, reply]))?.excerpt,
      ).toBeNull();
    }
  });

  it("uses the server summary when the original is not loaded", () => {
    const reply = makeComment({
      quotedId: "missing",
      quoted: {
        authorName: "Bo",
        createdAt: 7,
        deleted: false,
        excerpt: "x".repeat(70),
      },
    });
    const summary = getQuoteSummary(reply, toMap([reply]));
    expect(summary?.authorName).toBe("Bo");
    expect(summary?.excerpt).toBe(`${"x".repeat(60)}…`);
  });

  it("cuts excerpts by characters, not UTF-16 units", () => {
    expect(toExcerpt("😀".repeat(61))).toBe(`${"😀".repeat(60)}…`);
  });
});

describe("countMessages", () => {
  it("counts live messages only", () => {
    expect(
      countMessages(
        toMap([
          makeComment(),
          makeComment({ deletedAt: 1, deletedRole: "author" }),
          makeComment({ kind: "event", eventType: "resolved", body: null }),
        ]),
      ),
    ).toBe(1);
  });
});
