import { describe, expect, it, vi } from "vitest";

import {
  generateVaultInvitationCapability,
  generateVaultRootKey,
} from "../crypto";
import { encryptVaultSnapshot } from "../snapshot";
import {
  VAULT_LOCAL_DB_VERSION,
  VAULT_LOCAL_OUTBOX_STORE,
  VAULT_LOCAL_SCHEMA_VERSION,
  VAULT_LOCAL_SNAPSHOT_STORE,
  createVaultLocalRecordKey,
  encryptVaultLocalSnapshot,
  openVaultLocalDatabase,
  VaultLocalStore,
} from "../local-store";

const vaultId = "123e4567-e89b-42d3-a456-426614174000";
const otherVaultId = "123e4567-e89b-42d3-a456-426614174001";
const roomId = "vault-room-123456";
const otherRoomId = "vault-room-654321";

let databaseCounter = 0;
const nextDatabaseName = () =>
  `excalidraw-vault-local-test-${Date.now()}-${databaseCounter++}`;

const deleteDatabase = (databaseName: string) =>
  new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("database deletion blocked"));
  });

const readRawSnapshot = async (databaseName: string, key: string) => {
  const db = await openVaultLocalDatabase({ databaseName });
  const record = await new Promise<unknown>((resolve, reject) => {
    const transaction = db.transaction(VAULT_LOCAL_SNAPSHOT_STORE, "readonly");
    const request = transaction
      .objectStore(VAULT_LOCAL_SNAPSHOT_STORE)
      .get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return record;
};

const writeRawSnapshot = async (databaseName: string, record: unknown) => {
  const db = await openVaultLocalDatabase({ databaseName });
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(VAULT_LOCAL_SNAPSHOT_STORE, "readwrite");
    transaction.objectStore(VAULT_LOCAL_SNAPSHOT_STORE).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
  db.close();
};

const readOutboxCount = async (databaseName: string) => {
  const db = await openVaultLocalDatabase({ databaseName });
  const count = await new Promise<number>((resolve, reject) => {
    const request = db
      .transaction(VAULT_LOCAL_OUTBOX_STORE, "readonly")
      .objectStore(VAULT_LOCAL_OUTBOX_STORE)
      .count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return count;
};

describe("Vault encrypted local store", () => {
  it("writes and reads an encrypted snapshot isolated by Vault and room", async () => {
    const databaseName = nextDatabaseName();
    const rootKey = generateVaultRootKey();
    const invitationCapability = generateVaultInvitationCapability();
    const store = await VaultLocalStore.open({ databaseName });

    await expect(
      store.putSnapshot({
        vaultId,
        roomId,
        rootKey,
        generation: 4,
        updatedAt: 1234,
        snapshot: {
          elements: [{ id: "plaintext-scene-sentinel" }],
          files: {},
        },
      }),
    ).resolves.toMatchObject({ generation: 4, updatedAt: 1234 });

    await expect(
      store.getSnapshot({ vaultId, roomId, rootKey }),
    ).resolves.toEqual({
      snapshot: {
        elements: [{ id: "plaintext-scene-sentinel" }],
        files: {},
      },
      generation: 4,
      updatedAt: 1234,
    });
    await expect(
      store.getSnapshot({ vaultId, roomId: otherRoomId, rootKey }),
    ).resolves.toBeNull();

    const raw = JSON.stringify(
      await readRawSnapshot(
        databaseName,
        createVaultLocalRecordKey(vaultId, roomId),
      ),
    );
    expect(raw).not.toContain("plaintext-scene-sentinel");
    expect(raw).not.toContain(rootKey);
    expect(raw).not.toContain(invitationCapability);

    store.close();
    await deleteDatabase(databaseName);
  });

  it("fails closed for a wrong root key without exposing plaintext", async () => {
    const databaseName = nextDatabaseName();
    const store = await VaultLocalStore.open({ databaseName });
    await store.putSnapshot({
      vaultId,
      roomId,
      rootKey: generateVaultRootKey(),
      generation: 1,
      snapshot: { marker: "wrong-key-sentinel" },
    });

    await expect(
      store.getSnapshot({ vaultId, roomId, rootKey: generateVaultRootKey() }),
    ).rejects.toMatchObject({ code: "VAULT_DECRYPT_FAILED" });

    store.close();
    await deleteDatabase(databaseName);
  });

  it("rejects tampered ciphertext and cross-Vault record substitution", async () => {
    const databaseName = nextDatabaseName();
    const rootKey = generateVaultRootKey();
    const store = await VaultLocalStore.open({ databaseName });
    await store.putSnapshot({
      vaultId,
      roomId,
      rootKey,
      generation: 2,
      snapshot: { marker: "tamper-sentinel" },
    });
    const key = createVaultLocalRecordKey(vaultId, roomId);
    const record = (await readRawSnapshot(databaseName, key)) as {
      envelope: { ciphertext: string };
    };
    // Tamper with the first base64url character. For ciphertext lengths where
    // `len % 3 == 1` the final character only carries padding bits, so an
    // end-of-string flip can leave the decoded bytes unchanged and skip the
    // tamper. The first character always changes the first decoded byte.
    const originalCiphertext = record.envelope.ciphertext;
    record.envelope.ciphertext = `${
      originalCiphertext.startsWith("A") ? "B" : "A"
    }${originalCiphertext.slice(1)}`;
    await writeRawSnapshot(databaseName, record);
    await expect(
      store.getSnapshot({ vaultId, roomId, rootKey }),
    ).rejects.toMatchObject({
      code: "VAULT_DECRYPT_FAILED",
    });

    const otherDatabaseName = nextDatabaseName();
    const otherStore = await VaultLocalStore.open({
      databaseName: otherDatabaseName,
    });
    await otherStore.putSnapshot({
      vaultId: otherVaultId,
      roomId,
      rootKey,
      generation: 1,
      snapshot: { marker: "other-vault" },
    });
    const otherKey = createVaultLocalRecordKey(otherVaultId, roomId);
    const otherRecord = await readRawSnapshot(otherDatabaseName, otherKey);
    const substituted = {
      ...(otherRecord as object),
      key,
    };
    await writeRawSnapshot(databaseName, substituted);
    await expect(
      store.getSnapshot({ vaultId, roomId, rootKey }),
    ).rejects.toMatchObject({
      code: "VAULT_ENVELOPE_INVALID",
    });

    store.close();
    otherStore.close();
    await deleteDatabase(databaseName);
    await deleteDatabase(otherDatabaseName);
  });

  it("migrates a supported schema 1 record atomically to schema 2", async () => {
    const databaseName = nextDatabaseName();
    const rootKey = generateVaultRootKey();
    const legacyEnvelope = await encryptVaultLocalSnapshot({
      vaultId,
      roomId,
      rootKey,
      generation: 7,
      snapshot: { marker: "migration-sentinel" },
      schemaVersion: 1,
    });
    const legacyRecord = {
      key: createVaultLocalRecordKey(vaultId, roomId),
      schemaVersion: 1,
      protocolVersion: 1,
      vaultId,
      roomId,
      generation: 7,
      updatedAt: 7000,
      envelope: legacyEnvelope,
    };
    const legacyDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore(VAULT_LOCAL_SNAPSHOT_STORE, {
          keyPath: "key",
        });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = legacyDb.transaction(
        VAULT_LOCAL_SNAPSHOT_STORE,
        "readwrite",
      );
      transaction.objectStore(VAULT_LOCAL_SNAPSHOT_STORE).put(legacyRecord);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    legacyDb.close();

    const store = await VaultLocalStore.open({ databaseName });
    await expect(
      store.getSnapshot({ vaultId, roomId, rootKey }),
    ).resolves.toMatchObject({
      snapshot: { marker: "migration-sentinel" },
      generation: 7,
    });
    expect(
      (
        (await readRawSnapshot(databaseName, legacyRecord.key)) as {
          schemaVersion: number;
        }
      ).schemaVersion,
    ).toBe(VAULT_LOCAL_SCHEMA_VERSION);
    expect(VAULT_LOCAL_DB_VERSION).toBe(2);

    store.close();
    await deleteDatabase(databaseName);
  });

  it("fails closed for transaction failure and unavailable IndexedDB", async () => {
    const databaseName = nextDatabaseName();
    const store = await VaultLocalStore.open({ databaseName });
    store.close();
    await expect(
      store.putSnapshot({
        vaultId,
        roomId,
        rootKey: generateVaultRootKey(),
        generation: 1,
        snapshot: { marker: "transaction-failure" },
      }),
    ).rejects.toMatchObject({ code: "VAULT_LOCAL_STORAGE_UNAVAILABLE" });
    await deleteDatabase(databaseName);

    await expect(
      VaultLocalStore.open({
        databaseName: nextDatabaseName(),
        indexedDB: null,
      }),
    ).rejects.toMatchObject({ code: "VAULT_LOCAL_STORAGE_UNAVAILABLE" });
  });

  it("does not partially write snapshot or outbox when the atomic transaction cannot start", async () => {
    const databaseName = nextDatabaseName();
    const rootKey = generateVaultRootKey();
    const store = await VaultLocalStore.open({ databaseName });
    const envelope = await encryptVaultSnapshot({
      vaultId,
      rootKey,
      generation: 1,
      snapshot: { marker: "atomic-failure" },
    });
    const outbox = await store.createSnapshotOutboxRecord({
      vaultId,
      roomId,
      envelope,
      expectedGeneration: 0,
    });
    store.close();
    await expect(
      store.putSnapshotAndOutbox({
        vaultId,
        roomId,
        rootKey,
        generation: 1,
        snapshot: { marker: "atomic-failure" },
        outbox,
      }),
    ).rejects.toMatchObject({ code: "VAULT_LOCAL_STORAGE_UNAVAILABLE" });
    await expect(
      readRawSnapshot(databaseName, createVaultLocalRecordKey(vaultId, roomId)),
    ).resolves.toBeUndefined();
    await expect(readOutboxCount(databaseName)).resolves.toBe(0);
    await deleteDatabase(databaseName);
  });

  it("fails closed on a storage quota error without reporting a successful write", async () => {
    const databaseName = nextDatabaseName();
    const rootKey = generateVaultRootKey();
    const store = await VaultLocalStore.open({ databaseName });
    const envelope = await encryptVaultSnapshot({
      vaultId,
      rootKey,
      generation: 1,
      snapshot: { marker: "quota-sentinel" },
    });
    const outbox = await store.createSnapshotOutboxRecord({
      vaultId,
      roomId,
      envelope,
      expectedGeneration: 0,
    });
    // A real browser surfaces quota exhaustion as a request error/abort; the
    // store must fail closed and never report the write as successful.
    const putSpy = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(() => {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      });
    try {
      await expect(
        store.putSnapshot({
          vaultId,
          roomId,
          rootKey,
          generation: 1,
          snapshot: { marker: "quota-sentinel" },
        }),
      ).rejects.toMatchObject({ code: "VAULT_LOCAL_STORAGE_UNAVAILABLE" });
      await expect(
        store.putSnapshotAndOutbox({
          vaultId,
          roomId,
          rootKey,
          generation: 1,
          snapshot: { marker: "quota-sentinel" },
          outbox,
        }),
      ).rejects.toMatchObject({ code: "VAULT_LOCAL_STORAGE_UNAVAILABLE" });
    } finally {
      putSpy.mockRestore();
    }

    await expect(
      store.getSnapshot({ vaultId, roomId, rootKey }),
    ).resolves.toBeNull();
    await expect(readOutboxCount(databaseName)).resolves.toBe(0);
    store.close();
    await deleteDatabase(databaseName);
  });

  it("rejects unknown local schema versions before decryption", async () => {
    const databaseName = nextDatabaseName();
    const store = await VaultLocalStore.open({ databaseName });
    await store.putSnapshot({
      vaultId,
      roomId,
      rootKey: generateVaultRootKey(),
      generation: 1,
      snapshot: { marker: "schema-sentinel" },
    });
    const record = (await readRawSnapshot(
      databaseName,
      createVaultLocalRecordKey(vaultId, roomId),
    )) as { schemaVersion: number; envelope: { schemaVersion: number } };
    record.schemaVersion = 999;
    record.envelope.schemaVersion = 999;
    await writeRawSnapshot(databaseName, record);
    await expect(
      store.getSnapshot({ vaultId, roomId, rootKey: generateVaultRootKey() }),
    ).rejects.toMatchObject({ code: "VAULT_LOCAL_SCHEMA_UNSUPPORTED" });

    store.close();
    await deleteDatabase(databaseName);
  });
});
