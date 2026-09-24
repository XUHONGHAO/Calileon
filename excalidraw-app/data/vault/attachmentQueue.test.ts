import { describe, expect, it, vi } from "vitest";

import type { BinaryFileData } from "@excalidraw/excalidraw/types";

import { createVaultEncryptedAssetService } from "./assets";
import { createVaultAttachmentQueue } from "./attachmentQueue";
import { assertVaultDeploymentReady } from "./capabilities";
import { generateVaultRootKey } from "./crypto";
import { VaultError } from "./errors";
import { digestVaultAssetEnvelope } from "./fileAssets";
import { VaultLocalStore } from "./local-store";

import type { VaultEncryptedAssetService } from "./assets";

const vaultId = "123e4567-e89b-42d3-a456-426614174000";
const roomId = "vault-room-123456";
const fileId = "abcdefghijklmnopqrst";
const otherFileId = "abcdefghijklmnopqrstu";
const invitationCapability = `${"C".repeat(42)}A`;
const rootKey = generateVaultRootKey();

let databaseCounter = 0;
const nextDatabaseName = () =>
  `excalidraw-vault-attachment-queue-${Date.now()}-${databaseCounter++}`;

const binaryFile = (id: string = fileId): BinaryFileData =>
  ({
    id,
    mimeType: "image/png",
    dataURL: "data:image/png;base64,YXR0YWNobWVudC1xdWV1ZS1zZWNyZXQ=",
    created: 1,
    version: 1,
  } as unknown as BinaryFileData);

const deployment = () =>
  assertVaultDeploymentReady(
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

type UploadImpl = (input: {
  vaultId: string;
  invitationCapability: string;
  fileId: string;
  envelope: Parameters<typeof digestVaultAssetEnvelope>[0];
}) => Promise<{
  vaultId: string;
  fileId: string;
  encryptedDigest: string;
  ciphertextBytes: number;
}>;

const makeService = (uploadImpl?: UploadImpl) => {
  const upload = vi.fn(
    uploadImpl ??
      (async ({ vaultId: scope, fileId: id, envelope }) => {
        const digest = await digestVaultAssetEnvelope(envelope);
        return { vaultId: scope, fileId: id, ...digest };
      }),
  );
  const download = vi.fn(async () => {
    throw new Error("download should not be called");
  });
  return {
    service: createVaultEncryptedAssetService(deployment(), {
      upload,
      download,
    }) as VaultEncryptedAssetService,
    upload,
  };
};

const newQueue = async (input?: {
  service?: VaultEncryptedAssetService;
  isOnline?: () => boolean;
  role?: "editor" | "viewer";
}) => {
  const databaseName = nextDatabaseName();
  const store = await VaultLocalStore.open({ databaseName });
  const { service, upload } = makeService();
  const queue = createVaultAttachmentQueue({
    store,
    service: input?.service ?? service,
    vaultId,
    roomId,
    invitationCapability,
    rootKey,
    role: input?.role ?? "editor",
    isOnline: input?.isOnline ?? (() => true),
  });
  return { store, queue, upload };
};

describe("Vault durable attachment queue", () => {
  it("persists the ciphertext task before uploading and completes on receipt", async () => {
    const { store, queue, upload } = await newQueue();

    const task = await queue.enqueue({ fileId, file: binaryFile() });
    expect(task.status).toBe("queued");
    expect(upload).not.toHaveBeenCalled();

    const results = await queue.drain();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "complete" });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(queue.getState()).toMatchObject({ pending: 0, failed: 0, total: 1 });

    const [stored] = await queue.listTasks();
    expect(stored).toMatchObject({
      status: "complete",
      attempts: 1,
    });
    expect(stored.acknowledgedAt).not.toBeNull();
    store.close();
  });

  it("retries a transient failure while reusing the same encrypted envelope", async () => {
    const databaseName = nextDatabaseName();
    const store = await VaultLocalStore.open({ databaseName });
    let calls = 0;
    const { service, upload } = makeService(
      async ({ vaultId: s, fileId: id, envelope }) => {
        calls += 1;
        if (calls === 1) {
          throw new VaultError(
            "VAULT_PERSISTENCE_UNAVAILABLE",
            "signed upload URL expired",
          );
        }
        const digest = await digestVaultAssetEnvelope(envelope);
        return { vaultId: s, fileId: id, ...digest };
      },
    );
    const queue = createVaultAttachmentQueue({
      store,
      service,
      vaultId,
      roomId,
      invitationCapability,
      rootKey,
      role: "editor",
      isOnline: () => true,
    });
    await queue.enqueue({ fileId, file: binaryFile() });

    const results = await queue.drain();
    expect(results[0]).toMatchObject({ status: "complete" });
    expect(upload).toHaveBeenCalledTimes(2);
    const firstEnvelope = upload.mock.calls[0][0].envelope;
    const secondEnvelope = upload.mock.calls[1][0].envelope;
    expect(secondEnvelope).toEqual(firstEnvelope);
    const [stored] = await queue.listTasks();
    expect(stored.attempts).toBe(2);
    store.close();
  });

  it("recovers a crash-leftover uploading task", async () => {
    const { store, queue, upload } = await newQueue();
    const task = await queue.enqueue({ fileId, file: binaryFile() });
    await store.updateAttachmentTask({
      ...task,
      status: "uploading",
      attempts: 1,
      lastAttemptAt: 7,
    });

    const results = await queue.drain();
    expect(results[0]).toMatchObject({ status: "complete" });
    expect(upload).toHaveBeenCalledTimes(1);
    const [stored] = await queue.listTasks();
    expect(stored.status).toBe("complete");
    store.close();
  });

  it("keeps queued tasks and never uploads while offline", async () => {
    const { store, queue, upload } = await newQueue({ isOnline: () => false });
    await queue.enqueue({ fileId, file: binaryFile() });

    const results = await queue.drain();
    expect(results[0]).toMatchObject({ status: "offline" });
    expect(upload).not.toHaveBeenCalled();
    expect(await queue.listTasks()).toHaveLength(1);
    expect(queue.getState().pending).toBe(1);
    store.close();
  });

  it("stops retrying and fails closed when the capability is revoked", async () => {
    const databaseName = nextDatabaseName();
    const store = await VaultLocalStore.open({ databaseName });
    const { service, upload } = makeService(async () => {
      throw new VaultError("VAULT_CAPABILITY_REVOKED", "revoked");
    });
    const queue = createVaultAttachmentQueue({
      store,
      service,
      vaultId,
      roomId,
      invitationCapability,
      rootKey,
      role: "editor",
      isOnline: () => true,
    });
    await queue.enqueue({ fileId, file: binaryFile() });

    const results = await queue.drain();
    expect(results[0]).toMatchObject({
      status: "failed",
      errorCode: "VAULT_CAPABILITY_REVOKED",
    });
    expect(upload).toHaveBeenCalledTimes(1);
    expect(queue.getState()).toMatchObject({ pending: 0, failed: 1 });
    store.close();
  });

  it("fails closed when the upload receipt does not match the task", async () => {
    const databaseName = nextDatabaseName();
    const store = await VaultLocalStore.open({ databaseName });
    const { service } = makeService(async ({ vaultId: s, fileId: id }) => ({
      vaultId: s,
      fileId: id,
      encryptedDigest: "A".repeat(43),
      ciphertextBytes: 1,
    }));
    const queue = createVaultAttachmentQueue({
      store,
      service,
      vaultId,
      roomId,
      invitationCapability,
      rootKey,
      role: "editor",
      isOnline: () => true,
    });
    await queue.enqueue({ fileId, file: binaryFile() });

    const results = await queue.drain();
    expect(results[0]).toMatchObject({
      status: "failed",
      errorCode: "VAULT_ASSET_CONFLICT",
    });
    store.close();
  });

  it("binds a downloaded asset back to the locally queued ciphertext", async () => {
    const { store, queue } = await newQueue();
    const task = await queue.enqueue({ fileId, file: binaryFile() });

    await expect(
      queue.verifyDownloadedFile({
        fileId,
        encryptedDigest: "A".repeat(43),
        ciphertextBytes: task.ciphertextBytes + 1,
      }),
    ).rejects.toMatchObject({ code: "VAULT_ASSET_CONFLICT" });

    await expect(
      queue.verifyDownloadedFile({
        fileId,
        encryptedDigest: task.encryptedDigest,
        ciphertextBytes: task.ciphertextBytes,
      }),
    ).resolves.toBeUndefined();
    store.close();
  });

  it("refuses to create a queue for a viewer capability", async () => {
    const store = await VaultLocalStore.open({
      databaseName: nextDatabaseName(),
    });
    const { service } = makeService();
    expect(() =>
      createVaultAttachmentQueue({
        store,
        service,
        vaultId,
        roomId,
        invitationCapability,
        rootKey,
        role: "viewer",
        isOnline: () => true,
      }),
    ).toThrow(VaultError);
    store.close();
  });

  it("prunes only completed orphans and retains pending tasks", async () => {
    const { store, queue } = await newQueue();
    await queue.enqueue({ fileId, file: binaryFile() });
    await queue.enqueue({ fileId: otherFileId, file: binaryFile(otherFileId) });
    await queue.drain();

    const orphan = await queue.enqueue({
      fileId: "abcdefghijklmnopqrstuv",
      file: binaryFile("abcdefghijklmnopqrstuv"),
    });
    expect(orphan.status).toBe("queued");

    const deleted = await queue.pruneOrphans({ referencedFileIds: [] });
    expect(deleted).toBe(2);
    const remaining = await queue.listTasks();
    expect(remaining.map((task) => task.fileId)).toEqual([orphan.fileId]);

    const kept = await queue.pruneOrphans({ referencedFileIds: [fileId] });
    expect(kept).toBe(0);
    store.close();
  });
});
