import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { SynesthesiaDialog } from "./SynesthesiaDialog";

import type { MockInstance } from "vitest";

vi.mock("@excalidraw/excalidraw", () => ({
  CaptureUpdateAction: { NEVER: "NEVER", IMMEDIATELY: "IMMEDIATELY" },
  convertToExcalidrawElements: (elements: unknown) => elements,
  ExcalidrawAPIProvider: ({ children }: { children: React.ReactNode }) =>
    children,
  Excalidraw: () => <div />,
}));
vi.mock("@excalidraw/excalidraw/components/Dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@excalidraw/excalidraw/i18n", () => ({
  t: (key: string) => key,
  getLanguage: () => ({ code: "en" }),
}));
// A session that finishes at once with one element, and a canvas write that
// keeps failing: the artwork stays pending.
vi.mock("./session", () => ({
  commitArtwork: () => {
    throw new Error("canvas refused");
  },
  SynesthesiaSession: class {
    constructor(
      private options: {
        finish: (elements: unknown[], reason: string) => void;
      },
    ) {}
    async start() {
      this.options.finish([{ id: "art" }], "completed");
    }
    stop() {}
  },
}));

const api = {
  getAppState: () => ({
    width: 1000,
    height: 800,
    zoom: { value: 1 },
    scrollX: 0,
    scrollY: 0,
    theme: "light",
    viewBackgroundColor: "#fff",
  }),
} as unknown as ExcalidrawImperativeAPI;

describe("Synesthesia dialog with artwork that could not be inserted", () => {
  let confirmSpy: MockInstance<typeof window.confirm>;

  beforeEach(() => {
    // No ConfirmHost is mounted, so confirmAction falls back to this.
    confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
  });

  afterEach(() => confirmSpy.mockRestore());

  it("asks before discarding it on close, and closes once confirmed", async () => {
    const onClose = vi.fn();
    render(<SynesthesiaDialog api={api} onClose={onClose} />);
    fireEvent.click(
      screen.getByRole("button", { name: "labs.synesthesia.start" }),
    );
    expect(
      await screen.findByRole("button", { name: "labs.synesthesia.retry" }),
    ).toBeTruthy();

    const close = screen.getByRole("button", { name: "buttons.close" });
    fireEvent.click(close);
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(confirmSpy.mock.calls[0][0]).toBe("labs.synesthesia.discardPending");
    expect(onClose).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(close);
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it("Escape takes the same guarded path", async () => {
    const onClose = vi.fn();
    confirmSpy.mockReturnValue(true);
    render(<SynesthesiaDialog api={api} onClose={onClose} />);
    fireEvent.click(
      screen.getByRole("button", { name: "labs.synesthesia.start" }),
    );
    await screen.findByRole("button", { name: "labs.synesthesia.retry" });

    fireEvent.keyDown(
      screen.getByRole("button", { name: "labs.synesthesia.retry" }),
      { key: "Escape" },
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
  });
});
