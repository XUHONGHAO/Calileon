import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { exportToSvg, exportToCanvas } from "@excalidraw/utils";

import {
  getExpiredShelfLife,
  getShelfLifeBadge,
  getShelfLifeBadgeForElement,
  getShelfLifeBadgeLayout,
  getShelfLifeData,
  getShelfLifeRoot,
  renderShelfLifeOverlay,
  renderShelfLifeBadge,
  formatShelfLifeBadgeLabel,
  getShelfLifeDeadline,
  getShelfLifeDateDeadline,
  getShelfLifeVisualState,
  normalizeShelfLifeData,
  planShelfLifeCleanup,
  setShelfLifeForSelection,
  SHELF_LIFE_DAY,
  getElementShelfLifeState,
  createShelfLifeScheduler,
} from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

const data = { version: 1 as const, expiresAt: 1000, setAt: 2000 };
const note = (overrides = {}) =>
  API.createElement({
    type: "rectangle",
    width: 100,
    height: 100,
    customData: { shelfLife: data },
    ...overrides,
  });

describe("Shelf Life model", () => {
  it.each([
    null,
    [],
    {},
    { ...data, version: 2 },
    { ...data, expiresAt: "1000" },
    { ...data, setAt: NaN },
    { ...data, expiresAt: Infinity },
    { ...data, setAt: -1 },
    { ...data, expiresAt: 8_640_000_000_000_001 },
  ])("rejects invalid metadata %j", (value) =>
    expect(normalizeShelfLifeData(value)).toBeNull(),
  );
  it("allows past dates and normalizes restore after extra fields", () => {
    expect(normalizeShelfLifeData(data)).toEqual(data);
    const elements = restoreElements(
      [
        note(),
        note({ customData: { shelfLife: { ...data, version: 8 }, other: 42 } }),
      ],
      null,
    );
    expect(elements[0].customData?.shelfLife).toEqual(data);
    expect(elements[1].customData).toEqual({ other: 42 });
  });
  it("computes exact expiry and day boundaries without altering style", () => {
    expect(getShelfLifeVisualState(data, 999)).toEqual({
      expired: false,
      opacity: 1,
    });
    expect(getShelfLifeVisualState(data, 1000)).toEqual({
      expired: true,
      opacity: 1,
    });
    expect(
      getShelfLifeVisualState(data, 1000 + SHELF_LIFE_DAY * 3 - 1).opacity,
    ).toBe(1);
    expect(
      getShelfLifeVisualState(data, 1000 + SHELF_LIFE_DAY * 3).opacity,
    ).toBe(0.8);
    expect(
      getShelfLifeVisualState(data, 1000 + SHELF_LIFE_DAY * 7).opacity,
    ).toBe(0.4);
    expect(
      getShelfLifeVisualState(data, 1000 + SHELF_LIFE_DAY * 30).opacity,
    ).toBe(0.4);
  });
  it("uses local calendar boundaries and exact relative days", () => {
    const monday = new Date(2026, 9, 19, 12).getTime();
    expect(new Date(getShelfLifeDeadline("week", monday))).toEqual(
      new Date(2026, 9, 26),
    );
    expect(
      new Date(
        getShelfLifeDeadline("week", new Date(2026, 9, 25, 23).getTime()),
      ),
    ).toEqual(new Date(2026, 9, 26));
    expect(getShelfLifeDeadline("threeDays", monday)).toBe(
      monday + SHELF_LIFE_DAY * 3,
    );
    expect(getShelfLifeDateDeadline("2026-02-30")).toBeNull();
    expect(getShelfLifeDateDeadline("2026-10-19")).toBe(
      new Date(2026, 9, 20).getTime(),
    );
  });
  it("inherits container metadata, skips locked notes, and counts bound text once", () => {
    const root = note({
      id: "root",
      boundElements: [{ id: "text", type: "text" }],
    });
    const text = API.createElement({
      type: "text",
      id: "text",
      containerId: root.id,
    });
    const locked = note({ locked: true });
    const elements = [root, text, locked];
    expect(getExpiredShelfLife(elements, 2000).unlocked).toEqual([root]);
    expect(getExpiredShelfLife(elements, 2000).locked).toEqual([locked]);
    const state = getElementShelfLifeState(
      text,
      new Map(elements.map((el) => [el.id, el])),
      1000 + 3 * SHELF_LIFE_DAY,
    );
    expect(state.opacity).toBe(0.8);
    const changed = setShelfLifeForSelection(
      elements,
      { [text.id]: true, [locked.id]: true },
      null,
    );
    expect(changed[0].customData).toBeUndefined();
    expect(changed[1]).toBe(text);
    expect(changed[2]).toBe(locked);
    const plan = planShelfLifeCleanup(elements, 2000);
    expect(plan.count).toBe(1);
    expect(plan.lockedCount).toBe(1);
    expect(plan.elements.map((el) => el.isDeleted)).toEqual([
      true,
      true,
      false,
    ]);
    expect(elements.every((el) => !el.isDeleted)).toBe(true);
  });
  it("retains metadata through JSON and PNG/SVG exports; renders warm vector paper", async () => {
    const element = note();
    const serialized = JSON.stringify(element);
    const svg = await exportToSvg({
      elements: [element],
      files: null,
      appState: { exportWithDarkMode: true },
    });
    expect(svg.innerHTML).toContain("#eab94f");
    expect(svg.querySelector("clipPath[id^='shelf-life-']")).not.toBeNull();
    await exportToCanvas({ elements: [element], files: null });
    expect(JSON.stringify(element)).toBe(serialized);
    expect(
      restoreElements([JSON.parse(serialized)], null)[0].customData?.shelfLife,
    ).toEqual(data);
  });

  it("badges fresh and due-soon notes, but keeps the badge out of exports", async () => {
    const now = Date.now();
    const fresh = API.createElement({
      type: "rectangle",
      width: 160,
      height: 120,
      customData: {
        shelfLife: {
          version: 1,
          setAt: now,
          expiresAt: now + 5 * SHELF_LIFE_DAY,
        },
      },
    });
    const soon = API.createElement({
      type: "rectangle",
      width: 160,
      height: 120,
      customData: {
        shelfLife: { version: 1, setAt: now, expiresAt: now + 3600_000 },
      },
    });
    const expired = note();
    const map = new Map(
      [fresh, soon, expired].map((el) => [el.id, el] as const),
    );
    const idle = getShelfLifeBadgeForElement(fresh, map, "light", now)!;
    const due = getShelfLifeBadgeForElement(soon, map, "light", now)!;
    expect(idle.dueSoon).toBe(false);
    expect(due.dueSoon).toBe(true);
    expect(idle.label).toMatch(/^\d{1,2}\/\d{1,2} \d{2}:\d{2}$/);
    expect(getShelfLifeBadgeForElement(expired, map, "light", now)).toBeNull();
    // Tiny notes still show the full date (it sits above them).
    const tiny = getShelfLifeBadgeForElement(
      API.createElement({
        type: "rectangle",
        width: 10,
        height: 10,
        customData: {
          shelfLife: { version: 1, setAt: now, expiresAt: now + 1000 },
        },
      }),
      map,
      "light",
      now,
    )!;
    expect(tiny.label).not.toBe("");
    expect(tiny.y).toBeLessThan(0);

    const svg = await exportToSvg({
      elements: [fresh, soon, expired],
      files: null,
      appState: { viewBackgroundColor: "#ffffff" },
    });
    // The deadline is editor UI for selected notes; exports show paper only.
    expect(svg.querySelectorAll("[data-shelf-life]")).toHaveLength(1);
    expect(svg.querySelector("[data-shelf-life='expired']")).not.toBeNull();
    expect(svg.querySelector("text")).toBeNull();
  });

  it("draws the badge only through the selection layer", () => {
    const now = Date.now();
    const element = API.createElement({
      type: "rectangle",
      width: 160,
      height: 120,
      customData: {
        shelfLife: {
          version: 1,
          setAt: now,
          expiresAt: now + 5 * SHELF_LIFE_DAY,
        },
      },
    });
    const map = new Map([[element.id, element]]);
    const before = JSON.stringify(element);
    const context = document.createElement("canvas").getContext("2d")!;
    const arc = vi.spyOn(context, "arc");
    const fillText = vi.spyOn(context, "fillText");
    renderShelfLifeOverlay(element, map, context, 0, 0, "light", now);
    expect(arc).not.toHaveBeenCalled();
    expect(fillText).not.toHaveBeenCalled();
    let textColor: unknown;
    fillText.mockImplementation(() => {
      textColor = context.fillStyle;
    });
    renderShelfLifeBadge(element, map, context, 0, 0, now, 1, "#1f9e8f");
    // Drawn in the selection color, like the selection frame.
    expect(textColor).toBe("#1f9e8f");
    expect(arc).toHaveBeenCalled();
    expect(fillText).toHaveBeenCalledWith(
      getShelfLifeBadge(element, map, now)!.label,
      expect.any(Number),
      expect.any(Number),
    );
    expect(JSON.stringify(element)).toBe(before);
  });
});

describe("Shelf Life badge layout", () => {
  const shape = (type: "rectangle") =>
    API.createElement({ type, width: 200, height: 120 });

  it("keeps the date clear of the clock", () => {
    const layout = getShelfLifeBadgeLayout(shape("rectangle"), "10/28")!;
    const clockRight = layout.clock.cx + layout.clock.r;
    const textLeft = layout.textX - (5 * layout.fontSize * 0.58) / 2;
    expect(layout.label).toBe("10/28");
    expect(textLeft).toBeGreaterThan(clockRight);
    expect(layout.textX).toBeLessThan(layout.x + layout.width);
  });

  it("sits above the note, right-aligned, at a fixed screen size", () => {
    const el = API.createElement({
      type: "rectangle",
      width: 320,
      height: 120,
    });
    const layout = getShelfLifeBadgeLayout(el, "10/28 14:30")!;
    expect(layout.x + layout.width).toBeCloseTo(el.width);
    expect(layout.y + layout.height).toBeLessThan(0);
    // Twice the zoom: half the scene size, same pixels on screen.
    const zoomed = getShelfLifeBadgeLayout(el, "10/28 14:30", 2)!;
    expect(zoomed.fontSize).toBeCloseTo(layout.fontSize / 2);
    expect(zoomed.x + zoomed.width).toBeCloseTo(el.width);
  });

  it("stays right-aligned at the same gap on small notes", () => {
    const wide = getShelfLifeBadgeLayout(shape("rectangle"), "10/28 14:30")!;
    for (const size of [120, 60, 24]) {
      const el = API.createElement({
        type: "rectangle",
        width: size,
        height: size,
      });
      const layout = getShelfLifeBadgeLayout(el, "10/28 14:30")!;
      // Same distance above the note at every size.
      expect(layout.y).toBeCloseTo(wide.y);
      // Right edge flush with the note's right edge, however narrow.
      expect(layout.x + layout.width).toBeCloseTo(size);
    }
  });

  it("only rectangles (and their bound text) carry a shelf life", () => {
    const map = new Map<string, ExcalidrawElement>();
    for (const type of ["ellipse", "diamond", "image", "text"] as const) {
      const el = API.createElement({ type, customData: { shelfLife: data } });
      map.set(el.id, el);
      expect(getShelfLifeData(el)).toBeNull();
      expect(getShelfLifeRoot(el, map)).toBeNull();
    }
    const rect = note({ id: "rect" });
    const label = API.createElement({
      type: "text",
      containerId: "rect",
    });
    const ellipse = API.createElement({ id: "ell", type: "ellipse" });
    const inEllipse = API.createElement({ type: "text", containerId: "ell" });
    const all = new Map(
      [rect, label, ellipse, inEllipse].map((el) => [el.id, el]),
    );
    expect(getShelfLifeRoot(label, all)).toBe(rect);
    expect(getShelfLifeRoot(inEllipse, all)).toBeNull();
    // Selecting an ellipse sets nothing; stale data on it is dropped on load.
    expect(setShelfLifeForSelection([ellipse], { ell: true }, data)[0]).toBe(
      ellipse,
    );
    expect(
      restoreElements(
        [{ ...ellipse, customData: { shelfLife: data } }],
        null,
      )[0].customData,
    ).toBeUndefined();
  });

  it("labels midnight deadlines with the last good day", () => {
    const end = new Date(2026, 9, 29, 0, 0, 0, 0).getTime();
    const el = API.createElement({
      type: "rectangle",
      width: 200,
      height: 120,
      customData: {
        shelfLife: {
          version: 1,
          setAt: end - SHELF_LIFE_DAY * 3,
          expiresAt: end,
        },
      },
    });
    const badge = getShelfLifeBadge(
      el,
      new Map([[el.id, el]]),
      end - SHELF_LIFE_DAY * 2,
    )!;
    expect(badge.label).toBe("10/28");
  });
});

describe("Shelf Life badge label", () => {
  const now = new Date(2026, 9, 26, 10, 0).getTime();
  it("names the last good day, the time today, or both", () => {
    expect(
      formatShelfLifeBadgeLabel(new Date(2026, 9, 29).getTime(), now),
    ).toBe("10/28");
    expect(
      formatShelfLifeBadgeLabel(new Date(2026, 9, 26, 18, 30).getTime(), now),
    ).toBe("18:30");
    expect(
      formatShelfLifeBadgeLabel(new Date(2026, 9, 27, 9, 5).getTime(), now),
    ).toBe("10/27 09:05");
  });
});

describe("Shelf Life visual scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it("redraws only across boundaries, pauses hidden, and updates immediately when visible", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const element = note({
      customData: { shelfLife: { ...data, expiresAt: 60_000 } },
    });
    const redraw = vi.fn();
    let notify = () => {};
    const stop = createShelfLifeScheduler({
      getElements: () => [element],
      subscribe: (cb) => {
        notify = cb;
        return vi.fn();
      },
      redraw,
    });
    vi.advanceTimersByTime(60_000);
    expect(redraw).toHaveBeenCalledTimes(1);
    notify();
    vi.advanceTimersByTime(120_000);
    expect(redraw).toHaveBeenCalledTimes(1);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(3 * SHELF_LIFE_DAY);
    expect(redraw).toHaveBeenCalledTimes(1);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(redraw).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(SHELF_LIFE_DAY);
    expect(redraw).toHaveBeenCalledTimes(2);
  });
});
