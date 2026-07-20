import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { vi } from "vitest";

import { VaultError } from "../data/vault/errors";

import { VaultShareDialog } from "./VaultShareDialog";

const vaultMock = vi.hoisted(() => ({
  createInvitation: vi.fn(),
  readSecrets: vi.fn(() => ({
    rootKey: "root-key-secret",
    invitationCapability: "current-capability-secret",
  })),
  revokeInvitation: vi.fn(),
}));

vi.mock("../data/vault", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data/vault")>()),
  createVaultShareInvitation: vaultMock.createInvitation,
  readVaultSessionSecrets: vaultMock.readSecrets,
  revokeVaultShareInvitation: vaultMock.revokeInvitation,
}));

vi.mock("@excalidraw/excalidraw/components/Dialog", () => ({
  Dialog: ({
    children,
    title,
  }: {
    children: React.ReactNode;
    title: React.ReactNode;
  }) => (
    <div role="dialog" aria-label={String(title)}>
      {children}
    </div>
  ),
}));

vi.mock("@excalidraw/excalidraw/components/Button", () => ({
  Button: ({
    children,
    onSelect,
    disabled,
  }: {
    children: React.ReactNode;
    onSelect: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onSelect} disabled={disabled}>
      {children}
    </button>
  ),
}));

vi.mock("@excalidraw/excalidraw/i18n", () => ({
  t: (key: string, replacement?: Record<string, string | number>) => {
    const value =
      {
        "buttons.close": "Close",
        "vault.share.title": "Share encrypted Vault",
        "vault.share.description": "Create Vault invitations.",
        "vault.share.bearerWarning": "Treat the complete link like a password.",
        "vault.share.role": "Invitation role",
        "vault.share.viewer": "Viewer",
        "vault.share.editor": "Editor",
        "vault.share.expiry": "Expiration",
        "vault.share.expiryNever": "No expiration",
        "vault.share.expiryDay": "24 hours",
        "vault.share.expiryWeek": "7 days",
        "vault.share.expiresAt": "Expires {{date}}",
        "vault.share.createAndCopy": "Create and copy link",
        "vault.share.creating": "Creating invitation...",
        "vault.share.createdAndCopied": "Invitation created and copied.",
        "vault.share.copied": "Invitation link copied.",
        "vault.share.createdInvitations": "Created invitations",
        "vault.share.noInvitations": "No invitations created.",
        "vault.share.copy": "Copy link",
        "vault.share.revoke": "Revoke",
        "vault.share.revoking": "Revoking...",
        "vault.share.revoked": "Revoked",
        "vault.share.errors.ownerRequired": "Only the owner can share.",
        "vault.share.errors.expired": "Access expired.",
        "vault.share.errors.revoked": "Access revoked.",
        "vault.share.errors.unavailable": "Invitation service unavailable.",
        "vault.share.errors.internal": "Invitation action failed safely.",
      }[key] ?? key;
    return value.replace(/\{\{(\w+)\}\}/g, (_, name) =>
      String(replacement?.[name] ?? ""),
    );
  },
}));

const activeVault = {
  session: {
    role: "editor",
    vaultId: "123e4567-e89b-42d3-a456-426614174000",
  },
  owner: { kind: "owner" },
} as const;

const invitationId = "123e4567-e89b-42d3-a456-426614174001";
const bearerLink = "https://app.example/#vault=complete-bearer-secret";

describe("VaultShareDialog", () => {
  beforeEach(() => {
    vaultMock.createInvitation.mockReset();
    vaultMock.readSecrets.mockClear();
    vaultMock.revokeInvitation.mockReset();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("renders nothing while closed", () => {
    const { container } = render(
      <VaultShareDialog
        open={false}
        onClose={vi.fn()}
        activeVault={activeVault as never}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("creates a viewer invitation, copies it explicitly, and keeps the bearer link out of the DOM", async () => {
    vaultMock.createInvitation.mockResolvedValue({
      link: bearerLink,
      metadata: {
        vaultId: activeVault.session.vaultId,
        invitationId,
        role: "viewer",
        authorizationVersion: 1,
        expiresAt: null,
      },
    });

    render(
      <VaultShareDialog
        open={true}
        onClose={vi.fn()}
        activeVault={activeVault as never}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Create and copy link" }),
    );

    expect(
      await screen.findByText("Invitation created and copied."),
    ).toBeInTheDocument();
    expect(vaultMock.readSecrets).toHaveBeenCalledWith(activeVault.session);
    expect(vaultMock.createInvitation).toHaveBeenCalledWith({
      owner: activeVault.owner,
      vaultId: activeVault.session.vaultId,
      rootKey: "root-key-secret",
      role: "viewer",
      expiresAt: null,
      baseUrl: window.location.href,
    });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(bearerLink);
    expect(screen.queryByText(bearerLink)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("root-key-secret");
    expect(document.body.textContent).not.toContain(
      "current-capability-secret",
    );
  });

  it("keeps secret-free metadata for re-copy and revokes the invitation", async () => {
    vaultMock.createInvitation.mockResolvedValue({
      link: bearerLink,
      metadata: {
        vaultId: activeVault.session.vaultId,
        invitationId,
        role: "editor",
        authorizationVersion: 2,
        expiresAt: null,
      },
    });
    vaultMock.revokeInvitation.mockResolvedValue({
      vaultId: activeVault.session.vaultId,
      invitationId,
      authorizationVersion: 3,
      reason: "revoked",
    });

    render(
      <VaultShareDialog
        open={true}
        onClose={vi.fn()}
        activeVault={activeVault as never}
      />,
    );

    fireEvent.change(
      screen.getByRole("combobox", { name: "Invitation role" }),
      {
        target: { value: "editor" },
      },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Create and copy link" }),
    );
    await screen.findByText("Invitation created and copied.");

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(2),
    );

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    expect(await screen.findAllByText("Revoked")).toHaveLength(2);
    expect(vaultMock.revokeInvitation).toHaveBeenCalledWith({
      owner: activeVault.owner,
      vaultId: activeVault.session.vaultId,
      invitationId,
    });
    expect(screen.getByRole("button", { name: "Copy link" })).toBeDisabled();
  });

  it("shows only a stable owner error without exposing the raw backend failure", async () => {
    vaultMock.createInvitation.mockRejectedValue(
      new VaultError(
        "VAULT_CAPABILITY_FORBIDDEN",
        "raw database owner policy details",
      ),
    );

    render(
      <VaultShareDialog
        open={true}
        onClose={vi.fn()}
        activeVault={activeVault as never}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Create and copy link" }),
    );

    expect(
      await screen.findByText("Only the owner can share."),
    ).toBeInTheDocument();
    expect(screen.getByText("VAULT_CAPABILITY_FORBIDDEN")).toBeInTheDocument();
    expect(
      screen.queryByText("raw database owner policy details"),
    ).not.toBeInTheDocument();
  });
});
