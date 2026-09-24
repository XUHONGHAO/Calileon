import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertVaultDeploymentReady } from "./capabilities";
import { generateVaultRootKey } from "./crypto";
import { base64UrlToBytes } from "./encoding";
import { VaultError } from "./errors";
import { createVaultPersistenceService } from "./persistence";
import { createVaultSnapshotAutosaveController } from "./autosave";
import { decryptVaultSnapshot, encryptVaultSnapshot } from "./snapshot";
import { VaultLocalStore } from "./local-store/store";

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
      localPersistence: "remote-confirmed",
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

describe("Vault autosave durable local outbox integration", () => {
  const roomId = "vault_room_1234567890";
  let databaseCounter = 0;
  const databaseName = () =>
    `excalidraw-vault-autosave-b2-${Date.now()}-${databaseCounter++}`;
  const deleteDatabase = (name: string) =>
    new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("database deletion blocked"));
    });

  // Returns a CAS stub that echoes the caller's update ID so the outbox can
  // verify stable updateId idempotency rather than a rewritten message id.
  const confirmWith = () =>
    vi
      .fn()
      .mockImplementation(
        async (input: { updateId: string; expectedGeneration: number }) => ({
          vaultId,
          updateId: input.updateId,
          generation: input.expectedGeneration + 1,
          updatedAt: 100,
        }),
      );

  beforeEach(() => {
    vi.useRealTimers();
  });

  it("commits the encrypted local snapshot and durable outbox before the remote CAS", async () => {
    const name = databaseName();
    const store = await VaultLocalStore.open({ databaseName: name });
    const rootKey = generateVaultRootKey();
    const casSnapshot = confirmWith();
    const controller = createVaultSnapshotAutosaveController({
      persistence: createPersistence({ casSnapshot }),
      vaultId,
      invitationCapability,
      rootKey,
      role: "editor",
      initialGeneration: 0,
      debounceMs: 0,
      isOnline: () => true,
      roomId,
      localStore: store,
    });

    controller.schedule({ marker: "local" });
    const state = await controller.flush();

    expect(casSnapshot).toHaveBeenCalledTimes(1);
    const sent = casSnapshot.mock.calls[0][0];
    expect(sent.updateId).toBe(sent.envelope.messageId);
    expect(sent.expectedGeneration).toBe(0);
    expect(state).toMatchObject({
      status: "synced",
      generation: 1,
      localPersistence: "remote-confirmed",
    });
    await expect(store.listOutbox({ vaultId, roomId })).resolves.toEqual([]);
    await expect(
      store.getSnapshot<{ marker: string }>({ vaultId, roomId, rootKey }),
    ).resolves.toMatchObject({ generation: 1, snapshot: { marker: "local" } });

    controller.dispose();
    store.close();
    await deleteDatabase(name);
  });

  it("keeps the encrypted local branch when offline and reports local-persisted", async () => {
    const name = databaseName();
    const store = await VaultLocalStore.open({ databaseName: name });
    const rootKey = generateVaultRootKey();
    const casSnapshot = confirmWith();
    const controller = createVaultSnapshotAutosaveController({
      persistence: createPersistence({ casSnapshot }),
      vaultId,
      invitationCapability,
      rootKey,
      role: "editor",
      initialGeneration: 0,
      debounceMs: 0,
      isOnline: () => false,
      roomId,
      localStore: store,
    });

    controller.schedule({ marker: "offline-local" });
    const state = await controller.flush();

    expect(casSnapshot).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      status: "unsynced",
      unsyncedReason: "offline",
      localPersistence: "local-persisted",
    });
    expect(controller.getBeforeUnloadState()).toBe("local-persisted-unsynced");
    await expect(store.listOutbox({ vaultId, roomId })).resolves.toMatchObject([
      { status: "pending", expectedGeneration: 0 },
    ]);
    await expect(
      store.getSnapshot<{ marker: string }>({ vaultId, roomId, rootKey }),
    ).resolves.toMatchObject({
      generation: 1,
      snapshot: { marker: "offline-local" },
    });

    controller.dispose();
    store.close();

    // Reopening the database proves the branch survived a crash/refresh.
    const reopened = await VaultLocalStore.open({ databaseName: name });
    await expect(
      reopened.getSnapshot<{ marker: string }>({ vaultId, roomId, rootKey }),
    ).resolves.toMatchObject({
      generation: 1,
      snapshot: { marker: "offline-local" },
    });
    reopened.close();
    await deleteDatabase(name);
  });

  it("recovers a pending local outbox on start without changing the update ID", async () => {
    const name = databaseName();
    const store = await VaultLocalStore.open({ databaseName: name });
    const rootKey = generateVaultRootKey();
    const envelope = await encryptVaultSnapshot({
      vaultId,
      rootKey,
      generation: 1,
      snapshot: { marker: "recovered" },
    });
    const record = await store.createSnapshotOutboxRecord({
      vaultId,
      roomId,
      envelope,
      expectedGeneration: 0,
    });
    await store.putSnapshotAndOutbox({
      vaultId,
      roomId,
      rootKey,
      generation: 1,
      snapshot: { marker: "recovered" },
      outbox: record,
    });

    const casSnapshot = confirmWith();
    const controller = createVaultSnapshotAutosaveController({
      persistence: createPersistence({ casSnapshot }),
      vaultId,
      invitationCapability,
      rootKey,
      role: "editor",
      initialGeneration: 1,
      debounceMs: 0,
      isOnline: () => true,
      roomId,
      localStore: store,
    });

    const state = await controller.flush();

    expect(casSnapshot).toHaveBeenCalledTimes(1);
    expect(casSnapshot.mock.calls[0][0]).toMatchObject({
      updateId: record.updateId,
      expectedGeneration: 0,
    });
    expect(state).toMatchObject({
      status: "synced",
      generation: 1,
      localPersistence: "remote-confirmed",
    });
    await expect(store.listOutbox({ vaultId, roomId })).resolves.toEqual([]);

    controller.dispose();
    store.close();
    await deleteDatabase(name);
  });

  it("reuses the same update ID when an offline branch is retried online", async () => {
    const name = databaseName();
    const store = await VaultLocalStore.open({ databaseName: name });
    const rootKey = generateVaultRootKey();
    const casSnapshot = confirmWith();
    let online = false;
    const controller = createVaultSnapshotAutosaveController({
      persistence: createPersistence({ casSnapshot }),
      vaultId,
      invitationCapability,
      rootKey,
      role: "editor",
      initialGeneration: 0,
      debounceMs: 0,
      isOnline: () => online,
      roomId,
      localStore: store,
    });

    controller.schedule({ marker: "queued-offline" });
    await controller.flush();
    const queued = await store.listOutbox({ vaultId, roomId });
    expect(queued).toHaveLength(1);
    const { updateId } = queued[0];

    online = true;
    await controller.retry();

    expect(casSnapshot).toHaveBeenCalledTimes(1);
    expect(casSnapshot.mock.calls[0][0]).toMatchObject({
      updateId,
      expectedGeneration: 0,
    });
    await expect(store.listOutbox({ vaultId, roomId })).resolves.toEqual([]);
    expect(controller.getState()).toMatchObject({
      status: "synced",
      generation: 1,
      localPersistence: "remote-confirmed",
    });

    controller.dispose();
    store.close();
    await deleteDatabase(name);
  });

  it("keeps both branches and never auto-reconciles on a generation conflict", async () => {
    const name = databaseName();
    const store = await VaultLocalStore.open({ databaseName: name });
    const rootKey = generateVaultRootKey();
    const remoteEnvelope = await encryptVaultSnapshot({
      vaultId,
      rootKey,
      generation: 1,
      snapshot: { marker: "remote" },
    });
    const casSnapshot = vi.fn().mockRejectedValue(
      new VaultError("VAULT_SNAPSHOT_CONFLICT", "conflict", {
        recoverable: true,
      }),
    );
    const loadSnapshot = vi.fn().mockResolvedValue({
      vaultId,
      generation: 1,
      encryptedEnvelope: remoteEnvelope,
      ciphertextBytes: base64UrlToBytes(remoteEnvelope.ciphertext).byteLength,
      updatedAt: 30,
    });
    const reconcileConflict = vi.fn(() => ({ marker: "merged" }));
    const controller = createVaultSnapshotAutosaveController({
      persistence: createPersistence({ casSnapshot, loadSnapshot }),
      vaultId,
      invitationCapability,
      rootKey,
      role: "editor",
      initialGeneration: 0,
      debounceMs: 0,
      isOnline: () => true,
      roomId,
      localStore: store,
      reconcileConflict,
    });

    controller.schedule({ marker: "local-branch" });
    const state = await controller.flush();

    expect(reconcileConflict).not.toHaveBeenCalled();
    expect(casSnapshot).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({
      status: "unsynced",
      unsyncedReason: "conflict",
      errorCode: "VAULT_SNAPSHOT_CONFLICT",
      localPersistence: "local-persisted",
    });
    const outbox = await store.listOutbox({ vaultId, roomId });
    expect(outbox).toMatchObject([
      {
        status: "conflict",
        conflictReason: "generation",
        remoteGeneration: 1,
      },
    ]);
    expect(outbox[0].remoteEnvelope).not.toBeNull();
    await expect(
      store.getSnapshot<{ marker: string }>({ vaultId, roomId, rootKey }),
    ).resolves.toMatchObject({ snapshot: { marker: "local-branch" } });

    controller.dispose();
    store.close();
    await deleteDatabase(name);
  });

  it("fails closed on a revoked capability without deleting the local branch", async () => {
    const name = databaseName();
    const store = await VaultLocalStore.open({ databaseName: name });
    const rootKey = generateVaultRootKey();
    const casSnapshot = vi
      .fn()
      .mockRejectedValue(new VaultError("VAULT_CAPABILITY_REVOKED", "revoked"));
    const controller = createVaultSnapshotAutosaveController({
      persistence: createPersistence({ casSnapshot }),
      vaultId,
      invitationCapability,
      rootKey,
      role: "editor",
      initialGeneration: 0,
      debounceMs: 0,
      isOnline: () => true,
      roomId,
      localStore: store,
    });

    controller.schedule({ marker: "revoked-local" });
    const state = await controller.flush();

    expect(state).toMatchObject({
      status: "unsynced",
      unsyncedReason: "error",
      errorCode: "VAULT_CAPABILITY_REVOKED",
      localPersistence: "local-persisted",
    });
    await expect(store.listOutbox({ vaultId, roomId })).resolves.toMatchObject([
      { status: "failed", errorCode: "VAULT_CAPABILITY_REVOKED" },
    ]);
    await expect(
      store.getSnapshot<{ marker: string }>({ vaultId, roomId, rootKey }),
    ).resolves.toMatchObject({ snapshot: { marker: "revoked-local" } });

    controller.dispose();
    store.close();
    await deleteDatabase(name);
  });
});
