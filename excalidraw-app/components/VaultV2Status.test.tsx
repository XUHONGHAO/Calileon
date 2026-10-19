import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { VaultV2Status } from "./VaultV2Status";

import type { VaultV2UiState } from "../data/vault/v2/uiState";

const state = (patch: Partial<VaultV2UiState> = {}): VaultV2UiState => ({
  status: "synced",
  blockedCode: null,
  localSafe: true,
  attachmentPending: 0,
  attachmentFailed: 0,
  attachmentFailure: null,
  conflictElementIds: [],
  ...patch,
});

describe("VaultV2Status (W6)", () => {
  it("shows encrypted role and sync state", () => {
    render(<VaultV2Status role="editor" state={state()} />);
    const pill = screen.getByTestId("vault-v2-status");
    expect(pill).toHaveTextContent(/Encrypted.*Editor.*Synced/);
    expect(pill).toHaveClass("VaultStatus--synced");
  });

  it("tells offline-safe from offline without a local copy", () => {
    const { rerender } = render(
      <VaultV2Status role="editor" state={state({ status: "offline" })} />,
    );
    expect(screen.getByTestId("vault-v2-status")).toHaveTextContent(
      /Offline-safe/,
    );
    expect(screen.getByTestId("vault-v2-status")).toHaveClass(
      "VaultStatus--local",
    );
    rerender(
      <VaultV2Status
        role="editor"
        state={state({ status: "offline", localSafe: false })}
      />,
    );
    expect(screen.getByTestId("vault-v2-status")).toHaveTextContent(
      /Not synced/,
    );
    expect(screen.getByTestId("vault-v2-status")).toHaveClass(
      "VaultStatus--unsynced",
    );
  });

  it("names revoked access when blocked", () => {
    render(
      <VaultV2Status
        role="viewer"
        state={state({
          status: "blocked",
          blockedCode: "VAULT_CAPABILITY_REVOKED",
        })}
      />,
    );
    const pill = screen.getByTestId("vault-v2-status");
    expect(pill).toHaveTextContent(/Viewer.*Revoked/i);
    expect(pill).toHaveClass("VaultStatus--revoked");
  });

  it("separates retrying uploads from uploads that need the user", () => {
    const { rerender } = render(
      <VaultV2Status
        role="editor"
        state={state({ attachmentFailed: 2, attachmentFailure: "retry" })}
      />,
    );
    expect(screen.getByTestId("vault-attachments-failed")).toHaveTextContent(
      /retrying automatically/,
    );
    rerender(
      <VaultV2Status
        role="editor"
        state={state({ attachmentFailed: 1, attachmentFailure: "action" })}
      />,
    );
    expect(screen.getByTestId("vault-attachments-failed")).toHaveTextContent(
      /could not be uploaded/,
    );
  });

  it("lists concurrent edits and selects them on demand", () => {
    const onShow = vi.fn();
    render(
      <VaultV2Status
        role="editor"
        state={state({ conflictElementIds: ["a", "b"] })}
        onShowConflicts={onShow}
      />,
    );
    expect(screen.getByTestId("vault-v2-conflicts")).toHaveTextContent(
      /2 element\(s\) edited at the same time/,
    );
    fireEvent.click(screen.getByTestId("vault-v2-show-conflicts"));
    expect(onShow).toHaveBeenCalledWith(["a", "b"]);
  });
});
