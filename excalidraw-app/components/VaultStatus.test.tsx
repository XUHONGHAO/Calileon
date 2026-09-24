import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { VaultStatus } from "./VaultStatus";

describe("VaultStatus", () => {
  it("shows encrypted editor sync state", () => {
    render(<VaultStatus role="editor" syncStatus="synced" />);
    expect(screen.getByTestId("vault-status")).toHaveTextContent(
      /Encrypted.*Editor.*Synced/i,
    );
  });

  it("distinguishes viewer and unsynced state", () => {
    render(
      <VaultStatus
        role="viewer"
        syncStatus="unsynced"
        autosaveErrorCode="VAULT_PERSISTENCE_UNAVAILABLE"
        autosaveUnsyncedReason="offline"
      />,
    );
    const status = screen.getByTestId("vault-status");
    expect(status).toHaveTextContent(/Viewer.*Not synced/i);
    expect(status).toHaveAttribute(
      "data-autosave-error-code",
      "VAULT_PERSISTENCE_UNAVAILABLE",
    );
    expect(status).toHaveAttribute("data-autosave-unsynced-reason", "offline");
  });

  it("shows a distinct branch warning for CAS conflicts", () => {
    render(
      <VaultStatus
        role="editor"
        syncStatus="unsynced"
        autosaveErrorCode="VAULT_SNAPSHOT_CONFLICT"
        autosaveUnsyncedReason="conflict"
      />,
    );
    expect(screen.getByTestId("vault-status")).toHaveTextContent(
      /Unsynced local branch needs review/i,
    );
  });

  it("exposes local persistence and before-unload state for recovery UI", () => {
    render(
      <VaultStatus
        role="editor"
        syncStatus="unsynced"
        autosaveUnsyncedReason="offline"
        autosaveLocalPersistence="local-persisted"
        autosaveBeforeUnloadState="local-persisted-unsynced"
      />,
    );
    const status = screen.getByTestId("vault-status");
    expect(status).toHaveAttribute(
      "data-autosave-local-persistence",
      "local-persisted",
    );
    expect(status).toHaveAttribute(
      "data-autosave-before-unload-state",
      "local-persisted-unsynced",
    );
  });

  it("renders recovery state, pending attachments and a conflict review action", () => {
    const onReviewConflict = vi.fn();
    render(
      <VaultStatus
        role="editor"
        syncStatus="unsynced"
        autosaveUnsyncedReason="conflict"
        recoveryState="conflict"
        attachmentPending={2}
        attachmentFailed={0}
        onReviewConflict={onReviewConflict}
      />,
    );
    const status = screen.getByTestId("vault-status");
    expect(status).toHaveAttribute("data-recovery-state", "conflict");
    expect(status).toHaveAttribute("data-attachment-pending", "2");
    expect(screen.getByTestId("vault-attachments-pending")).toHaveTextContent(
      /2/,
    );
    fireEvent.click(screen.getByTestId("vault-review-conflict"));
    expect(onReviewConflict).toHaveBeenCalledTimes(1);
  });

  it("labels offline-safe and local-saved recovery states", () => {
    const { rerender } = render(
      <VaultStatus
        role="editor"
        syncStatus="unsynced"
        recoveryState="offline-local-safe"
      />,
    );
    expect(screen.getByTestId("vault-status")).toHaveTextContent(
      /Offline-safe/i,
    );
    rerender(
      <VaultStatus
        role="editor"
        syncStatus="unsynced"
        recoveryState="local-restored"
      />,
    );
    expect(screen.getByTestId("vault-status")).toHaveTextContent(
      /Saved on this device/i,
    );
  });
});
