import type { BinaryFileData } from "@excalidraw/excalidraw/types";

import { VaultError, type VaultErrorCode } from "./errors";
import { assertVaultEncryptedAssetService } from "./assets";
import { assertVaultAssetReceipt, encryptVaultFile } from "./fileAssets";
import {
  assertVaultLocalAttachmentTaskRecord,
  type VaultLocalAttachmentTaskRecord,
} from "./local-store/domain";

import type {
  VaultEncryptedAssetReceipt,
  VaultEncryptedAssetService,
} from "./assets";
import type { VaultLocalStore } from "./local-store/store";
import type { VaultRole } from "./types";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = import.meta.env.MODE === "test" ? 0 : 250;

export type VaultAttachmentQueueStatus =
  | "idle"
  | "queued"
  | "uploading"
  | "error";

export interface VaultAttachmentQueueState {
  readonly status: VaultAttachmentQueueStatus;
  readonly pending: number;
  readonly failed: number;
  readonly total: number;
}

export type VaultAttachmentUploadResult =
  | {
      status: "complete";
      task: VaultLocalAttachmentTaskRecord;
      receipt: VaultEncryptedAssetReceipt;
    }
  | { status: "offline"; task: VaultLocalAttachmentTaskRecord }
  | {
      status: "failed";
      task: VaultLocalAttachmentTaskRecord;
      errorCode: VaultErrorCode;
    };

export interface VaultAttachmentQueue {
  enqueue(input: {
    fileId: string;
    file: BinaryFileData;
  }): Promise<VaultLocalAttachmentTaskRecord>;
  drain(): Promise<readonly VaultAttachmentUploadResult[]>;
  getState(): VaultAttachmentQueueState;
  listTasks(): Promise<readonly VaultLocalAttachmentTaskRecord[]>;
  verifyDownloadedFile(input: {
    fileId: string;
    encryptedDigest: string;
    ciphertextBytes: number;
  }): Promise<void>;
  /**
   * Removes only completed tasks whose file is no longer referenced by the
   * scene. Pending/failed tasks are always retained so recovery stays possible.
   */
  pruneOrphans(input: { referencedFileIds: Iterable<string> }): Promise<number>;
  dispose(): void;
}

export interface VaultAttachmentQueueInput {
  store: VaultLocalStore;
  service: VaultEncryptedAssetService;
  vaultId: string;
  roomId: string;
  invitationCapability: string;
  rootKey: string;
  role: VaultRole;
  isOnline: () => boolean;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  onStateChange?: (state: VaultAttachmentQueueState) => void;
}

const wait = async (delayMs: number) => {
  if (delayMs <= 0) {
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};

const isRetryable = (error: unknown) =>
  error instanceof VaultError &&
  (error.code === "VAULT_PERSISTENCE_UNAVAILABLE" ||
    error.code === "VAULT_RATE_LIMITED");

const isPending = (task: VaultLocalAttachmentTaskRecord) =>
  task.status === "queued" ||
  task.status === "uploading" ||
  task.status === "retry";

export const createVaultAttachmentQueue = (
  input: VaultAttachmentQueueInput,
): VaultAttachmentQueue => {
  if (input.role !== "editor") {
    throw new VaultError(
      "VAULT_CAPABILITY_FORBIDDEN",
      "Viewer capability cannot create or drain Vault attachment uploads.",
    );
  }
  assertVaultEncryptedAssetService(input.service);
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryBaseDelayMs =
    input.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    !Number.isFinite(retryBaseDelayMs) ||
    retryBaseDelayMs < 0
  ) {
    throw new VaultError(
      "VAULT_INTERNAL",
      "Invalid Vault attachment retry policy.",
    );
  }

  const { vaultId, roomId } = input;
  let disposed = false;
  let drainPromise: Promise<readonly VaultAttachmentUploadResult[]> | undefined;
  let cache: VaultLocalAttachmentTaskRecord[] = [];

  const computeState = (): VaultAttachmentQueueState => {
    const pending = cache.filter(isPending).length;
    const failed = cache.filter((task) => task.status === "failed").length;
    const uploading = cache.some((task) => task.status === "uploading");
    const status: VaultAttachmentQueueStatus =
      pending === 0
        ? failed > 0
          ? "error"
          : "idle"
        : uploading
        ? "uploading"
        : "queued";
    return Object.freeze({
      status,
      pending,
      failed,
      total: cache.length,
    });
  };

  const refresh = async (): Promise<VaultAttachmentQueueState> => {
    cache = [...(await input.store.listAttachmentTasks({ vaultId, roomId }))];
    const state = computeState();
    input.onStateChange?.(state);
    return state;
  };

  const uploadTask = async (
    initial: VaultLocalAttachmentTaskRecord,
  ): Promise<VaultAttachmentUploadResult> => {
    let task = initial;
    // A leftover "uploading" record means the tab crashed or was killed
    // mid-upload. Demote it back to a retryable state before resuming.
    if (task.status === "uploading") {
      task = Object.freeze({
        ...task,
        status: "retry" as const,
        updatedAt: Date.now(),
      });
      await input.store.updateAttachmentTask(task);
    }
    while (!disposed) {
      if (!input.isOnline()) {
        return { status: "offline", task };
      }
      const attempt: VaultLocalAttachmentTaskRecord = Object.freeze({
        ...task,
        status: "uploading" as const,
        attempts: task.attempts + 1,
        lastAttemptAt: Date.now(),
        updatedAt: Date.now(),
        errorCode: null,
      });
      assertVaultLocalAttachmentTaskRecord(attempt);
      await input.store.updateAttachmentTask(attempt);
      try {
        const receipt = await input.service.upload({
          vaultId,
          invitationCapability: input.invitationCapability,
          fileId: attempt.fileId,
          envelope: attempt.envelope,
        });
        assertVaultAssetReceipt({
          vaultId,
          fileId: attempt.fileId,
          task: attempt,
          receipt,
        });
        const complete: VaultLocalAttachmentTaskRecord = Object.freeze({
          ...attempt,
          status: "complete" as const,
          acknowledgedAt: Date.now(),
          updatedAt: Date.now(),
          errorCode: null,
        });
        assertVaultLocalAttachmentTaskRecord(complete);
        await input.store.updateAttachmentTask(complete);
        return { status: "complete", task: complete, receipt };
      } catch (error) {
        const code =
          error instanceof VaultError
            ? error.code
            : "VAULT_PERSISTENCE_UNAVAILABLE";
        if (isRetryable(error) && attempt.attempts < maxAttempts) {
          task = Object.freeze({
            ...attempt,
            status: "retry" as const,
            errorCode: code,
            updatedAt: Date.now(),
          });
          await input.store.updateAttachmentTask(task);
          await wait(
            retryBaseDelayMs * Math.min(2 ** (attempt.attempts - 1), 16),
          );
          continue;
        }
        const failed: VaultLocalAttachmentTaskRecord = Object.freeze({
          ...attempt,
          status: "failed" as const,
          errorCode: code,
          updatedAt: Date.now(),
        });
        await input.store.updateAttachmentTask(failed);
        return { status: "failed", task: failed, errorCode: code };
      }
    }
    return { status: "offline", task };
  };

  const drain = async (): Promise<readonly VaultAttachmentUploadResult[]> => {
    if (drainPromise) {
      return drainPromise;
    }
    drainPromise = (async () => {
      const tasks = await input.store.listAttachmentTasks({
        vaultId,
        roomId,
      });
      cache = [...tasks];
      const pending = tasks.filter(
        (task) => task.status !== "complete" && task.status !== "failed",
      );
      const results: VaultAttachmentUploadResult[] = [];
      for (const task of pending) {
        if (disposed) {
          break;
        }
        const result = await uploadTask(task);
        results.push(result);
        if (result.status === "offline" || result.status === "failed") {
          break;
        }
      }
      await refresh();
      return results;
    })().finally(() => {
      drainPromise = undefined;
    });
    return drainPromise;
  };

  const enqueue = async (enqueueInput: {
    fileId: string;
    file: BinaryFileData;
  }): Promise<VaultLocalAttachmentTaskRecord> => {
    if (disposed) {
      throw new VaultError(
        "VAULT_INTERNAL",
        "Vault attachment queue is closed.",
      );
    }
    // Never re-encrypt an already queued file: the persisted ciphertext and
    // digest are stable for the lifetime of the task.
    const existing = await input.store.getAttachmentTaskByFileId({
      vaultId,
      roomId,
      fileId: enqueueInput.fileId,
    });
    if (existing) {
      await refresh();
      return existing;
    }
    const envelope = await encryptVaultFile({
      vaultId,
      rootKey: input.rootKey,
      file: enqueueInput.file,
    });
    const task = await input.store.enqueueAttachmentTask({
      vaultId,
      roomId,
      fileId: enqueueInput.fileId,
      envelope,
    });
    await refresh();
    return task;
  };

  const verifyDownloadedFile = async (verifyInput: {
    fileId: string;
    encryptedDigest: string;
    ciphertextBytes: number;
  }): Promise<void> => {
    const task = await input.store.getAttachmentTaskByFileId({
      vaultId,
      roomId,
      fileId: verifyInput.fileId,
    });
    if (!task) {
      return;
    }
    if (
      task.encryptedDigest !== verifyInput.encryptedDigest ||
      task.ciphertextBytes !== verifyInput.ciphertextBytes
    ) {
      throw new VaultError(
        "VAULT_ASSET_CONFLICT",
        "Downloaded Vault asset does not match the pending upload.",
      );
    }
  };

  const pruneOrphans = async (pruneInput: {
    referencedFileIds: Iterable<string>;
  }): Promise<number> => {
    const referenced = new Set(pruneInput.referencedFileIds);
    const tasks = await input.store.listAttachmentTasks({ vaultId, roomId });
    let deleted = 0;
    for (const task of tasks) {
      if (task.status === "complete" && !referenced.has(task.fileId)) {
        await input.store.deleteAttachmentTask({
          vaultId,
          roomId,
          taskId: task.taskId,
        });
        deleted += 1;
      }
    }
    if (deleted > 0) {
      await refresh();
    }
    return deleted;
  };

  return Object.freeze({
    enqueue,
    drain,
    getState: () => computeState(),
    listTasks: async () => [
      ...(await input.store.listAttachmentTasks({ vaultId, roomId })),
    ],
    verifyDownloadedFile,
    pruneOrphans,
    dispose() {
      disposed = true;
    },
  });
};
