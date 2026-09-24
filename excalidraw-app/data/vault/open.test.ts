import { describe, expect, it, vi } from "vitest";

import { assertVaultDeploymentReady } from "./capabilities";
import { encryptVaultSnapshot } from "./snapshot";
import { createVaultPersistenceService } from "./persistence";
import { openVault } from "./open";
import { base64UrlToBytes } from "./encoding";
import { VaultLocalStore } from "./local-store/store";

const vaultId = "123e4567-e89b-42d3-a456-426614174000";
const invitationId = "123e4567-e89b-42d3-a456-426614174001";
const senderSessionId = "123e4567-e89b-42d3-a456-426614174002";
const rootKey = "A".repeat(43);
const invitationCapability = "B".repeat(43);

const deployment = assertVaultDeploymentReady(
  {
    enabled: true,
    protocolVersions: [1],
    roomProtocolVersions: [1],
    invitationService: true,
    encryptedSnapshotPersistence: true,
    encryptedAssetPersistence: true,
  },
  { isSecureContext: true, hasWebCrypto: true },
);

const resolution = (snapshotGeneration: number) => ({
  vaultId,
  invitationId,
  role: "editor" as const,
  authorizationVersion: 1,
  activeRoomId: "vault_room_1234567890",
  snapshotGeneration,
  expiresAt: null,
});

const unused = async () => {
  throw new Error("unused");
};

describe("Vault open flow", () => {
  it("opens generation zero as a blank Vault without reading local state", async () => {
    const persistence = createVaultPersistenceService(deployment, {
      resolveCapability: async () => resolution(0),
      loadSnapshot: async () => null,
      casSnapshot: unused,
      registerAsset: unused,
      resolveAsset: unused,
    });
    const opened = await openVault({
      deployment,
      persistence,
      link: { version: 1, vaultId, rootKey, invitationCapability },
      senderSessionId,
      createEmptySnapshot: () => ({ elements: [], files: {} }),
    });
    expect(opened).toMatchObject({
      generation: 0,
      isEmpty: true,
      syncStatus: "synced",
      snapshot: { elements: [], files: {} },
    });
  });

  it("decrypts a snapshot only when resolution and record generations match", async () => {
    const envelope = await encryptVaultSnapshot({
      vaultId,
      rootKey,
      generation: 2,
      snapshot: { elements: [{ id: "secret-element" }], files: {} },
    });
    const persistence = createVaultPersistenceService(deployment, {
      resolveCapability: async () => resolution(2),
      loadSnapshot: async () => ({
        vaultId,
        generation: 2,
        encryptedEnvelope: envelope,
        ciphertextBytes: base64UrlToBytes(envelope.ciphertext).byteLength,
        updatedAt: 10,
      }),
      casSnapshot: unused,
      registerAsset: unused,
      resolveAsset: unused,
    });
    await expect(
      openVault({
        deployment,
        persistence,
        link: { version: 1, vaultId, rootKey, invitationCapability },
        senderSessionId,
        createEmptySnapshot: () => ({ elements: [], files: {} }),
      }),
    ).resolves.toMatchObject({
      generation: 2,
      isEmpty: false,
      snapshot: { elements: [{ id: "secret-element" }], files: {} },
    });
  });

  it("fails closed when metadata claims a snapshot but persistence returns none", async () => {
    const persistence = createVaultPersistenceService(deployment, {
      resolveCapability: async () => resolution(1),
      loadSnapshot: async () => null,
      casSnapshot: unused,
      registerAsset: unused,
      resolveAsset: unused,
    });
    await expect(
      openVault({
        deployment,
        persistence,
        link: { version: 1, vaultId, rootKey, invitationCapability },
        senderSessionId,
        createEmptySnapshot: () => ({ elements: [], files: {} }),
      }),
    ).rejects.toMatchObject({ code: "VAULT_PERSISTENCE_UNAVAILABLE" });
  });

  it("fails closed on a generation race instead of accepting stale plaintext", async () => {
    const envelope = await encryptVaultSnapshot({
      vaultId,
      rootKey,
      generation: 1,
      snapshot: { elements: [], files: {} },
    });
    const persistence = createVaultPersistenceService(deployment, {
      resolveCapability: async () => resolution(2),
      loadSnapshot: async () => ({
        vaultId,
        generation: 1,
        encryptedEnvelope: envelope,
        ciphertextBytes: base64UrlToBytes(envelope.ciphertext).byteLength,
        updatedAt: 10,
      }),
      casSnapshot: unused,
      registerAsset: unused,
      resolveAsset: unused,
    });
    await expect(
      openVault({
        deployment,
        persistence,
        link: { version: 1, vaultId, rootKey, invitationCapability },
        senderSessionId,
        createEmptySnapshot: () => ({ elements: [], files: {} }),
      }),
    ).rejects.toMatchObject({
      code: "VAULT_SNAPSHOT_CONFLICT",
      recoverable: true,
    });
  });
});

describe("Vault open with a durable local branch", () => {
  const roomId = "vault_room_1234567890";
  let databaseCounter = 0;
  const databaseName = () =>
    `excalidraw-vault-open-b2-${Date.now()}-${databaseCounter++}`;
  const deleteDatabase = (name: string) =>
    new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("database deletion blocked"));
    });

  const seedLocalBranch = async (
    store: VaultLocalStore,
    marker: string,
    options: { withSnapshot?: boolean } = {},
  ) => {
    const envelope = await encryptVaultSnapshot({
      vaultId,
      rootKey,
      generation: 1,
      snapshot: { marker },
    });
    const record = await store.createSnapshotOutboxRecord({
      vaultId,
      roomId,
      envelope,
      expectedGeneration: 0,
    });
    if (options.withSnapshot === false) {
      await store.updateOutbox(record);
    } else {
      await store.putSnapshotAndOutbox({
        vaultId,
        roomId,
        rootKey,
        generation: 1,
        snapshot: { marker },
        outbox: record,
      });
    }
    return record;
  };

  it("prefers the encrypted local branch and reports unsynced when an outbox is pending", async () => {
    const name = databaseName();
    const store = await VaultLocalStore.open({ databaseName: name });
    await seedLocalBranch(store, "local-pending");
    const remoteEnvelope = await encryptVaultSnapshot({
      vaultId,
      rootKey,
      generation: 1,
      snapshot: { marker: "remote" },
    });
    const persistence = createVaultPersistenceService(deployment, {
      resolveCapability: async () => resolution(1),
      loadSnapshot: async () => ({
        vaultId,
        generation: 1,
        encryptedEnvelope: remoteEnvelope,
        ciphertextBytes: base64UrlToBytes(remoteEnvelope.ciphertext).byteLength,
        updatedAt: 10,
      }),
      casSnapshot: unused,
      registerAsset: unused,
      resolveAsset: unused,
    });

    const opened = await openVault<{ marker: string }>({
      deployment,
      persistence,
      link: { version: 1, vaultId, rootKey, invitationCapability },
      senderSessionId,
      createEmptySnapshot: () => ({ marker: "empty" }),
      localStore: store,
    });

    expect(opened).toMatchObject({
      generation: 1,
      isEmpty: false,
      syncStatus: "unsynced",
      snapshot: { marker: "local-pending" },
    });
    expect(opened.localStore).toBe(store);

    store.close();
    await deleteDatabase(name);
  });

  it("fails closed when a pending outbox has no matching local snapshot", async () => {
    const name = databaseName();
    const store = await VaultLocalStore.open({ databaseName: name });
    await seedLocalBranch(store, "orphan", { withSnapshot: false });
    const persistence = createVaultPersistenceService(deployment, {
      resolveCapability: async () => resolution(1),
      loadSnapshot: async () => null,
      casSnapshot: unused,
      registerAsset: unused,
      resolveAsset: unused,
    });

    await expect(
      openVault<{ marker: string }>({
        deployment,
        persistence,
        link: { version: 1, vaultId, rootKey, invitationCapability },
        senderSessionId,
        createEmptySnapshot: () => ({ marker: "empty" }),
        localStore: store,
      }),
    ).rejects.toMatchObject({ code: "VAULT_LOCAL_STORAGE_UNAVAILABLE" });

    store.close();
    await deleteDatabase(name);
  });

  it("does not read or retain a local store for viewers", async () => {
    const localStore = {
      close: vi.fn(),
      listOutbox: vi.fn(),
      getSnapshot: vi.fn(),
    } as unknown as VaultLocalStore;
    const persistence = createVaultPersistenceService(deployment, {
      resolveCapability: async () => ({
        ...resolution(1),
        role: "viewer" as const,
      }),
      loadSnapshot: async () => {
        const envelope = await encryptVaultSnapshot({
          vaultId,
          rootKey,
          generation: 1,
          snapshot: { marker: "remote" },
        });
        return {
          vaultId,
          generation: 1,
          encryptedEnvelope: envelope,
          ciphertextBytes: base64UrlToBytes(envelope.ciphertext).byteLength,
          updatedAt: 10,
        };
      },
      casSnapshot: unused,
      registerAsset: unused,
      resolveAsset: unused,
    });

    const opened = await openVault<{ marker: string }>({
      deployment,
      persistence,
      link: { version: 1, vaultId, rootKey, invitationCapability },
      senderSessionId,
      createEmptySnapshot: () => ({ marker: "empty" }),
      localStore,
    });

    expect(localStore.close).toHaveBeenCalledTimes(1);
    expect(localStore.listOutbox).not.toHaveBeenCalled();
    expect(opened.localStore).toBeUndefined();
    expect(opened.syncStatus).toBe("synced");
  });
});
