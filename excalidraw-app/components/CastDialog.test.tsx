import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UIAppStateContext } from "@excalidraw/excalidraw/context/ui-appState";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { CastDialog } from "./CastDialog";

import type { MockInstance } from "vitest";

// The nested replay editor is irrelevant here; the recorder, player and
// serializer run for real.
vi.mock("@excalidraw/excalidraw", () => ({
  CaptureUpdateAction: { NEVER: "NEVER" },
  Excalidraw: () => <div data-testid="cast-preview-editor" />,
  ExcalidrawAPIProvider: ({ children }: { children: React.ReactNode }) =>
    children,
  sceneCoordsToViewportCoords: () => ({ x: 0, y: 0 }),
}));
vi.mock("@excalidraw/excalidraw/components/Dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("../auth/useCloudAuth", () => ({
  useCloudAuth: () => ({ isSignedIn: false }),
}));

const fakeAPI = () =>
  ({
    getName: () => "Board",
    getSceneElements: () => [],
    getAppState: () => ({
      scrollX: 0,
      scrollY: 0,
      zoom: { value: 1 },
      viewBackgroundColor: "#ffffff",
      theme: "light",
    }),
    getFiles: () => ({}),
    onIncrement: () => () => {},
    onScrollChange: () => () => {},
  } as unknown as ExcalidrawImperativeAPI);

const renderDialog = () =>
  render(
    <UIAppStateContext.Provider value={{ theme: "light" } as any}>
      <CastDialog open onClose={vi.fn()} excalidrawAPI={fakeAPI()} />
    </UIAppStateContext.Provider>,
  );

const recordOnce = async () => {
  fireEvent.click(screen.getByTestId("cast-start-recording"));
  fireEvent.click(await screen.findByTestId("cast-stop-recording"));
  await screen.findByTestId("cast-discard");
};

const status = () => screen.getByTestId("cast-recorder-status").textContent;

describe("CastDialog unsaved recording", () => {
  let confirmSpy: MockInstance<typeof window.confirm>;

  beforeEach(() => {
    // No ConfirmHost is mounted, so confirmAction falls back to this.
    confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    if (!("ResizeObserver" in window)) {
      (window as any).ResizeObserver = class {
        observe() {}
        disconnect() {}
      };
    }
  });

  afterEach(() => {
    confirmSpy.mockRestore();
  });

  it("asks before discarding an unsaved recording", async () => {
    renderDialog();
    await recordOnce();

    fireEvent.click(screen.getByTestId("cast-discard"));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("cast-discard")).toBeTruthy();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByTestId("cast-discard"));
    await waitFor(() =>
      expect(screen.queryByTestId("cast-discard")).toBeNull(),
    );
    expect(status()).toMatch(/ready to record/i);
  });

  it("discards an exported recording without asking", async () => {
    // jsdom has no object URLs; the download itself is not under test.
    URL.createObjectURL = vi.fn(() => "blob:cast");
    URL.revokeObjectURL = vi.fn();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    renderDialog();
    await recordOnce();
    fireEvent.click(screen.getByTestId("cast-export"));

    fireEvent.click(screen.getByTestId("cast-discard"));
    await waitFor(() =>
      expect(screen.queryByTestId("cast-discard")).toBeNull(),
    );
    expect(confirmSpy).not.toHaveBeenCalled();
    click.mockRestore();
  });

  it("asks before a new recording replaces an unsaved one", async () => {
    renderDialog();
    await recordOnce();

    fireEvent.click(screen.getByTestId("cast-start-recording"));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("cast-recording-bar")).toBeNull();
    expect(screen.getByTestId("cast-discard")).toBeTruthy();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByTestId("cast-start-recording"));
    expect(await screen.findByTestId("cast-recording-bar")).toBeTruthy();
  });

  it("asks before an import replaces an unsaved recording", async () => {
    renderDialog();
    await recordOnce();
    const before = status();

    // Export the current recording's shape as a valid file to import.
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const { serializeCastScript, CastRecorder } = await import("../cast");
    const recorder = new CastRecorder({ title: "Imported", appVersion: "1" });
    recorder.start({
      elements: [],
      appState: fakeAPI().getAppState(),
      files: {},
    } as any);
    const text = serializeCastScript(
      recorder.stop({
        elements: [],
        appState: fakeAPI().getAppState(),
        files: {},
      } as any),
    );
    const file = new File([text], "imported.calileon-cast.json");
    Object.defineProperty(file, "text", { value: async () => text });

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(String(confirmSpy.mock.calls[0][0])).toMatch(/import/i);
    // Declined: the unsaved recording is still the one shown.
    expect(status()).toBe(before);
  });
});
