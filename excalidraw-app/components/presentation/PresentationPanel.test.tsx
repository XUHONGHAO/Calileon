import React from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@excalidraw/excalidraw/tests/test-utils";
import { Keyboard } from "@excalidraw/excalidraw/tests/helpers/ui";
import { CaptureUpdateAction } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { getSlideData } from "../../presentation/slideData";
import { getSlides } from "../../presentation/slides";
import {
  getPresentationSession,
  stopPresentation,
} from "../../presentation/session";
import { makeFrame } from "../../presentation/testUtils";

import { PresentationPanel } from "./PresentationPanel";

let api!: ExcalidrawImperativeAPI;

const Host = () => {
  const [value, setValue] = React.useState<ExcalidrawImperativeAPI | null>(
    null,
  );
  return (
    <Excalidraw
      handleKeyboardGlobally
      onExcalidrawAPI={(next) => {
        if (next) {
          api = next as ExcalidrawImperativeAPI;
          setValue(api);
        }
      }}
    >
      <PresentationPanel excalidrawAPI={value} />
    </Excalidraw>
  );
};

const load = (elements: ExcalidrawElement[], viewModeEnabled = false) =>
  act(() => {
    api.updateScene({
      elements,
      appState: { viewModeEnabled },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  });

const deck = () => [
  makeFrame({ id: "intro", x: 0, name: "Intro" }),
  makeFrame({ id: "middle", x: 400, slide: { notes: "Say hi" } }),
  makeFrame({ id: "secret", x: 800, name: "Secret", slide: { hidden: true } }),
];

const list = () =>
  screen.getByRole("list", { name: "Slides" }) as HTMLOListElement;

const rowTitles = () =>
  within(list())
    .getAllByRole("listitem")
    .map(
      (item) =>
        item.querySelector(".PresentationPanel__slideTitle")?.textContent,
    );

const expandRow = (title: string) =>
  fireEvent.click(
    within(list()).getByText(title).closest("button") as HTMLButtonElement,
  );

const order = () => getSlides(api.getSceneElements()).map((s) => s.frame.id);

const frameById = (id: string) =>
  api.getSceneElements().find((element) => element.id === id)!;

describe("PresentationPanel (ADR 0036 §4)", () => {
  beforeEach(async () => {
    await render(<Host />);
  });

  afterEach(() => {
    act(() => stopPresentation());
  });

  it("shows the empty state with a frame-tool shortcut", () => {
    expect(
      screen.getByText(/Every frame is one slide/, { exact: false }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add a frame" }));
    expect(api.getAppState().activeTool.type).toBe("frame");
  });

  it("keeps the add-a-frame action after the first slide exists", () => {
    load(deck());
    fireEvent.click(screen.getByRole("button", { name: "Add a frame" }));
    expect(api.getAppState().activeTool.type).toBe("frame");
    expect(
      screen.getByText(/press F, or pick Frame tool under More tools/),
    ).toBeInTheDocument();
  });

  it("hides the add-a-frame action from viewers", () => {
    load(deck(), true);
    expect(screen.queryByRole("button", { name: "Add a frame" })).toBeNull();
  });

  it("lists slides in order with hidden and notes markers", () => {
    load(deck());
    expect(screen.getByText("Slides: 3")).toBeInTheDocument();
    expect(rowTitles()).toEqual(["Intro", "Slide 2", "Secret"]);
    const [, middle, secret] = within(list()).getAllByRole("listitem");
    expect(within(middle).getByText("Has speaker notes")).toBeInTheDocument();
    expect(within(secret).getByText("Hidden")).toBeInTheDocument();
  });

  it("moves a slide down as one undoable step", () => {
    load(deck());
    expandRow("Intro");
    fireEvent.click(screen.getByRole("button", { name: "Move down" }));
    expect(order()).toEqual(["middle", "intro", "secret"]);
    expect(rowTitles()).toEqual(["Slide 1", "Intro", "Secret"]);
    Keyboard.undo();
    expect(order()).toEqual(["intro", "middle", "secret"]);
  });

  it("hides and shows a slide", () => {
    load(deck());
    expandRow("Intro");
    fireEvent.click(screen.getByRole("button", { name: "Hide in slideshow" }));
    expect(getSlideData(frameById("intro")).hidden).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Show in slideshow" }));
    expect(getSlideData(frameById("intro")).hidden).toBeUndefined();
  });

  it("renames on Enter and commits notes after a pause or on blur", async () => {
    load(deck());
    expandRow("Intro");
    const name = screen.getByLabelText("Slide name");
    fireEvent.focus(name);
    fireEvent.change(name, { target: { value: "Opening" } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect((frameById("intro") as any).name).toBe("Opening");

    const notes = screen.getByLabelText("Speaker notes");
    expect(
      screen.getByText("Notes are visible to anyone who can open this board."),
    ).toBeInTheDocument();
    fireEvent.focus(notes);
    fireEvent.change(notes, { target: { value: "First draft" } });
    expect(getSlideData(frameById("intro")).notes).toBeUndefined();
    expect(screen.getByText("11 / 4000")).toBeInTheDocument();
    await waitFor(
      () => expect(getSlideData(frameById("intro")).notes).toBe("First draft"),
      { timeout: 2000 },
    );

    fireEvent.change(notes, { target: { value: "Final words" } });
    fireEvent.blur(notes);
    expect(getSlideData(frameById("intro")).notes).toBe("Final words");
  });

  it("is read-only in view mode but can still play", () => {
    load(deck(), true);
    expandRow("Slide 2");
    expect(screen.queryByLabelText("Speaker notes")).toBeNull();
    expect(screen.getByText("Say hi")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move down" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Hide in slideshow" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Play from here" }));
    expect(getPresentationSession()?.startFrameId).toBe("middle");
  });

  it("plays from the start, or from the selected slide", () => {
    load(deck());
    fireEvent.click(screen.getByRole("button", { name: "Play from start" }));
    expect(getPresentationSession()?.startFrameId).toBeNull();
    act(() => stopPresentation());

    act(() => {
      api.updateScene({
        appState: { selectedElementIds: { middle: true } },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Play from current slide" }),
    );
    expect(getPresentationSession()?.startFrameId).toBe("middle");
  });

  it("disables play and export when every slide is hidden", () => {
    load([makeFrame({ id: "only", slide: { hidden: true } })]);
    expect(
      screen.getByText(/All slides are hidden/, { exact: false }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Play from start" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Export PDF" })).toBeDisabled();
  });
});
