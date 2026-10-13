import { describe, expect, it, vi } from "vitest";

import {
  createVaultRecoveryReporter,
  deriveVaultRecoveryState,
  isVaultRecoveryBlockedCode,
} from "./recovery";

import type { VaultRecoveryInput } from "./recovery";

const base: VaultRecoveryInput = {
  opening: false,
  snapshot: {
    status: "synced",
    unsyncedReason: null,
    errorCode: null,
    localPersistence: "remote-confirmed",
  },
  attachments: { pending: 0, failed: 0 },
  isOnline: true,
  localStorageAvailable: true,
  blockedCode: null,
};

const input = (patch: Partial<VaultRecoveryInput>): VaultRecoveryInput => ({
  ...base,
  ...patch,
});

describe("Vault recovery state machine", () => {
  it("reports opening and fail-closed blocked states", () => {
    expect(deriveVaultRecoveryState(input({ opening: true }))).toBe("opening");
    for (const code of [
      "VAULT_CAPABILITY_REVOKED",
      "VAULT_CAPABILITY_EXPIRED",
      "VAULT_DECRYPT_FAILED",
      "VAULT_ENVELOPE_INVALID",
      "VAULT_KEY_INVALID",
      "VAULT_LOCAL_SCHEMA_UNSUPPORTED",
      "VAULT_ASSET_CONFLICT",
    ] as const) {
      expect(isVaultRecoveryBlockedCode(code)).toBe(true);
      expect(deriveVaultRecoveryState(input({ blockedCode: code }))).toBe(
        "blocked",
      );
    }
    expect(isVaultRecoveryBlockedCode("VAULT_PERSISTENCE_UNAVAILABLE")).toBe(
      false,
    );
  });

  it("distinguishes local recovery, sync, synced and conflict", () => {
    expect(deriveVaultRecoveryState(input({ snapshot: null }))).toBe(
      "recovering-local",
    );
    expect(
      deriveVaultRecoveryState(
        input({
          snapshot: {
            status: "syncing",
            unsyncedReason: "pending",
            errorCode: null,
            localPersistence: "local-persisted",
          },
        }),
      ),
    ).toBe("syncing");
    expect(deriveVaultRecoveryState(input({}))).toBe("synced");
    expect(
      deriveVaultRecoveryState(
        input({
          snapshot: {
            status: "unsynced",
            unsyncedReason: "conflict",
            errorCode: "VAULT_SNAPSHOT_CONFLICT",
            localPersistence: "local-persisted",
          },
        }),
      ),
    ).toBe("conflict");
    expect(
      deriveVaultRecoveryState(
        input({
          snapshot: {
            status: "unsynced",
            unsyncedReason: "error",
            errorCode: "VAULT_PERSISTENCE_UNAVAILABLE",
            localPersistence: "local-persisted",
          },
        }),
      ),
    ).toBe("error");
  });

  it("reports syncing when attachments are still draining online", () => {
    expect(
      deriveVaultRecoveryState(
        input({ attachments: { pending: 2, failed: 0 } }),
      ),
    ).toBe("syncing");
  });

  it("never claims offline-safe without IndexedDB or a persisted copy", () => {
    expect(
      deriveVaultRecoveryState(
        input({
          isOnline: false,
          snapshot: {
            status: "unsynced",
            unsyncedReason: "offline",
            errorCode: "VAULT_PERSISTENCE_UNAVAILABLE",
            localPersistence: "local-persisted",
          },
        }),
      ),
    ).toBe("offline-local-safe");
    expect(
      deriveVaultRecoveryState(
        input({
          isOnline: false,
          localStorageAvailable: false,
          snapshot: {
            status: "unsynced",
            unsyncedReason: "offline",
            errorCode: "VAULT_PERSISTENCE_UNAVAILABLE",
            localPersistence: "local-persisted",
          },
        }),
      ),
    ).toBe("error");
    expect(
      deriveVaultRecoveryState(
        input({
          isOnline: false,
          snapshot: {
            status: "unsynced",
            unsyncedReason: "pending",
            errorCode: null,
            localPersistence: "not-persisted",
          },
        }),
      ),
    ).toBe("local-restored");
  });

  it("does not treat a read-only session's missing local copy as an error", () => {
    const viewer = {
      localStorageAvailable: false,
      readOnly: true,
      snapshot: {
        status: "synced" as const,
        unsyncedReason: null,
        errorCode: null,
        localPersistence: "not-persisted" as const,
      },
    };
    expect(deriveVaultRecoveryState(input(viewer))).toBe("synced");
    expect(
      deriveVaultRecoveryState(input({ ...viewer, readOnly: false })),
    ).toBe("error");
    expect(
      deriveVaultRecoveryState(
        input({
          ...viewer,
          snapshot: { ...viewer.snapshot, status: "unsynced" },
        }),
      ),
    ).toBe("error");
  });

  it("surfaces failed attachments as an error, not as synced", () => {
    expect(
      deriveVaultRecoveryState(
        input({ attachments: { pending: 0, failed: 1 } }),
      ),
    ).toBe("error");
  });

  it("reports a dropped realtime link instead of syncing", () => {
    // Observed stuck state: snapshot remote-confirmed, nothing pending, but the
    // room link is gone. It must not be shown as syncing (or synced).
    const stuck = input({
      realtimeAvailable: false,
      snapshot: {
        status: "unsynced",
        unsyncedReason: null,
        errorCode: null,
        localPersistence: "remote-confirmed",
      },
    });
    expect(deriveVaultRecoveryState(stuck)).toBe("realtime-lost");
    expect(deriveVaultRecoveryState(input({ realtimeAvailable: false }))).toBe(
      "realtime-lost",
    );
    // Viewers have no local copy; realtime loss is still reported as such.
    expect(
      deriveVaultRecoveryState(
        input({
          realtimeAvailable: false,
          readOnly: true,
          localStorageAvailable: false,
          snapshot: { ...stuck.snapshot!, localPersistence: "not-persisted" },
        }),
      ),
    ).toBe("realtime-lost");
    // Default (not tracked) keeps the previous behaviour.
    expect(deriveVaultRecoveryState(input({}))).toBe("synced");
  });

  it("keeps stronger states ahead of a dropped realtime link", () => {
    const lost = { realtimeAvailable: false } as const;
    expect(
      deriveVaultRecoveryState(
        input({ ...lost, blockedCode: "VAULT_CAPABILITY_REVOKED" }),
      ),
    ).toBe("blocked");
    expect(
      deriveVaultRecoveryState(
        input({
          ...lost,
          snapshot: {
            status: "unsynced",
            unsyncedReason: "conflict",
            errorCode: "VAULT_SNAPSHOT_CONFLICT",
            localPersistence: "local-persisted",
          },
        }),
      ),
    ).toBe("conflict");
    expect(
      deriveVaultRecoveryState(
        input({ ...lost, attachments: { pending: 0, failed: 1 } }),
      ),
    ).toBe("error");
    // An editor without IndexedDB must not be told to reload: edits could be
    // lost, so it stays a plain error.
    expect(
      deriveVaultRecoveryState(
        input({
          ...lost,
          localStorageAvailable: false,
          snapshot: {
            status: "unsynced",
            unsyncedReason: "pending",
            errorCode: null,
            localPersistence: "not-persisted",
          },
        }),
      ),
    ).toBe("error");
    // Offline keeps reporting the local copy.
    expect(
      deriveVaultRecoveryState(
        input({
          ...lost,
          isOnline: false,
          snapshot: {
            status: "unsynced",
            unsyncedReason: "offline",
            errorCode: "VAULT_PERSISTENCE_UNAVAILABLE",
            localPersistence: "local-persisted",
          },
        }),
      ),
    ).toBe("offline-local-safe");
  });

  it("drives subscribers from a reporter", () => {
    const reporter = createVaultRecoveryReporter(base);
    const listener = vi.fn();
    reporter.subscribe(listener);
    expect(reporter.getState()).toBe("synced");

    reporter.update({ isOnline: false });
    expect(reporter.getState()).toBe("synced");
    reporter.update({
      snapshot: {
        status: "unsynced",
        unsyncedReason: "offline",
        errorCode: "VAULT_PERSISTENCE_UNAVAILABLE",
        localPersistence: "local-persisted",
      },
    });
    expect(reporter.getState()).toBe("offline-local-safe");
    expect(listener).toHaveBeenCalledWith("offline-local-safe");

    reporter.update({ blockedCode: "VAULT_CAPABILITY_REVOKED" });
    expect(reporter.getState()).toBe("blocked");
    reporter.dispose();
  });
});
