import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { vi } from "vitest";

import { VaultError } from "../data/vault/errors";

import { VaultDependencyDialog } from "./VaultDependencyDialog";

const vaultMock = vi.hoisted(() => ({
  assertConfig: vi.fn(),
  createRooms: vi.fn(() => ({ kind: "rooms" })),
  createVault: vi.fn(),
  createTransport: vi.fn(() => ({ kind: "transport" })),
  discover: vi.fn(),
  readConfig: vi.fn(() => ({
    enabled: true,
    persistenceCapabilitiesUrl:
      "https://vault.example/.well-known/vault-capabilities",
    roomCapabilitiesUrl: "https://room.example/.well-known/vault-capabilities",
    roomProvisionUrl: "https://room.example/vault/rooms",
  })),
}));

const cloudMock = vi.hoisted(() => ({
  createBackend: vi.fn(() => ({ owner: { kind: "owner" } })),
}));

vi.mock("../data/vault", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data/vault")>()),
  assertVaultClientConfig: vaultMock.assertConfig,
  createHttpVaultRoomProvisionTransport: vaultMock.createRooms,
  createVault: vaultMock.createVault,
  createHttpVaultDeploymentDiscoveryTransport: vaultMock.createTransport,
  discoverVaultDeployment: vaultMock.discover,
  readVaultClientConfig: vaultMock.readConfig,
}));

vi.mock("../data/cloud", () => ({
  createSupabaseVaultBackend: cloudMock.createBackend,
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
  t: (key: string) =>
    ({
      "buttons.close": "Close",
      "vault.dependency.title": "Vault dependency check",
      "vault.dependency.description": "Checks dependencies before creation.",
      "vault.dependency.checking": "Checking dependencies...",
      "vault.dependency.ready": "Dependencies are ready.",
      "vault.dependency.retry": "Check again",
      "vault.dependency.errors.roomUnavailable":
        "Secure room service unavailable.",
      "vault.dependency.errors.internal": "Dependencies could not be checked.",
      "vault.creation.emptyNotice": "The current whiteboard is not uploaded.",
      "vault.creation.signInRequired": "Sign in before creating.",
      "vault.creation.signIn": "Sign in",
      "vault.creation.create": "Create empty Vault",
      "vault.creation.creating": "Creating...",
      "vault.creation.error": "Vault creation failed safely.",
    }[key] ?? key),
}));

describe("VaultDependencyDialog", () => {
  beforeEach(() => {
    vaultMock.assertConfig.mockReset();
    vaultMock.createRooms.mockClear();
    vaultMock.createVault.mockReset();
    vaultMock.createTransport.mockClear();
    vaultMock.discover.mockReset();
    vaultMock.readConfig.mockClear();
    cloudMock.createBackend.mockClear();
  });

  it("renders nothing while closed", () => {
    const { container } = render(
      <VaultDependencyDialog
        open={false}
        onClose={vi.fn()}
        canCreate={false}
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(vaultMock.readConfig).not.toHaveBeenCalled();
  });

  it("asserts the config and discovers both dependencies without creating a Vault", async () => {
    vaultMock.discover.mockResolvedValue({ ready: {}, capabilities: {} });

    render(
      <VaultDependencyDialog open={true} onClose={vi.fn()} canCreate={false} />,
    );

    expect(screen.getByText("Checking dependencies...")).toBeInTheDocument();
    expect(
      await screen.findByText("Dependencies are ready."),
    ).toBeInTheDocument();
    expect(vaultMock.assertConfig).toHaveBeenCalledWith(
      vaultMock.readConfig.mock.results[0].value,
    );
    expect(vaultMock.createTransport).toHaveBeenCalledWith({
      persistenceCapabilitiesUrl:
        "https://vault.example/.well-known/vault-capabilities",
      roomCapabilitiesUrl:
        "https://room.example/.well-known/vault-capabilities",
    });
    expect(vaultMock.discover).toHaveBeenCalledWith({ kind: "transport" });
    expect(screen.getByText("Sign in before creating.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create empty Vault" }),
    ).not.toBeInTheDocument();
  });

  it("creates only an empty Vault after dependency readiness and signed-in authorization", async () => {
    const ready = { kind: "ready" };
    const onClose = vi.fn();
    const onCreated = vi.fn();
    vaultMock.discover.mockResolvedValue({ ready, capabilities: {} });
    vaultMock.createVault.mockResolvedValue({
      vaultId: "123e4567-e89b-42d3-a456-426614174000",
      invitationId: "123e4567-e89b-42d3-a456-426614174001",
      activeRoomId: "room_1234567890123456",
      editorLink: "https://app.example/#vault=bearer-secret",
    });

    render(
      <VaultDependencyDialog
        open={true}
        onClose={onClose}
        canCreate={true}
        onCreated={onCreated}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Create empty Vault" }),
    );

    await waitFor(() => expect(vaultMock.createVault).toHaveBeenCalledTimes(1));
    expect(cloudMock.createBackend).toHaveBeenCalledWith(ready);
    expect(vaultMock.createRooms).toHaveBeenCalledWith({
      provisionUrl: "https://room.example/vault/rooms",
    });
    expect(vaultMock.createVault).toHaveBeenCalledWith({
      deployment: ready,
      owner: { kind: "owner" },
      rooms: { kind: "rooms" },
      baseUrl: window.location.href,
    });
    expect(onCreated).toHaveBeenCalledWith(
      "https://app.example/#vault=bearer-secret",
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(
      onCreated.mock.invocationCallOrder[0],
    );
  });

  it("routes signed-out users to the existing account UI without creating", async () => {
    const onSignIn = vi.fn();
    vaultMock.discover.mockResolvedValue({ ready: {}, capabilities: {} });

    render(
      <VaultDependencyDialog
        open={true}
        onClose={vi.fn()}
        canCreate={false}
        onSignIn={onSignIn}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));

    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(vaultMock.createVault).not.toHaveBeenCalled();
  });

  it("shows only a stable Vault error and can retry", async () => {
    vaultMock.discover
      .mockRejectedValueOnce(
        new VaultError(
          "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
          "raw upstream room failure",
        ),
      )
      .mockResolvedValueOnce({ ready: {}, capabilities: {} });

    render(
      <VaultDependencyDialog open={true} onClose={vi.fn()} canCreate={false} />,
    );

    expect(
      await screen.findByText("Secure room service unavailable."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("VAULT_ROOM_PROTOCOL_UNSUPPORTED"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("raw upstream room failure"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));

    await waitFor(() => expect(vaultMock.discover).toHaveBeenCalledTimes(2));
    expect(
      await screen.findByText("Dependencies are ready."),
    ).toBeInTheDocument();
  });
});
