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

  it("styles the status after the recovery label, not the raw snapshot status", () => {
    // Snapshot confirmed but an attachment still uploading: label says Syncing.
    const { rerender } = render(
      <VaultStatus
        role="editor"
        syncStatus="synced"
        recoveryState="syncing"
        attachmentPending={1}
      />,
    );
    const status = screen.getByTestId("vault-status");
    expect(status).toHaveTextContent(/Syncing/i);
    expect(status).toHaveClass("VaultStatus--syncing");
    expect(status).toHaveClass("UiStatusPill--info");
    expect(status).not.toHaveClass("VaultStatus--synced");
    expect(status).toHaveAttribute("data-sync-status", "synced");

    // Reloaded with a resumable upload: snapshot unsynced, label Syncing.
    rerender(
      <VaultStatus
        role="editor"
        syncStatus="unsynced"
        recoveryState="syncing"
        attachmentPending={1}
      />,
    );
    expect(status).toHaveClass("VaultStatus--syncing");
    expect(status).not.toHaveClass("VaultStatus--unsynced");

    rerender(
      <VaultStatus role="editor" syncStatus="unsynced" recoveryState="error" />,
    );
    expect(status).toHaveTextContent(/Not synced/i);
    expect(status).toHaveClass("VaultStatus--unsynced");
    expect(status).toHaveClass("UiStatusPill--danger");

    // Terminal session states keep their own styling.
    rerender(
      <VaultStatus
        role="editor"
        syncStatus="expired"
        recoveryState="blocked"
      />,
    );
    expect(status).toHaveClass("VaultStatus--expired");
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
    // Safe on this device is not styled as a failure.
    expect(screen.getByTestId("vault-status")).toHaveClass(
      "VaultStatus--local",
      "UiStatusPill--warning",
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

  it("labels a lost realtime link as not synced with a reload hint", () => {
    render(
      <VaultStatus
        role="editor"
        syncStatus="unsynced"
        recoveryState="realtime-lost"
      />,
    );
    const status = screen.getByTestId("vault-status");
    expect(status).toHaveTextContent(/Not synced.*Realtime connection lost/i);
    expect(status).toHaveTextContent(/reload/i);
    expect(status).not.toHaveTextContent(/Syncing/i);
    expect(status).toHaveClass("VaultStatus--unsynced");
  });

  it("exposes non-secret realtime-loss diagnostics", () => {
    render(
      <VaultStatus
        role="editor"
        syncStatus="unsynced"
        recoveryState="realtime-lost"
        realtimeLostReason="teardown>join-failed"
        realtimeLostCode="VAULT_PERSISTENCE_UNAVAILABLE"
      />,
    );
    const status = screen.getByTestId("vault-status");
    expect(status).toHaveAttribute(
      "data-realtime-lost-reason",
      "teardown>join-failed",
    );
    expect(status).toHaveAttribute(
      "data-realtime-lost-code",
      "VAULT_PERSISTENCE_UNAVAILABLE",
    );
  });
});
