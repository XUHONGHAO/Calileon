import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { vi } from "vitest";

import { UIAppStateContext } from "@excalidraw/excalidraw/context/ui-appState";

import { CastRecordingBar } from "./CastRecordingBar";

const renderBar = (
  props: Partial<React.ComponentProps<typeof CastRecordingBar>> = {},
) => {
  const handlers = {
    onPause: vi.fn(),
    onResume: vi.fn(),
    onStop: vi.fn(),
    onPointerOver: vi.fn(),
  };
  render(
    <UIAppStateContext.Provider value={{ theme: "light" } as any}>
      <CastRecordingBar
        state="recording"
        elapsed="0:07"
        {...handlers}
        {...props}
      />
    </UIAppStateContext.Provider>,
  );
  return handlers;
};

describe("CastRecordingBar", () => {
  it("portals a floating bar with the timer, pause and stop while recording", () => {
    const handlers = renderBar();
    const bar = screen.getByTestId("cast-recording-bar");

    expect(bar.closest(".CastRecordingBar-container")?.parentElement).toBe(
      document.body,
    );
    expect(bar).toHaveClass("CastRecordingBar--recording");
    expect(bar).toHaveTextContent("0:07");

    fireEvent.click(screen.getByTestId("cast-pause-recording"));
    fireEvent.click(screen.getByTestId("cast-stop-recording"));
    expect(handlers.onPause).toHaveBeenCalledTimes(1);
    expect(handlers.onStop).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("cast-resume-recording")).toBeNull();
  });

  it("offers resume when paused and hides the recorded pointer on hover", () => {
    const handlers = renderBar({ state: "paused" });
    const bar = screen.getByTestId("cast-recording-bar");

    fireEvent.pointerEnter(bar);
    fireEvent.click(screen.getByTestId("cast-resume-recording"));

    expect(handlers.onPointerOver).toHaveBeenCalledTimes(1);
    expect(handlers.onResume).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("cast-pause-recording")).toBeNull();
  });
});
