import { getDefaultAppState } from "@excalidraw/excalidraw/appState";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  initializeScene,
  isVaultExternalFeatureDisabled,
  openVaultSceneFromLink,
  prepareVaultAutosaveSnapshot,
  reconcileVaultAutosaveSnapshots,
  recoverVaultAfterRoomReconnect,
  type VaultSceneRouteDependencies,
} from "../App";
import { VaultError } from "../data/vault/errors";

const vaultId = "123e4567-e89b-42d3-a456-426614174000";
const rootKey = "A".repeat(43);
const capability = `${"B".repeat(42)}A`;

describe("Vault route isolation", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("disables every external feature for both a Vault route and an active Vault", () => {
    window.history.replaceState({}, "", "/");
    expect(isVaultExternalFeatureDisabled(null)).toBe(false);

    window.history.replaceState(
      {},
      "",
      `/#vault=1&id=${vaultId}&key=${rootKey}&cap=${capability}`,
    );
    expect(isVaultExternalFeatureDisabled(null)).toBe(true);

    window.history.replaceState({}, "", "/");
    expect(isVaultExternalFeatureDisabled({} as never)).toBe(true);
  });

  it("opens a valid Vault snapshot before ordinary local or room fallback", async () => {
    localStorage.setItem(
      "excalidraw",
      JSON.stringify({
        elements: [
          {
            id: "local-plaintext",
            type: "text",
            text: "P4-PLAINTEXT-SENTINEL-20260713",
          },
        ],
      }),
    );
    const startCollaboration = vi.fn();
    window.history.replaceState(
      {},
      "",
      `/#vault=1&id=${vaultId}&key=${rootKey}&cap=${capability}`,
    );

    const calls: string[] = [];
    const persistence = {} as never;
    const owner = {} as never;
    const dependencies: VaultSceneRouteDependencies = {
      readConfig: () => {
        calls.push("config");
        return {
          enabled: true,
          persistenceCapabilitiesUrl: "https://vault.example/capabilities",
          roomCapabilitiesUrl: "https://room.example/capabilities",
          roomProvisionUrl: "https://room.example/vault/rooms",
        };
      },
      createDiscoveryTransport: () => {
        calls.push("transport");
        return {} as never;
      },
      discover: async () => {
        calls.push("discovery");
        return { ready: {} as never };
      },
      createBackend: () => {
        calls.push("backend");
        return { owner, persistence } as never;
      },
      open: async () => {
        calls.push("open");
        return {
          session: { role: "viewer" } as never,
          snapshot: {
            elements: [],
            appState: { viewModeEnabled: false },
            files: {},
          },
          generation: 4,
          isEmpty: false,
          syncStatus: "synced",
        };
      },
    };

    const result = await initializeScene({
      collabAPI: { startCollaboration } as never,
      excalidrawAPI: {} as never,
      openVaultRoute: (link) => openVaultSceneFromLink(link, dependencies),
    });

    expect(calls).toEqual([
      "config",
      "transport",
      "discovery",
      "backend",
      "open",
    ]);
    expect(result.isExternalScene).toBe(true);
    expect(result.id).toBe(vaultId);
    expect(result.key).toBe("");
    expect(result.scene?.elements).toEqual([]);
    expect(result.scene?.appState?.viewModeEnabled).toBe(true);
    expect(result.scene?.appState?.errorMessage).toBeNull();
    expect(result.activeVault).toMatchObject({
      generation: 4,
      owner,
      persistence,
    });
    expect(JSON.stringify(result)).not.toContain(
      "P4-PLAINTEXT-SENTINEL-20260713",
    );
    expect(startCollaboration).not.toHaveBeenCalled();
  });

  it("shows a stable decrypt error and never loads local plaintext", async () => {
    localStorage.setItem(
      "excalidraw",
      JSON.stringify({
        elements: [
          {
            id: "local-plaintext",
            type: "text",
            text: "P4-PLAINTEXT-SENTINEL-20260719",
          },
        ],
      }),
    );
    const startCollaboration = vi.fn();
    window.history.replaceState(
      {},
      "",
      `/#vault=1&id=${vaultId}&key=${rootKey}&cap=${capability}`,
    );

    const result = await initializeScene({
      collabAPI: { startCollaboration } as never,
      excalidrawAPI: {} as never,
      openVaultRoute: async () => {
        throw new VaultError(
          "VAULT_DECRYPT_FAILED",
          "The supplied Vault key cannot authenticate the ciphertext.",
        );
      },
    });

    expect(result.isExternalScene).toBe(true);
    expect(result.id).toBe(vaultId);
    expect(result.key).toBe("");
    expect(result.scene?.elements).toEqual([]);
    expect(result.scene?.appState?.viewModeEnabled).toBe(true);
    expect(result.scene?.appState?.errorMessage).toContain(
      "VAULT_DECRYPT_FAILED",
    );
    expect(JSON.stringify(result)).not.toContain(
      "P4-PLAINTEXT-SENTINEL-20260719",
    );
    expect(startCollaboration).not.toHaveBeenCalled();
  });

  it("blocks an invalid decrypted scene instead of restoring partial data", async () => {
    window.history.replaceState(
      {},
      "",
      `/#vault=1&id=${vaultId}&key=${rootKey}&cap=${capability}`,
    );

    const result = await initializeScene({
      collabAPI: null,
      excalidrawAPI: {} as never,
      openVaultRoute: async (link) =>
        await openVaultSceneFromLink(link, {
          readConfig: () => ({
            enabled: true,
            persistenceCapabilitiesUrl: "https://vault.example/capabilities",
            roomCapabilitiesUrl: "https://room.example/capabilities",
            roomProvisionUrl: "https://room.example/vault/rooms",
          }),
          createDiscoveryTransport: () => ({} as never),
          discover: async () => ({ ready: {} as never }),
          createBackend: () => ({ persistence: {} } as never),
          open: async () => ({
            session: { role: "editor" } as never,
            snapshot: {
              elements: [{ id: "partial-only" }],
              appState: {},
              files: {},
            },
            generation: 1,
            isEmpty: false,
            syncStatus: "synced",
          }),
        }),
    });

    expect(result.scene?.elements).toEqual([]);
    expect(result.scene?.appState?.viewModeEnabled).toBe(true);
    expect(result.scene?.appState?.errorMessage).toContain("Vault");
    expect(result.activeVault).toBeUndefined();
  });

  it("fails closed for a malformed Vault marker", async () => {
    const startCollaboration = vi.fn();
    window.history.replaceState({}, "", `/#vault=1&id=${vaultId}`);

    const result = await initializeScene({
      collabAPI: { startCollaboration } as never,
      excalidrawAPI: {} as never,
    });

    expect(result.isExternalScene).toBe(true);
    expect(result.id).toBe("vault");
    expect(result.scene?.elements).toEqual([]);
    expect(result.scene?.appState?.viewModeEnabled).toBe(true);
    expect(startCollaboration).not.toHaveBeenCalled();
  });

  it("does not reschedule an unchanged Vault snapshot on parent rerenders", () => {
    const elements = [] as never;
    const appState = { viewModeEnabled: false } as never;
    const files = {};
    const first = prepareVaultAutosaveSnapshot(null, elements, appState, files);

    expect(first).not.toBeNull();
    expect(Object.keys(JSON.parse(first!.serializedSnapshot))).toEqual([
      "elements",
      "appState",
      "files",
    ]);
    expect(first!.serializedSnapshot).not.toContain('"type":"excalidraw"');
    expect(
      prepareVaultAutosaveSnapshot(
        first!.serializedSnapshot,
        elements,
        appState,
        files,
      ),
    ).toBeNull();
    expect(
      prepareVaultAutosaveSnapshot(
        first!.serializedSnapshot,
        [{ id: "changed", type: "rectangle" }] as never,
        appState,
        files,
      ),
    ).not.toBeNull();
  });

  it("reloads from durable Vault state after room reconnect", async () => {
    const calls: string[] = [];
    const autosave = {
      flush: vi.fn(async () => {
        calls.push("flush");
        return {
          status: "synced",
          generation: 2,
          hasPendingChanges: false,
          unsyncedReason: null,
          errorCode: null,
        } as const;
      }),
    };

    await recoverVaultAfterRoomReconnect(autosave, () => calls.push("reload"));

    expect(calls).toEqual(["flush", "reload"]);
  });

  it("fails closed instead of reloading with pending Vault changes", async () => {
    const reload = vi.fn();
    const autosave = {
      flush: vi.fn(
        async () =>
          ({
            status: "unsynced",
            generation: 2,
            hasPendingChanges: true,
            unsyncedReason: "error",
            errorCode: "VAULT_PERSISTENCE_UNAVAILABLE",
          } as const),
      ),
    };

    await expect(
      recoverVaultAfterRoomReconnect(autosave, reload),
    ).rejects.toMatchObject({ code: "VAULT_PERSISTENCE_UNAVAILABLE" });
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads a viewer after room reconnect without a write path", async () => {
    const reload = vi.fn();

    await recoverVaultAfterRoomReconnect(null, reload);

    expect(reload).toHaveBeenCalledOnce();
  });

  it("reconciles conflicting Vault snapshots without adopting remote UI state", () => {
    const merged = reconcileVaultAutosaveSnapshots(
      {
        elements: [],
        appState: { theme: "dark" },
        files: { local: { id: "local" } } as never,
      },
      {
        elements: [],
        appState: { theme: "light", viewModeEnabled: true },
        files: { remote: { id: "remote" } } as never,
      },
      getDefaultAppState() as never,
    );

    expect(merged.elements).toEqual([]);
    expect(merged.appState).toEqual({ theme: "dark" });
    expect(Object.keys(merged.files).sort()).toEqual(["local", "remote"]);
  });
});
