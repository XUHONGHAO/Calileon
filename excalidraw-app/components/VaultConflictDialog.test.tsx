import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { VaultConflictDialog } from "./VaultConflictDialog";

vi.mock("@excalidraw/excalidraw/components/Dialog", () => ({
  Dialog: ({
    children,
    title,
  }: {
    children: React.ReactNode;
    title: string;
  }) => (
    <div data-testid="dialog">
      <h2>{title}</h2>
      {children}
    </div>
  ),
}));

const conflict = {
  localUpdateId: "123e4567-e89b-42d3-a456-426614174000",
  localGeneration: 5,
  remoteGeneration: 6,
  conflictReason: "generation",
};

describe("VaultConflictDialog", () => {
  it("offers only non-destructive options and never claims a merge", () => {
    const onClose = vi.fn();
    render(
      <VaultConflictDialog
        open
        conflict={conflict}
        onClose={onClose}
        onExportLocal={vi.fn()}
      />,
    );
    const dialog = screen.getByTestId("vault-conflict-dialog");
    expect(
      screen.getByText(/Unsynced local branch needs review/i),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("vault-conflict-local-generation"),
    ).toHaveTextContent("5");
    expect(
      screen.getByTestId("vault-conflict-remote-generation"),
    ).toHaveTextContent("6");
    expect(dialog.textContent ?? "").not.toMatch(
      /automatic merge|auto-merge|CRDT|converge/i,
    );

    fireEvent.click(screen.getByText("Keep local version"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("reveals remote metadata and exports a local recovery copy", async () => {
    const onExportLocal = vi.fn().mockResolvedValue(undefined);
    render(
      <VaultConflictDialog
        open
        conflict={{ ...conflict, remoteGeneration: null }}
        onClose={vi.fn()}
        onExportLocal={onExportLocal}
      />,
    );

    fireEvent.click(screen.getByText("View remote version"));
    expect(screen.getByTestId("vault-conflict-remote")).toHaveTextContent(
      /Unavailable/i,
    );

    fireEvent.click(screen.getByText("Export local recovery copy"));
    await waitFor(() => expect(onExportLocal).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByTestId("vault-conflict-export-done"),
    ).toBeInTheDocument();
  });

  it("reports an export failure without closing the dialog", async () => {
    const onClose = vi.fn();
    render(
      <VaultConflictDialog
        open
        conflict={conflict}
        onClose={onClose}
        onExportLocal={vi.fn().mockRejectedValue(new Error("nope"))}
      />,
    );
    fireEvent.click(screen.getByText("Export local recovery copy"));
    expect(
      await screen.findByTestId("vault-conflict-export-error"),
    ).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders nothing when closed", () => {
    render(
      <VaultConflictDialog
        open={false}
        conflict={null}
        onClose={vi.fn()}
        onExportLocal={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("vault-conflict-dialog")).toBeNull();
  });
});
