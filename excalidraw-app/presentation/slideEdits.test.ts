import type { ExcalidrawElement } from "@excalidraw/element/types";

import { SLIDE_NOTES_MAX_LENGTH, getSlideData } from "./slideData";
import {
  moveSlide,
  renameSlide,
  resetSlideOrder,
  setSlideHidden,
  setSlideNotes,
} from "./slideEdits";
import { getSlides } from "./slides";
import { ids, makeChild, makeFrame } from "./testUtils";

const byId = (elements: readonly ExcalidrawElement[], id: string) =>
  elements.find((element) => element.id === id)!;

const orderOf = (elements: readonly ExcalidrawElement[]) =>
  ids(getSlides(elements));

const row = () => [
  makeFrame({ id: "a", x: 0 }),
  makeFrame({ id: "b", x: 400 }),
  makeFrame({ id: "c", x: 800 }),
  makeFrame({ id: "d", x: 1200 }),
];

describe("slide edits", () => {
  it("writes notes as a new element version and leaves other elements alone", () => {
    const elements = [...row(), makeChild("child", "a")];
    const next = setSlideNotes(elements, "b", "Say hello")!;
    expect(next).not.toBeNull();
    expect(getSlideData(byId(next, "b")).notes).toBe("Say hello");
    expect(byId(next, "b").version).toBeGreaterThan(
      byId(elements, "b").version,
    );
    expect(byId(next, "a")).toBe(byId(elements, "a"));
    expect(byId(next, "child")).toBe(byId(elements, "child"));
  });

  it("caps notes and removes the key when they are cleared", () => {
    const elements = row();
    const long = setSlideNotes(
      elements,
      "a",
      "y".repeat(SLIDE_NOTES_MAX_LENGTH + 1),
    )!;
    expect(getSlideData(byId(long, "a")).notes).toHaveLength(
      SLIDE_NOTES_MAX_LENGTH,
    );
    const cleared = setSlideNotes(long, "a", "")!;
    expect(byId(cleared, "a").customData).toBeUndefined();
  });

  it("returns null when nothing changes", () => {
    const elements = row();
    expect(setSlideNotes(elements, "a", "")).toBeNull();
    expect(setSlideHidden(elements, "a", false)).toBeNull();
    expect(setSlideNotes(elements, "missing", "x")).toBeNull();
    expect(renameSlide(elements, "a", "   ")).toBeNull();
    expect(resetSlideOrder(elements)).toBeNull();
  });

  it("ignores deleted frames and non-frames", () => {
    const elements = [
      makeFrame({ id: "gone", isDeleted: true }),
      makeChild("child", null),
    ];
    expect(setSlideHidden(elements, "gone", true)).toBeNull();
    expect(setSlideNotes(elements, "child", "x")).toBeNull();
  });

  it("hides and shows a slide without touching its notes", () => {
    const elements = [makeFrame({ id: "a", slide: { notes: "keep" } })];
    const hidden = setSlideHidden(elements, "a", true)!;
    expect(getSlideData(byId(hidden, "a"))).toEqual({
      notes: "keep",
      hidden: true,
    });
    const shown = setSlideHidden(hidden, "a", false)!;
    expect(getSlideData(byId(shown, "a"))).toEqual({ notes: "keep" });
  });

  it("renames through the frame's own name field", () => {
    const elements = row();
    const renamed = renameSlide(elements, "a", "  Intro ")!;
    expect((byId(renamed, "a") as any).name).toBe("Intro");
    expect((byId(renameSlide(renamed, "a", "")!, "a") as any).name).toBeNull();
  });
});

describe("moveSlide", () => {
  it("first move writes keys for every slide in the current order", () => {
    const elements = row();
    const next = moveSlide(elements, "d", 1)!;
    expect(orderOf(next)).toEqual(["a", "d", "b", "c"]);
    expect(
      getSlides(next).every((slide) => typeof slide.data.order === "string"),
    ).toBe(true);
  });

  it("later moves only rewrite the moved slide", () => {
    const first = moveSlide(row(), "d", 1)!;
    const second = moveSlide(first, "a", 3)!;
    expect(orderOf(second)).toEqual(["d", "b", "c", "a"]);
    for (const id of ["b", "c", "d"]) {
      expect(byId(second, id)).toBe(byId(first, id));
    }
    expect(byId(second, "a")).not.toBe(byId(first, "a"));
  });

  it("clamps the target and ignores no-op moves", () => {
    const elements = row();
    expect(orderOf(moveSlide(elements, "a", 99)!)).toEqual([
      "b",
      "c",
      "d",
      "a",
    ]);
    expect(orderOf(moveSlide(elements, "d", -5)!)).toEqual([
      "d",
      "a",
      "b",
      "c",
    ]);
    expect(moveSlide(elements, "b", 1)).toBeNull();
    expect(moveSlide(elements, "missing", 0)).toBeNull();
  });

  it("re-keys everything when a new keyless frame joins an ordered list", () => {
    const ordered = moveSlide(row(), "d", 0)!;
    const withNew = [...ordered, makeFrame({ id: "e", x: -400 })];
    // the keyless frame is listed after the ordered ones
    expect(orderOf(withNew)).toEqual(["d", "a", "b", "c", "e"]);
    const next = moveSlide(withNew, "e", 1)!;
    expect(orderOf(next)).toEqual(["d", "e", "a", "b", "c"]);
    expect(
      getSlides(next).every((slide) => typeof slide.data.order === "string"),
    ).toBe(true);
  });

  it("repairs colliding keys from concurrent edits", () => {
    const elements = [
      makeFrame({ id: "a", x: 0, slide: { order: "a0" } }),
      makeFrame({ id: "b", x: 400, slide: { order: "a0" } }),
      makeFrame({ id: "c", x: 800, slide: { order: "a1" } }),
    ];
    const next = moveSlide(elements, "c", 0)!;
    expect(orderOf(next)).toEqual(["c", "a", "b"]);
    const keys = getSlides(next).map((slide) => slide.data.order!);
    expect(new Set(keys).size).toBe(3);
  });

  it("keeps notes and hidden flags while reordering", () => {
    const elements = [
      makeFrame({ id: "a", x: 0, slide: { notes: "n", hidden: true } }),
      makeFrame({ id: "b", x: 400 }),
    ];
    const next = moveSlide(elements, "a", 1)!;
    expect(getSlideData(byId(next, "a"))).toMatchObject({
      notes: "n",
      hidden: true,
    });
  });

  it("reorder by position drops every key", () => {
    const moved = moveSlide(row(), "d", 0)!;
    const reset = resetSlideOrder(moved)!;
    expect(orderOf(reset)).toEqual(["a", "b", "c", "d"]);
    expect(getSlides(reset).some((slide) => slide.data.order)).toBe(false);
  });
});
