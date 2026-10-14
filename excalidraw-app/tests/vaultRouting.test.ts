import { getDefaultAppState } from "@excalidraw/excalidraw/appState";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyVaultRealtimeStatus,
  deriveActiveVaultRecoveryState,
  getVaultRealtimeTeardownStatus,
  getVaultRecoveryBlockedCode,
  initializeScene,
  isVaultExternalFeatureDisabled,
  openVaultSceneFromLink,
  prepareVaultAutosaveSnapshot,
  reconcileVaultAutosaveSnapshots,
  recoverVaultAfterRoomReconnect,
  type VaultSceneRouteDependencies,
} from "../App";
import { VaultError } from "../data/vault/errors";
import { VaultLocalStore } from "../data/vault/local-store";

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

  it("tells the user local storage is unavailable when IndexedDB cannot open", async () => {
    window.history.replaceState(
      {},
      "",
      `/#vault=1&id=${vaultId}&key=${rootKey}&cap=${capability}`,
    );
    const open = vi.fn();
    const throwingIndexedDb = {
      open: () => {
        throw new DOMException("IndexedDB disabled", "InvalidStateError");
      },
    } as unknown as IDBFactory;

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
          open,
          openLocalStore: () =>
            VaultLocalStore.open({ indexedDB: throwingIndexedDb }),
        }),
    });

    expect(open).not.toHaveBeenCalled();
    expect(result.scene?.elements).toEqual([]);
    expect(result.scene?.appState?.viewModeEnabled).toBe(true);
    expect(result.scene?.appState?.errorMessage).toContain(
      "VAULT_LOCAL_STORAGE_UNAVAILABLE",
    );
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

describe("Vault recovery derivation", () => {
  const baseVault = {
    session: { role: "editor" } as never,
    syncStatus: "synced" as const,
    autosaveUnsyncedReason: null,
    autosaveErrorCode: null,
    autosaveLocalPersistence: "remote-confirmed" as const,
    localStore: {} as never,
    attachmentPending: 0,
    attachmentFailed: 0,
  };

  // A viewer never gets a local store or autosave state (open.ts drops it).
  const viewerVault = {
    ...baseVault,
    session: { role: "viewer" } as never,
    autosaveLocalPersistence: undefined,
    localStore: undefined,
  };

  it("reports a synced viewer without local storage as synced", () => {
    expect(deriveActiveVaultRecoveryState(viewerVault, true)).toBe("synced");
    expect(
      deriveActiveVaultRecoveryState(
        { ...viewerVault, syncStatus: "syncing" },
        true,
      ),
    ).toBe("syncing");
    // A viewer whose realtime link dropped is still honestly not synced.
    expect(
      deriveActiveVaultRecoveryState(
        { ...viewerVault, syncStatus: "unsynced" },
        true,
      ),
    ).toBe("error");
    expect(
      deriveActiveVaultRecoveryState(
        { ...viewerVault, syncStatus: "unsynced", realtimeAvailable: false },
        true,
      ),
    ).toBe("realtime-lost");
    // An editor without IndexedDB must still never be presented as synced.
    expect(
      deriveActiveVaultRecoveryState(
        {
          ...baseVault,
          localStore: undefined,
          autosaveLocalPersistence: undefined,
        },
        true,
      ),
    ).toBe("error");
  });

  it("maps revoked, expired and closed sessions to fail-closed blocked codes", () => {
    expect(
      getVaultRecoveryBlockedCode({
        syncStatus: "revoked",
        autosaveErrorCode: null,
      }),
    ).toBe("VAULT_CAPABILITY_REVOKED");
    expect(
      getVaultRecoveryBlockedCode({
        syncStatus: "expired",
        autosaveErrorCode: null,
      }),
    ).toBe("VAULT_CAPABILITY_EXPIRED");
    expect(
      getVaultRecoveryBlockedCode({
        syncStatus: "closed",
        autosaveErrorCode: null,
      }),
    ).toBe("VAULT_CAPABILITY_FORBIDDEN");
    expect(
      getVaultRecoveryBlockedCode({
        syncStatus: "unsynced",
        autosaveErrorCode: "VAULT_SNAPSHOT_CONFLICT",
      }),
    ).toBe("VAULT_SNAPSHOT_CONFLICT");
  });

  it("derives offline-safe only with a persisted local copy and IndexedDB", () => {
    expect(deriveActiveVaultRecoveryState(baseVault, true)).toBe("synced");
    const offline = {
      ...baseVault,
      syncStatus: "unsynced" as const,
      autosaveUnsyncedReason: "offline" as const,
      autosaveErrorCode: "VAULT_PERSISTENCE_UNAVAILABLE" as const,
      autosaveLocalPersistence: "local-persisted" as const,
    };
    expect(deriveActiveVaultRecoveryState(offline, false)).toBe(
      "offline-local-safe",
    );
    expect(
      deriveActiveVaultRecoveryState(
        { ...offline, localStore: undefined },
        false,
      ),
    ).toBe("error");
  });

  it("reports an editor whose realtime link dropped as realtime-lost", () => {
    // The autosave keeps reporting remote-confirmed, but the room link is gone;
    // previously this fell through to "syncing" indefinitely.
    const lost = {
      ...baseVault,
      syncStatus: "unsynced" as const,
      realtimeAvailable: false,
    };
    expect(deriveActiveVaultRecoveryState(lost, true)).toBe("realtime-lost");
    expect(
      deriveActiveVaultRecoveryState(
        { ...lost, realtimeAvailable: true },
        true,
      ),
    ).toBe("syncing");
  });

  it("only presents fail-closed teardown codes as revoked or expired", () => {
    expect(getVaultRealtimeTeardownStatus("VAULT_CAPABILITY_EXPIRED")).toBe(
      "expired",
    );
    expect(getVaultRealtimeTeardownStatus("VAULT_CAPABILITY_REVOKED")).toBe(
      "revoked",
    );
    expect(getVaultRealtimeTeardownStatus("VAULT_DECRYPT_FAILED")).toBe(
      "revoked",
    );
    // An admission timeout is a lost link, not lost access.
    expect(
      getVaultRealtimeTeardownStatus("VAULT_PERSISTENCE_UNAVAILABLE"),
    ).toBe("unsynced");
  });

  it("keeps terminal states and records a bounded realtime-loss trail", () => {
    const vault = baseVault as never as Parameters<
      typeof applyVaultRealtimeStatus
    >[0];
    // Join timeout: teardown first, then the failed connect.
    const timedOut = applyVaultRealtimeStatus(
      applyVaultRealtimeStatus(vault, "unsynced", {
        reason: "teardown",
        code: "VAULT_PERSISTENCE_UNAVAILABLE",
      }),
      "unsynced",
      { reason: "join-failed", code: null },
    );
    expect(timedOut.syncStatus).toBe("unsynced");
    expect(timedOut.realtimeAvailable).toBe(false);
    expect(timedOut.realtimeLostReason).toBe("teardown>join-failed");
    expect(timedOut.realtimeLostCode).toBe("VAULT_PERSISTENCE_UNAVAILABLE");
    expect(deriveActiveVaultRecoveryState(timedOut, true)).toBe(
      "realtime-lost",
    );

    // A genuine revocation must not be downgraded by the failed connect.
    const revoked = applyVaultRealtimeStatus(
      applyVaultRealtimeStatus(vault, "revoked", {
        reason: "teardown",
        code: "VAULT_CAPABILITY_REVOKED",
      }),
      "unsynced",
      { reason: "join-failed", code: null },
    );
    expect(revoked.syncStatus).toBe("revoked");
    expect(deriveActiveVaultRecoveryState(revoked, true)).toBe("blocked");

    // Repeated steps are collapsed and the trail stays bounded.
    let lost = vault;
    for (const reason of [
      "disconnected",
      "disconnected",
      "reconnect-failed",
      "message-error",
      "teardown",
      "join-failed",
    ] as const) {
      lost = applyVaultRealtimeStatus(lost, "unsynced", {
        reason,
        code: "VAULT_PERSISTENCE_UNAVAILABLE",
      });
    }
    expect(lost.realtimeLostReason).toBe(
      "disconnected>reconnect-failed>message-error>teardown",
    );
  });

  it("reports pending attachments as syncing and failures as error", () => {
    expect(
      deriveActiveVaultRecoveryState(
        { ...baseVault, attachmentPending: 2 },
        true,
      ),
    ).toBe("syncing");
    expect(
      deriveActiveVaultRecoveryState(
        { ...baseVault, attachmentFailed: 1 },
        true,
      ),
    ).toBe("error");
  });

  it("reports a preserved CAS fork as conflict, and blocked for revoked", () => {
    expect(
      deriveActiveVaultRecoveryState(
        {
          ...baseVault,
          syncStatus: "unsynced",
          autosaveUnsyncedReason: "conflict",
          autosaveErrorCode: "VAULT_SNAPSHOT_CONFLICT",
          autosaveLocalPersistence: "local-persisted",
        },
        true,
      ),
    ).toBe("conflict");
    expect(
      deriveActiveVaultRecoveryState(
        { ...baseVault, syncStatus: "revoked" },
        true,
      ),
    ).toBe("blocked");
  });
});
