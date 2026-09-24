import { describe, expect, it } from "vitest";

import type { BinaryFileData } from "@excalidraw/excalidraw/types";

import { generateVaultRootKey } from "../crypto";
import { VaultError } from "../errors";
import { encryptVaultFile } from "../fileAssets";
import {
  VAULT_LOCAL_ATTACHMENT_TASK_STORE,
  VAULT_LOCAL_SCHEMA_VERSION,
  VaultLocalStore,
  openVaultLocalDatabase,
} from "../local-store";

const vaultId = "123e4567-e89b-42d3-a456-426614174000";
const otherVaultId = "123e4567-e89b-42d3-a456-426614174001";
const roomId = "vault-room-123456";
const otherRoomId = "vault-room-654321";
const fileId = "abcdefghijklmnopqrst";
const rootKey = generateVaultRootKey();

const PLAINTEXT_SENTINEL = "attachment-plaintext-sentinel";
const DATA_URL = `data:image/png;base64,${btoa(PLAINTEXT_SENTINEL)}`;

let databaseCounter = 0;
const nextDatabaseName = () =>
  `excalidraw-vault-attachment-test-${Date.now()}-${databaseCounter++}`;

const binaryFile = (
  id: string = fileId,
  dataURL: string = DATA_URL,
): BinaryFileData =>
  ({
    id,
    mimeType: "image/png",
    dataURL,
    created: 1,
    version: 1,
  } as unknown as BinaryFileData);

const rawTaskRecords = async (databaseName: string) => {
  const db = await openVaultLocalDatabase({ databaseName });
  const records = await new Promise<unknown[]>((resolve, reject) => {
    const request = db
      .transaction(VAULT_LOCAL_ATTACHMENT_TASK_STORE, "readonly")
      .objectStore(VAULT_LOCAL_ATTACHMENT_TASK_STORE)
      .getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return records;
};

const envelopeFor = (file: BinaryFileData, scopeVaultId = vaultId) =>
  encryptVaultFile({ vaultId: scopeVaultId, rootKey, file });

describe("Vault local attachment tasks", () => {
  it("enqueues a queued task whose raw record never contains plaintext", async () => {
    const databaseName = nextDatabaseName();
    const store = await VaultLocalStore.open({ databaseName });
    const envelope = await envelopeFor(binaryFile());

    const task = await store.enqueueAttachmentTask({
      vaultId,
      roomId,
      fileId,
      envelope,
      createdAt: 100,
    });

    expect(task).toMatchObject({
      vaultId,
      roomId,
      fileId,
      schemaVersion: VAULT_LOCAL_SCHEMA_VERSION,
      protocolVersion: 1,
      status: "queued",
      attempts: 0,
      lastAttemptAt: null,
      acknowledgedAt: null,
      errorCode: null,
    });
    expect(task.encryptedDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(task.ciphertextBytes).toBeGreaterThan(0);

    const raw = await rawTaskRecords(databaseName);
    expect(raw).toHaveLength(1);
    const serialized = JSON.stringify(raw);
    expect(serialized).not.toContain(PLAINTEXT_SENTINEL);
    expect(serialized).not.toContain(DATA_URL);
    expect(serialized).not.toContain(rootKey);
    expect(serialized).not.toContain("data:image");
    expect(serialized).not.toContain("mimeType");
    store.close();
  });

  it("deduplicates the same file ID and digest without a second record", async () => {
    const databaseName = nextDatabaseName();
    const store = await VaultLocalStore.open({ databaseName });
    const envelope = await envelopeFor(binaryFile());

    const first = await store.enqueueAttachmentTask({
      vaultId,
      roomId,
      fileId,
      envelope,
    });
    const second = await store.enqueueAttachmentTask({
      vaultId,
      roomId,
      fileId,
      envelope,
    });

    expect(second.taskId).toBe(first.taskId);
    expect(await store.listAttachmentTasks({ vaultId, roomId })).toHaveLength(
      1,
    );
    store.close();
  });

  it("fails closed when the same file ID carries different ciphertext", async () => {
    const databaseName = nextDatabaseName();
    const store = await VaultLocalStore.open({ databaseName });
    await store.enqueueAttachmentTask({
      vaultId,
      roomId,
      fileId,
      envelope: await envelopeFor(binaryFile()),
    });
    const different = await envelopeFor(binaryFile(fileId, `${DATA_URL}A`));

    await expect(
      store.enqueueAttachmentTask({
        vaultId,
        roomId,
        fileId,
        envelope: different,
      }),
    ).rejects.toMatchObject({ code: "VAULT_ASSET_CONFLICT" });
    expect(await store.listAttachmentTasks({ vaultId, roomId })).toHaveLength(
      1,
    );
    store.close();
  });

  it("persists tasks across reopen and isolates them by Vault and room", async () => {
    const databaseName = nextDatabaseName();
    const store = await VaultLocalStore.open({ databaseName });
    const task = await store.enqueueAttachmentTask({
      vaultId,
      roomId,
      fileId,
      envelope: await envelopeFor(binaryFile()),
    });
    await store.enqueueAttachmentTask({
      vaultId: otherVaultId,
      roomId: otherRoomId,
      fileId,
      envelope: await envelopeFor(binaryFile(), otherVaultId),
    });
    store.close();

    const reopened = await VaultLocalStore.open({ databaseName });
    const scoped = await reopened.listAttachmentTasks({ vaultId, roomId });
    expect(scoped.map((record) => record.taskId)).toEqual([task.taskId]);
    expect(
      await reopened.listAttachmentTasks({
        vaultId: otherVaultId,
        roomId: otherRoomId,
      }),
    ).toHaveLength(1);
    expect(
      await reopened.listAttachmentTasks({ vaultId, roomId: otherRoomId }),
    ).toHaveLength(0);
    expect(
      await reopened.getAttachmentTaskByFileId({ vaultId, roomId, fileId }),
    ).toMatchObject({ taskId: task.taskId });
    reopened.close();
  });

  it("applies status transitions and deletes completed tasks", async () => {
    const databaseName = nextDatabaseName();
    const store = await VaultLocalStore.open({ databaseName });
    const task = await store.enqueueAttachmentTask({
      vaultId,
      roomId,
      fileId,
      envelope: await envelopeFor(binaryFile()),
    });

    await store.updateAttachmentTask({
      ...task,
      status: "retry",
      attempts: 1,
      lastAttemptAt: 5,
      errorCode: "VAULT_PERSISTENCE_UNAVAILABLE",
    });
    expect(
      await store.getAttachmentTask({ vaultId, roomId, taskId: task.taskId }),
    ).toMatchObject({ status: "retry", attempts: 1 });

    await store.updateAttachmentTask({
      ...task,
      status: "failed",
      attempts: 5,
      errorCode: "VAULT_CAPABILITY_REVOKED",
    });
    expect(
      await store.getAttachmentTask({ vaultId, roomId, taskId: task.taskId }),
    ).toMatchObject({ status: "failed" });

    await store.deleteAttachmentTask({ vaultId, roomId, taskId: task.taskId });
    expect(await store.listAttachmentTasks({ vaultId, roomId })).toHaveLength(
      0,
    );
    store.close();
  });

  it("rejects a completed task with no acknowledgement time", async () => {
    const databaseName = nextDatabaseName();
    const store = await VaultLocalStore.open({ databaseName });
    const task = await store.enqueueAttachmentTask({
      vaultId,
      roomId,
      fileId,
      envelope: await envelopeFor(binaryFile()),
    });

    await expect(
      store.updateAttachmentTask({ ...task, status: "complete" }),
    ).rejects.toBeInstanceOf(VaultError);
    store.close();
  });
});
