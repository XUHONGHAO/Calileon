import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { describe, expect, it, vi } from "vitest";

import { VaultError } from "../data/vault/errors";

import { VaultMigrationControl } from "./VaultMigrationControl";

import type { VaultMigrationApi } from "./VaultMigrationControl";

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

const NEW_LINK = "https://calileon.com/#vault=2&id=x&key=y&cap=z";

const api = (overrides: Partial<VaultMigrationApi> = {}) => ({
  readMigratedLink: vi.fn(async () => null as string | null),
  migrate: vi.fn(async () => NEW_LINK),
  onMigrated: vi.fn(),
  ...overrides,
});

const startButton = () => screen.findByRole("button", { name: /Vault v2/ });

describe("VaultMigrationControl (P4c W4)", () => {
  it("offers editors the move and switches the old Vault to read-only after it", async () => {
    const control = api();
    render(<VaultMigrationControl role="editor" api={control} />);
    fireEvent.click(await startButton());
    expect(screen.getByTestId("vault-migration")).toBeTruthy();
    expect(control.migrate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Create Vault v2" }));
    await screen.findByTestId("vault-migration-done");
    expect(control.migrate).toHaveBeenCalledTimes(1);
    expect(control.onMigrated).toHaveBeenCalledTimes(1);
    expect(
      screen.getByTestId("vault-migration-banner").querySelector("a")!.href,
    ).toBe(NEW_LINK);
  });

  it("shows an already migrated Vault as read-only with the new link", async () => {
    const control = api({ readMigratedLink: vi.fn(async () => NEW_LINK) });
    render(<VaultMigrationControl role="viewer" api={control} />);
    await screen.findByTestId("vault-migration-banner");
    expect(control.onMigrated).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("vault-migration-done")).toBeNull();
  });

  it("hides the entry from viewers", async () => {
    const control = api();
    render(<VaultMigrationControl role="viewer" api={control} />);
    await waitFor(() => expect(control.readMigratedLink).toHaveBeenCalled());
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("explains a refusal, keeps the old Vault editable and allows a retry", async () => {
    const control = api({
      migrate: vi
        .fn()
        .mockRejectedValueOnce(
          new VaultError("VAULT_PROTOCOL_UNSUPPORTED", "images"),
        )
        .mockResolvedValueOnce(NEW_LINK),
    });
    render(<VaultMigrationControl role="editor" api={control} />);
    fireEvent.click(await startButton());
    fireEvent.click(screen.getByRole("button", { name: "Create Vault v2" }));
    expect(
      (await screen.findByTestId("vault-migration-error")).textContent,
    ).toMatch(/cannot store/);
    expect(control.onMigrated).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByTestId("vault-migration-done");
    expect(control.onMigrated).toHaveBeenCalledTimes(1);
  });

  it("treats an unreadable journal as not migrated", async () => {
    const control = api({
      readMigratedLink: vi.fn(async () => {
        throw new VaultError("VAULT_DECRYPT_FAILED", "x");
      }),
    });
    render(<VaultMigrationControl role="editor" api={control} />);
    expect(await startButton()).toBeTruthy();
    expect(control.onMigrated).not.toHaveBeenCalled();
  });
});
