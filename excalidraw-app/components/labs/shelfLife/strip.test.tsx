import React from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import {
  act,
  fireEvent,
  render,
  screen,
  within,
} from "@excalidraw/excalidraw/tests/test-utils";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import {
  CaptureUpdateAction,
  getElementShelfLifeState,
  SHELF_LIFE_DAY,
  syncInvalidIndices,
} from "@excalidraw/element";
import { exportToSvg } from "@excalidraw/utils";
import { t } from "@excalidraw/excalidraw/i18n";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { ShelfLifeStrip, formatStripTime } from "./ShelfLifeStrip";
import {
  getShelfLifeEntries,
  setShelfLifeStripMode,
  setShelfLifeVisuals,
} from "./strip";

const now = new Date(2026, 9, 26, 10, 0).getTime();
const life = (expiresAt: number) => ({
  shelfLife: { version: 1 as const, setAt: now - SHELF_LIFE_DAY, expiresAt },
});

describe("Shelf Life strip entries", () => {
  it("lists roots soonest first, labelled by their text", () => {
    const later = API.createElement({
      id: "later",
      type: "rectangle",
      customData: life(now + 5 * SHELF_LIFE_DAY),
      boundElements: [{ id: "label", type: "text" }],
    });
    const label = API.createElement({
      id: "label",
      type: "text",
      text: "Ship the release notes before Friday",
      containerId: "later",
      // A label never gets its own chip, even with stale data on it.
      customData: life(now + SHELF_LIFE_DAY * 9),
    });
    const soon = API.createElement({
      id: "soon",
      type: "rectangle",
      customData: life(now + 3600_000),
    });
    const gone = API.createElement({
      id: "gone",
      type: "rectangle",
      customData: life(now - 1000),
    });
    const plain = API.createElement({ id: "plain", type: "rectangle" });
    // Not a note: only rectangles carry a shelf life.
    const ellipse = API.createElement({
      id: "ellipse",
      type: "ellipse",
      customData: life(now + 60_000),
    });
    const entries = getShelfLifeEntries(
      [later, label, soon, gone, plain, ellipse],
      now,
    );
    expect(entries.map((e) => [e.id, e.state])).toEqual([
      ["gone", "expired"],
      ["soon", "due"],
      ["later", "fresh"],
    ]);
    expect(entries[2].text).toBe("Ship the rele…");
    expect(entries[1].text).toBe("");
  });

  it("names the day the way people say it", () => {
    const entry = (expiresAt: number) =>
      getShelfLifeEntries(
        [API.createElement({ type: "rectangle", customData: life(expiresAt) })],
        now,
      )[0];
    expect(
      formatStripTime(entry(new Date(2026, 9, 26, 18, 30).getTime()), now),
    ).toBe(`${t("labs.shelfLife.stripToday")} 18:30`);
    expect(formatStripTime(entry(new Date(2026, 9, 28).getTime()), now)).toBe(
      t("labs.shelfLife.stripEndOf", {
        day: t("labs.shelfLife.stripTomorrow"),
      }),
    );
    expect(
      formatStripTime(entry(new Date(2026, 10, 2, 9, 5).getTime()), now),
    ).toBe("11/2 09:05");
    expect(formatStripTime(entry(now - 1), now)).toBe(
      t("labs.shelfLife.stripExpired"),
    );
  });
});

describe("ShelfLifeStrip", () => {
  afterEach(() =>
    act(() => {
      setShelfLifeStripMode("open");
      setShelfLifeVisuals(true);
    }),
  );

  const setup = async () => {
    let api!: ExcalidrawImperativeAPI;
    const Wrapper = () => {
      const [value, setValue] = React.useState<ExcalidrawImperativeAPI | null>(
        null,
      );
      return (
        <Excalidraw
          onExcalidrawAPI={(next) => {
            if (next) {
              api = next as ExcalidrawImperativeAPI;
              setValue(api);
            }
          }}
        >
          <ShelfLifeStrip excalidrawAPI={value} />
        </Excalidraw>
      );
    };
    await render(<Wrapper />);
    return () => api;
  };

  it("stays out of the way until a note has a shelf life", async () => {
    const getApi = await setup();
    expect(screen.queryByTestId("shelf-life-strip")).toBeNull();
    const note = API.createElement({
      id: "note",
      type: "rectangle",
      customData: life(Date.now() + 3 * SHELF_LIFE_DAY),
    });
    act(() =>
      getApi().updateScene({
        elements: syncInvalidIndices([note]),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    const strip = within(screen.getByRole("toolbar"));
    const chip = strip.getByRole("button", { pressed: false });
    fireEvent.click(chip);
    // Jumping selects the note without adding an undo step.
    expect(getApi().getAppState().selectedElementIds).toEqual({ note: true });
    expect(strip.getByRole("button", { pressed: true })).toBe(chip);
    expect(API.getUndoStack().length).toBe(1);
  });

  it("hides the canvas visuals without touching the data", async () => {
    const getApi = await setup();
    const note = API.createElement({
      id: "old",
      type: "rectangle",
      customData: life(Date.now() - 5 * SHELF_LIFE_DAY),
    });
    act(() =>
      getApi().updateScene({
        elements: syncInvalidIndices([note]),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    const map = new Map([[note.id, note]]);
    expect(getElementShelfLifeState(note, map).expired).toBe(true);
    const toggle = screen.getByRole("button", {
      name: t("labs.shelfLife.visualsLabel"),
    });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(getElementShelfLifeState(note, map)).toEqual({
      expired: false,
      opacity: 1,
    });
    const svg = await exportToSvg({ elements: [note], files: null });
    expect(svg.querySelector("[data-shelf-life]")).toBeNull();
    // Data, undo history and the strip itself are unaffected.
    expect(
      getApi().getSceneElements()[0].customData?.shelfLife?.expiresAt,
    ).toBe(note.customData!.shelfLife.expiresAt);
    expect(API.getUndoStack().length).toBe(1);
    expect(screen.getByTestId("shelf-life-strip")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(getElementShelfLifeState(note, map).expired).toBe(true);
  });

  it("collapses to its toggle and can be switched off", async () => {
    const getApi = await setup();
    act(() =>
      getApi().updateScene({
        elements: syncInvalidIndices([
          API.createElement({
            type: "rectangle",
            customData: life(Date.now() + SHELF_LIFE_DAY * 2),
          }),
        ]),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: t("labs.shelfLife.stripCollapse") }),
    );
    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: t("labs.shelfLife.stripExpand", { count: 1 }),
      }),
    ).toHaveAttribute("aria-expanded", "false");
    act(() => setShelfLifeStripMode("hidden"));
    expect(screen.queryByTestId("shelf-life-strip")).toBeNull();
  });
});
