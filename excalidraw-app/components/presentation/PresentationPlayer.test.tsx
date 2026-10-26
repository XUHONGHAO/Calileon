import React from "react";
import { vi } from "vitest";
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
import { CaptureUpdateAction, newElementWith } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  getPresentationSession,
  startPresentation,
  stopPresentation,
} from "../../presentation/session";
import { makeChild, makeFrame } from "../../presentation/testUtils";

import {
  PRESENTING_BODY_CLASS,
  PresentationPlayer,
} from "./PresentationPlayer";

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
      <PresentationPlayer excalidrawAPI={value} />
    </Excalidraw>
  );
};

const deck = (): ExcalidrawElement[] => [
  makeFrame({ id: "one", x: 0, name: "One", slide: { notes: "Notes one" } }),
  makeFrame({ id: "skip", x: 400, name: "Skip", slide: { hidden: true } }),
  makeFrame({ id: "two", x: 800, name: "Two" }),
  makeFrame({ id: "three", x: 1200, name: "Three" }),
  makeChild("child", "one", 10, 10),
];

const counter = () =>
  document.querySelector(".PresentationPlayer__counter")?.textContent;

const play = (opts: Parameters<typeof startPresentation>[0] = {}) =>
  act(() => startPresentation(opts));

const press = (key: string) => act(() => Keyboard.keyPress(key));

const removeFrame = (id: string) =>
  act(() => {
    api.updateScene({
      elements: api
        .getSceneElementsIncludingDeleted()
        .map((element) =>
          element.id === id
            ? newElementWith(element, { isDeleted: true })
            : element,
        ),
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  });

describe("PresentationPlayer (ADR 0036 §3)", () => {
  beforeEach(async () => {
    await render(<Host />);
    act(() => {
      api.updateScene({
        elements: deck(),
        appState: { selectedElementIds: { child: true } },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    });
  });

  // not vi.restoreAllMocks(): it would also reset setupTests' matchMedia mock
  const spies: { mockRestore: () => void }[] = [];

  afterEach(() => {
    act(() => stopPresentation());
    spies.splice(0).forEach((spy) => spy.mockRestore());
  });

  it("enters a clean view and puts everything back on Esc", async () => {
    play();
    expect(document.body).toHaveClass(PRESENTING_BODY_CLASS);
    const appState = api.getAppState();
    expect(appState.viewModeEnabled).toBe(true);
    expect(appState.selectedElementIds).toEqual({});
    expect(appState.frameRendering).toMatchObject({
      name: false,
      outline: false,
    });
    expect(counter()).toBe("1 / 3");
    expect(
      screen.getByText("Slide 1 of 3: One", { exact: false }),
    ).toBeInTheDocument();

    press("Escape");
    expect(getPresentationSession()).toBeNull();
    expect(document.querySelector(".PresentationPlayer")).toBeNull();
    expect(document.body).not.toHaveClass(PRESENTING_BODY_CLASS);
    expect(api.getAppState().viewModeEnabled).toBe(false);
    expect(api.getAppState().frameRendering).toMatchObject({
      name: true,
      outline: true,
    });
    await waitFor(() =>
      expect(api.getAppState().selectedElementIds).toEqual({ child: true }),
    );
  });

  it("steps through playable slides and skips hidden ones", () => {
    play();
    press("ArrowRight");
    expect(counter()).toBe("2 / 3");
    expect(
      screen.getByText("Slide 2 of 3: Two", { exact: false }),
    ).toBeInTheDocument();
    press("End");
    expect(counter()).toBe("3 / 3");
    press("PageDown");
    expect(counter()).toBe("3 / 3");
    press("Home");
    expect(counter()).toBe("1 / 3");
    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    expect(counter()).toBe("2 / 3");
  });

  it("keeps editor shortcuts out and toggles the laser with L", () => {
    play();
    press("r");
    expect(api.getAppState().activeTool.type).not.toBe("rectangle");
    const laser = screen.getByRole("button", { name: "Laser pointer" });
    press("l");
    expect(api.getAppState().activeTool.type).toBe("laser");
    expect(laser).toHaveAttribute("aria-pressed", "true");
    press("l");
    expect(api.getAppState().activeTool.type).toBe("selection");
    expect(laser).toHaveAttribute("aria-pressed", "false");
  });

  it("starts from a requested slide, moving past a hidden one", () => {
    play({ startFrameId: "skip" });
    expect(counter()).toBe("2 / 3");
  });

  it("follows slides removed mid-show, and ends when none are left", () => {
    play({ startFrameId: "two" });
    removeFrame("two");
    expect(counter()).toBe("2 / 2");
    expect(screen.getByRole("status")).toHaveTextContent(
      "This slide was removed",
    );
    removeFrame("one");
    removeFrame("three");
    expect(getPresentationSession()).toBeNull();
    expect(api.getAppState().toast?.message).toBe(
      "All slides were removed, so the slideshow ended.",
    );
  });

  it("does not start when every slide is hidden", () => {
    act(() => {
      api.updateScene({
        elements: [makeFrame({ id: "only", slide: { hidden: true } })],
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    });
    play();
    expect(getPresentationSession()).toBeNull();
    expect(api.getAppState().toast?.message).toBe("There is no slide to play.");
  });

  it("animates slide changes unless reduced motion is preferred", () => {
    play();
    const scroll = vi.spyOn(api, "scrollToContent");
    spies.push(scroll);
    press("ArrowRight");
    expect(scroll).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "two" }),
      expect.objectContaining({ animate: true, fitToViewport: true }),
    );
    const zoom = scroll.mock.lastCall![1]!;
    expect(zoom.minZoom).toBe(zoom.maxZoom);

    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      ...original(query),
      matches: query.includes("reduce"),
    })) as typeof window.matchMedia;
    spies.push({ mockRestore: () => (window.matchMedia = original) });
    press("ArrowRight");
    expect(scroll).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "three" }),
      expect.objectContaining({ animate: false }),
    );
  });

  it("drives the show from the presenter window", () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const popup = iframe.contentWindow!;
    spies.push(vi.spyOn(window, "open").mockReturnValue(popup));

    play({ presenterView: true });
    const view = within(popup.document.body);
    expect(view.getByText("Notes one")).toBeInTheDocument();
    expect(view.getByText("Two")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Presenter view" }),
    ).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(view.getByRole("button", { name: "Next slide" }));
    expect(counter()).toBe("2 / 3");
    expect(view.getByText("No speaker notes.")).toBeInTheDocument();

    act(() => {
      popup.dispatchEvent(
        new (popup as typeof window).KeyboardEvent("keydown", {
          key: "ArrowRight",
        }),
      );
    });
    expect(counter()).toBe("3 / 3");
    expect(view.getByText("This is the last slide.")).toBeInTheDocument();

    fireEvent.click(view.getByRole("button", { name: "End slideshow" }));
    expect(getPresentationSession()).toBeNull();
    iframe.remove();
  });
});
