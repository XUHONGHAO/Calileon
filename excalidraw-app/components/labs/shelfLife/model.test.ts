import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { exportToSvg, exportToCanvas } from "@excalidraw/utils";

import {
  getExpiredShelfLife,
  getShelfLifeBadge,
  getShelfLifeBadgeForElement,
  getShelfLifeBadgeLayout,
  getShelfLifeGeometry,
  renderShelfLifeOverlay,
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

  it("marks fresh and due-soon notes on the canvas with their deadline", async () => {
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
    expect(due.accent).not.toBe(idle.ink);
    expect(idle.label).toMatch(/^\d{1,2}\/\d{1,2}$/);
    expect(getShelfLifeBadgeForElement(expired, map, "light", now)).toBeNull();
    expect(
      getShelfLifeBadgeForElement(
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
      ),
    ).toBeNull();

    const svg = await exportToSvg({
      elements: [fresh, soon, expired],
      files: null,
      appState: { viewBackgroundColor: "#ffffff" },
    });
    expect(svg.querySelectorAll("[data-shelf-life-badge]")).toHaveLength(2);
    expect(svg.querySelector("[data-shelf-life-badge='due']")).not.toBeNull();
    expect(svg.querySelector("[data-shelf-life='expired']")).not.toBeNull();
    expect(svg.querySelector("[data-shelf-life-badge] text")!.textContent).toBe(
      idle.label,
    );
  });

  it("draws the badge on the canvas path and never mutates the element", () => {
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
    expect(arc).toHaveBeenCalled();
    expect(fillText).toHaveBeenCalledWith(
      expect.stringMatching(/^\d{1,2}\/\d{1,2}$/),
      expect.any(Number),
      expect.any(Number),
    );
    expect(JSON.stringify(element)).toBe(before);
  });
});

describe("Shelf Life badge layout", () => {
  const shape = (type: "rectangle" | "ellipse" | "diamond" | "text") =>
    API.createElement({ type, width: 200, height: 120 });

  it("keeps the date clear of the clock", () => {
    const layout = getShelfLifeBadgeLayout(shape("rectangle"), "10/28")!;
    const clockRight = layout.clock.cx + layout.clock.r;
    const textLeft = layout.textX - (5 * layout.fontSize * 0.58) / 2;
    expect(layout.label).toBe("10/28");
    expect(textLeft).toBeGreaterThan(clockRight);
    expect(layout.textX).toBeLessThan(layout.x + layout.width);
  });

  it("stays inside curved and pointed outlines", () => {
    for (const type of ["ellipse", "diamond"] as const) {
      const el = shape(type);
      const layout = getShelfLifeBadgeLayout(el, "10/28")!;
      const w = el.width;
      const h = el.height;
      const inside = (x: number, y: number) =>
        type === "ellipse"
          ? ((x - w / 2) / (w / 2)) ** 2 + ((y - h / 2) / (h / 2)) ** 2 <= 1
          : Math.abs(x - w / 2) / (w / 2) + Math.abs(y - h / 2) / (h / 2) <= 1;
      for (const [x, y] of [
        [layout.x, layout.y],
        [layout.x + layout.width, layout.y],
        [layout.x, layout.y + layout.height],
        [layout.x + layout.width, layout.y + layout.height],
      ]) {
        expect(inside(x, y)).toBe(true);
      }
    }
  });

  it("puts standalone text badges past the glyphs and never folds text", () => {
    const el = shape("text");
    const layout = getShelfLifeBadgeLayout(el, "10/28")!;
    expect(layout.x).toBeGreaterThan(el.width);
    expect(layout.clip).toBe(false);
    expect(getShelfLifeGeometry(el).size).toBe(0);
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
