import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertVaultDeploymentReady } from "./capabilities";
import { generateVaultRootKey } from "./crypto";
import { base64UrlToBytes } from "./encoding";
import { VaultError } from "./errors";
import { createVaultPersistenceService } from "./persistence";
import { createVaultSnapshotAutosaveController } from "./autosave";
import { decryptVaultSnapshot, encryptVaultSnapshot } from "./snapshot";

import type { VaultPersistenceServiceImplementation } from "./persistence";
import type { VaultDeploymentCapabilities } from "./types";

const vaultId = "123e4567-e89b-42d3-a456-426614174000";
const invitationCapability = `${"C".repeat(42)}A`;
const capabilities: VaultDeploymentCapabilities = {
  enabled: true,
  protocolVersions: [1],
  roomProtocolVersions: [1],
  invitationService: true,
  encryptedSnapshotPersistence: true,
  encryptedAssetPersistence: true,
};

const createPersistence = (
  overrides: Partial<VaultPersistenceServiceImplementation> = {},
) =>
  createVaultPersistenceService(
    assertVaultDeploymentReady(capabilities, {
      isSecureContext: true,
      hasWebCrypto: true,
    }),
    {
      resolveCapability: vi.fn(),
      loadSnapshot: vi.fn(),
      casSnapshot: vi.fn(),
      registerAsset: vi.fn(),
      resolveAsset: vi.fn(),
      ...overrides,
    },
  );

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createSnapshotRecord = async <TSnapshot>(
  rootKey: string,
  generation: number,
  snapshot: TSnapshot,
) => {
  const encryptedEnvelope = await encryptVaultSnapshot({
    vaultId,
    rootKey,
    generation,
    snapshot,
  });
  return {
    vaultId,
    generation,
    encryptedEnvelope,
    ciphertextBytes: base64UrlToBytes(encryptedEnvelope.ciphertext).byteLength,
    updatedAt: generation * 100,
  };
};

describe("Vault snapshot autosave controller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces changes and saves only the latest in-memory snapshot", async () => {
    const casSnapshot = vi.fn().mockResolvedValue({
      vaultId,
      generation: 1,
      updatedAt: 100,
    });
    const controller = createVaultSnapshotAutosaveController({
      persistence: createPersistence({ casSnapshot }),
      vaultId,
      invitationCapability,
      rootKey: generateVaultRootKey(),
      role: "editor",
      initialGeneration: 0,
      debounceMs: 1000,
      isOnline: () => true,
    });

    controller.schedule({ marker: "first" });
    await vi.advanceTimersByTimeAsync(500);
    controller.schedule({ marker: "latest" });
    await vi.advanceTimersByTimeAsync(999);
    expect(casSnapshot).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await controller.flush();

    expect(casSnapshot).toHaveBeenCalledTimes(1);
    expect(casSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ expectedGeneration: 0 }),
    );
    expect(controller.getState()).toEqual({
      status: "synced",
      generation: 1,
      hasPendingChanges: false,
      unsyncedReason: null,
      errorCode: null,
    });
    expect(controller.shouldWarnBeforeUnload()).toBe(false);
  });

  it("serializes an in-flight save before writing the next generation", async () => {
    const first = deferred<{
      vaultId: string;
      generation: number;
      updatedAt: number;
    }>();
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const casSnapshot = vi
      .fn()
      .mockImplementationOnce(async () => {
        activeRequests += 1;
        maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
        const result = await first.promise;
        activeRequests -= 1;
        return result;
      })
      .mockImplementationOnce(async () => {
        activeRequests += 1;
        maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
        activeRequests -= 1;
        return { vaultId, generation: 2, updatedAt: 200 };
      });
    const controller = createVaultSnapshotAutosaveController({
      persistence: createPersistence({ casSnapshot }),
      vaultId,
      invitationCapability,
      rootKey: generateVaultRootKey(),
      role: "editor",
      initialGeneration: 0,
      debounceMs: 10,
      isOnline: () => true,
    });

    controller.schedule({ marker: "one" });
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(casSnapshot).toHaveBeenCalledTimes(1));

    controller.schedule({ marker: "two" });
    await vi.advanceTimersByTimeAsync(10);
    expect(casSnapshot).toHaveBeenCalledTimes(1);
    expect(controller.shouldWarnBeforeUnload()).toBe(true);

    first.resolve({ vaultId, generation: 1, updatedAt: 100 });
    await controller.flush();

    expect(casSnapshot).toHaveBeenCalledTimes(2);
    expect(casSnapshot.mock.calls[1][0]).toEqual(
      expect.objectContaining({ expectedGeneration: 1 }),
    );
    expect(maximumActiveRequests).toBe(1);
    expect(controller.getState().generation).toBe(2);
    expect(controller.getState().status).toBe("synced");
  });

  it("rejects viewer autosave before persistence can be called", () => {
    const casSnapshot = vi.fn();
    expect(() =>
      createVaultSnapshotAutosaveController({
        persistence: createPersistence({ casSnapshot }),
        vaultId,
        invitationCapability,
        rootKey: "not-read",
        role: "viewer",
        initialGeneration: 0,
        isOnline: () => true,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_CAPABILITY_FORBIDDEN" }),
    );
    expect(casSnapshot).not.toHaveBeenCalled();
  });

  it("keeps offline changes unsynced without network and retries in memory", async () => {
    let online = false;
    const casSnapshot = vi.fn().mockResolvedValue({
      vaultId,
      generation: 4,
      updatedAt: 400,
    });
    const controller = createVaultSnapshotAutosaveController({
      persistence: createPersistence({ casSnapshot }),
      vaultId,
      invitationCapability,
      rootKey: generateVaultRootKey(),
      role: "editor",
      initialGeneration: 3,
      debounceMs: 10,
      isOnline: () => online,
    });

    controller.schedule({ marker: "offline" });
    await vi.advanceTimersByTimeAsync(10);

    expect(casSnapshot).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject({
      status: "unsynced",
      generation: 3,
      hasPendingChanges: true,
      unsyncedReason: "offline",
      errorCode: "VAULT_PERSISTENCE_UNAVAILABLE",
    });
    expect(controller.shouldWarnBeforeUnload()).toBe(true);

    online = true;
    await controller.retry();

    expect(casSnapshot).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({
      status: "synced",
      generation: 4,
      hasPendingChanges: false,
    });
    expect(controller.shouldWarnBeforeUnload()).toBe(false);
  });

  it("loads the latest generation, reconciles, and retries a CAS conflict once", async () => {
    const rootKey = generateVaultRootKey();
    const latestRecord = await createSnapshotRecord(rootKey, 6, {
      marker: "remote",
    });
    const loadSnapshot = vi.fn().mockResolvedValue(latestRecord);
    const casSnapshot = vi
      .fn()
      .mockRejectedValueOnce(
        new VaultError("VAULT_SNAPSHOT_CONFLICT", "conflict", {
          recoverable: true,
        }),
      )
      .mockResolvedValueOnce({ vaultId, generation: 7, updatedAt: 700 });
    const reconcileConflict = vi.fn(({ pendingSnapshot, latestSnapshot }) => ({
      marker: `${pendingSnapshot.marker}+${latestSnapshot.marker}`,
    }));
    const controller = createVaultSnapshotAutosaveController({
      persistence: createPersistence({ loadSnapshot, casSnapshot }),
      vaultId,
      invitationCapability,
      rootKey,
      role: "editor",
      initialGeneration: 5,
      debounceMs: 10,
      isOnline: () => true,
      reconcileConflict,
    });

    controller.schedule({ marker: "local" });
    await controller.flush();

    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    expect(reconcileConflict).toHaveBeenCalledWith({
      pendingSnapshot: { marker: "local" },
      latestSnapshot: { marker: "remote" },
      latestGeneration: 6,
    });
    expect(casSnapshot).toHaveBeenCalledTimes(2);
    expect(casSnapshot.mock.calls[0][0]).toEqual(
      expect.objectContaining({ expectedGeneration: 5 }),
    );
    expect(casSnapshot.mock.calls[1][0]).toEqual(
      expect.objectContaining({ expectedGeneration: 6 }),
    );
    await expect(
      decryptVaultSnapshot<{ marker: string }>({
        vaultId,
        rootKey,
        generation: 7,
        envelope: casSnapshot.mock.calls[1][0].envelope,
      }),
    ).resolves.toEqual({ marker: "local+remote" });
    expect(controller.getState()).toMatchObject({
      status: "synced",
      generation: 7,
      hasPendingChanges: false,
      unsyncedReason: null,
      errorCode: null,
    });
  });

  it("reconciles the newest pending revision when a conflict arrives", async () => {
    const rootKey = generateVaultRootKey();
    const firstSave = deferred<{
      vaultId: string;
      generation: number;
      updatedAt: number;
    }>();
    const latestRecord = await createSnapshotRecord(rootKey, 1, {
      marker: "remote",
    });
    const casSnapshot = vi
      .fn()
      .mockImplementationOnce(() => firstSave.promise)
      .mockResolvedValueOnce({ vaultId, generation: 2, updatedAt: 200 });
    const reconcileConflict = vi.fn(({ pendingSnapshot, latestSnapshot }) => ({
      marker: `${pendingSnapshot.marker}+${latestSnapshot.marker}`,
    }));
    const controller = createVaultSnapshotAutosaveController({
      persistence: createPersistence({
        loadSnapshot: vi.fn().mockResolvedValue(latestRecord),
        casSnapshot,
      }),
      vaultId,
      invitationCapability,
      rootKey,
      role: "editor",
      initialGeneration: 0,
      debounceMs: 10,
      isOnline: () => true,
      reconcileConflict,
    });

    controller.schedule({ marker: "first" });
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(casSnapshot).toHaveBeenCalledTimes(1));
    controller.schedule({ marker: "latest" });
    firstSave.reject(
      new VaultError("VAULT_SNAPSHOT_CONFLICT", "conflict", {
        recoverable: true,
      }),
    );
    await controller.flush();

    expect(reconcileConflict).toHaveBeenCalledWith({
      pendingSnapshot: { marker: "latest" },
      latestSnapshot: { marker: "remote" },
      latestGeneration: 1,
    });
    await expect(
      decryptVaultSnapshot<{ marker: string }>({
        vaultId,
        rootKey,
        generation: 2,
        envelope: casSnapshot.mock.calls[1][0].envelope,
      }),
    ).resolves.toEqual({ marker: "latest+remote" });
    expect(controller.getState()).toMatchObject({
      status: "synced",
      generation: 2,
      hasPendingChanges: false,
    });
  });

  it("recovers after multiple consecutive snapshot conflicts", async () => {
    const rootKey = generateVaultRootKey();
    const conflict = new VaultError("VAULT_SNAPSHOT_CONFLICT", "conflict", {
      recoverable: true,
    });
    const loadSnapshot = vi
      .fn()
      .mockResolvedValueOnce(
        await createSnapshotRecord(rootKey, 6, { marker: "remote-6" }),
      )
      .mockResolvedValueOnce(
        await createSnapshotRecord(rootKey, 7, { marker: "remote-7" }),
      );
    const casSnapshot = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ vaultId, generation: 8, updatedAt: 800 });
    const controller = createVaultSnapshotAutosaveController({
      persistence: createPersistence({ loadSnapshot, casSnapshot }),
      vaultId,
      invitationCapability,
      rootKey,
      role: "editor",
      initialGeneration: 5,
      debounceMs: 10,
      isOnline: () => true,
      reconcileConflict: ({ pendingSnapshot, latestSnapshot }) => ({
        marker: `${(pendingSnapshot as { marker: string }).marker}+${
          (latestSnapshot as { marker: string }).marker
        }`,
      }),
    });

    controller.schedule({ marker: "local" });
    await controller.flush();

    expect(casSnapshot).toHaveBeenCalledTimes(3);
    expect(loadSnapshot).toHaveBeenCalledTimes(2);
    expect(controller.getState()).toMatchObject({
      status: "synced",
      generation: 8,
      hasPendingChanges: false,
      unsyncedReason: null,
      errorCode: null,
    });
  });

  it("stops after the configured conflict retry limit", async () => {
    const rootKey = generateVaultRootKey();
    const latestRecord = await createSnapshotRecord(rootKey, 6, {
      marker: "remote",
    });
    const conflict = new VaultError("VAULT_SNAPSHOT_CONFLICT", "conflict", {
      recoverable: true,
    });
    const loadSnapshot = vi.fn().mockResolvedValue(latestRecord);
    const casSnapshot = vi.fn().mockRejectedValue(conflict);
    const controller = createVaultSnapshotAutosaveController({
      persistence: createPersistence({ loadSnapshot, casSnapshot }),
      vaultId,
      invitationCapability,
      rootKey,
      role: "editor",
      initialGeneration: 5,
      debounceMs: 10,
      maxConflictRetries: 1,
      isOnline: () => true,
      reconcileConflict: ({ pendingSnapshot }) => pendingSnapshot,
    });

    controller.schedule({ marker: "local" });
    await controller.flush();

    expect(casSnapshot).toHaveBeenCalledTimes(2);
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({
      status: "unsynced",
      generation: 6,
      hasPendingChanges: true,
      unsyncedReason: "conflict",
      errorCode: "VAULT_SNAPSHOT_CONFLICT",
    });
    expect(controller.shouldWarnBeforeUnload()).toBe(true);
  });

  it("fails closed when the latest conflicting snapshot cannot be decrypted", async () => {
    const rootKey = generateVaultRootKey();
    const latestRecord = await createSnapshotRecord(generateVaultRootKey(), 6, {
      marker: "remote",
    });
    const casSnapshot = vi.fn().mockRejectedValue(
      new VaultError("VAULT_SNAPSHOT_CONFLICT", "conflict", {
        recoverable: true,
      }),
    );
    const controller = createVaultSnapshotAutosaveController({
      persistence: createPersistence({
        loadSnapshot: vi.fn().mockResolvedValue(latestRecord),
        casSnapshot,
      }),
      vaultId,
      invitationCapability,
      rootKey,
      role: "editor",
      initialGeneration: 5,
      debounceMs: 10,
      isOnline: () => true,
      reconcileConflict: ({ pendingSnapshot }) => pendingSnapshot,
    });

    controller.schedule({ marker: "local" });
    await controller.flush();

    expect(casSnapshot).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({
      status: "unsynced",
      generation: 5,
      hasPendingChanges: true,
      unsyncedReason: "error",
      errorCode: "VAULT_DECRYPT_FAILED",
    });
  });
});
