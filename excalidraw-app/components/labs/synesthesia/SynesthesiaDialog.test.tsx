import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { SynesthesiaDialog } from "./SynesthesiaDialog";

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
vi.mock("./audio", () => ({
  MAX_FILE_SIZE: 50 * 1024 * 1024,
  openAudio: vi
    .fn()
    .mockRejectedValue(new DOMException("denied", "NotAllowedError")),
}));

describe("Synesthesia dialog", () => {
  it("reports permission rejection and restores the start control", async () => {
    const api = {
      getAppState: () => ({
        width: 1000,
        height: 800,
        zoom: { value: 1 },
        scrollX: 0,
        scrollY: 0,
        theme: "light",
      }),
      getSceneElementsIncludingDeleted: () => [],
    } as unknown as ExcalidrawImperativeAPI;
    render(<SynesthesiaDialog api={api} onClose={vi.fn()} />);
    fireEvent.click(
      screen.getByRole("button", { name: "labs.synesthesia.start" }),
    );
    await waitFor(() =>
      expect(
        screen.getByText("labs.synesthesia.permission").textContent,
      ).toContain("labs.synesthesia.permission"),
    );
    expect(
      screen.getByRole("button", { name: "labs.synesthesia.start" }),
    ).not.toBeDisabled();
  });
});
