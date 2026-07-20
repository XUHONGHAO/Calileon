import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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
});
