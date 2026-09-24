import { VaultError, type VaultErrorCode } from "./errors";
import { base64UrlToBytes } from "./encoding";
import {
  assertVaultLocalOutboxRecord,
  type VaultLocalOutboxRecord,
} from "./local-store/domain";
import {
  assertVaultPersistenceService,
  type VaultPersistenceService,
  type VaultSnapshotRecord,
} from "./persistence";
import { assertVaultEncryptedEnvelopeV1 } from "./protocol";

import type { VaultLocalStore } from "./local-store/store";
import type { VaultSnapshotCasResult } from "./backendContract";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = import.meta.env.MODE === "test" ? 0 : 250;

export type VaultOutboxSendResult =
  | {
      status: "confirmed";
      record: VaultLocalOutboxRecord;
      result: VaultSnapshotCasResult;
    }
  | { status: "offline"; record: VaultLocalOutboxRecord }
  | {
      status: "conflict";
      record: VaultLocalOutboxRecord;
      latest: VaultSnapshotRecord | null;
    }
  | {
      status: "failed";
      record: VaultLocalOutboxRecord;
      errorCode: VaultErrorCode;
    };

export interface VaultOutboxController {
  send(updateId: string): Promise<VaultOutboxSendResult | null>;
  drain(): Promise<readonly VaultOutboxSendResult[]>;
  dispose(): void;
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

const assertRemoteSnapshot = (
  vaultId: string,
  value: VaultSnapshotRecord | null,
) => {
  if (value === null) {
    return;
  }
  assertVaultEncryptedEnvelopeV1(value.encryptedEnvelope);
  if (
    value.vaultId !== vaultId ||
    value.encryptedEnvelope.vaultId !== vaultId ||
    value.encryptedEnvelope.purpose !== "snapshot" ||
    value.encryptedEnvelope.messageType !== "snapshot.scene" ||
    value.encryptedEnvelope.generation !== value.generation ||
    base64UrlToBytes(value.encryptedEnvelope.ciphertext).byteLength !==
      value.ciphertextBytes
  ) {
    throw new VaultError("VAULT_ENVELOPE_INVALID", "Invalid remote snapshot.");
  }
};

export const createVaultOutboxController = (input: {
  store: VaultLocalStore;
  persistence: VaultPersistenceService;
  vaultId: string;
  roomId: string;
  invitationCapability: string;
  isOnline: () => boolean;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  onConflict?: (input: {
    record: VaultLocalOutboxRecord;
    latest: VaultSnapshotRecord | null;
  }) => void;
}): VaultOutboxController => {
  assertVaultPersistenceService(input.persistence);
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
      "Invalid Vault outbox retry policy.",
    );
  }

  let disposed = false;
  let drainPromise: Promise<readonly VaultOutboxSendResult[]> | undefined;

  const send = async (
    updateId: string,
  ): Promise<VaultOutboxSendResult | null> => {
    if (disposed) {
      throw new VaultError("VAULT_INTERNAL", "Vault outbox is closed.");
    }
    const records = await input.store.listOutbox({
      vaultId: input.vaultId,
      roomId: input.roomId,
    });
    let original = records.find((record) => record.updateId === updateId);
    if (!original) {
      return null;
    }
    if (original.status === "sending") {
      original = { ...original, status: "pending" };
      await input.store.updateOutbox(original);
    }
    if (original.status === "conflict" || original.status === "failed") {
      return {
        status: original.status === "conflict" ? "conflict" : "failed",
        record: original,
        ...(original.status === "conflict"
          ? { latest: null }
          : { errorCode: original.errorCode ?? "VAULT_INTERNAL" }),
      } as VaultOutboxSendResult;
    }
    if (!input.isOnline()) {
      return { status: "offline", record: original };
    }

    const sending: VaultLocalOutboxRecord = {
      ...original,
      status: "sending",
      attempts: original.attempts + 1,
      lastAttemptAt: Date.now(),
    };
    await input.store.updateOutbox(sending);
    try {
      if (
        sending.kind !== "snapshot.commit" ||
        sending.envelope.purpose !== "snapshot"
      ) {
        const failed: VaultLocalOutboxRecord = {
          ...sending,
          status: "failed",
          errorCode: "VAULT_MESSAGE_TYPE_UNSUPPORTED",
        };
        await input.store.updateOutbox(failed);
        return {
          status: "failed",
          record: failed,
          errorCode: "VAULT_MESSAGE_TYPE_UNSUPPORTED",
        };
      }
      const result = await input.persistence.casSnapshot({
        vaultId: input.vaultId,
        invitationCapability: input.invitationCapability,
        updateId: sending.updateId,
        expectedGeneration: sending.expectedGeneration,
        envelope: sending.envelope,
        ciphertextBytes: sending.ciphertextBytes,
      });
      if (
        result.vaultId !== input.vaultId ||
        (result.updateId !== undefined &&
          result.updateId !== sending.updateId) ||
        result.generation !== sending.expectedGeneration + 1
      ) {
        throw new VaultError(
          "VAULT_INTERNAL",
          "Invalid Vault outbox response.",
        );
      }
      const confirmed: VaultLocalOutboxRecord = {
        ...sending,
        status: "confirmed",
        acknowledgedAt: Date.now(),
        errorCode: null,
      };
      assertVaultLocalOutboxRecord(confirmed);
      await input.store.updateOutbox(confirmed);
      await input.store.deleteOutbox({
        vaultId: input.vaultId,
        roomId: input.roomId,
        updateId: sending.updateId,
      });
      return { status: "confirmed", record: confirmed, result };
    } catch (error) {
      if (
        error instanceof VaultError &&
        error.code === "VAULT_SNAPSHOT_CONFLICT"
      ) {
        let latest: VaultSnapshotRecord | null = null;
        try {
          latest = await input.persistence.loadSnapshot({
            vaultId: input.vaultId,
            invitationCapability: input.invitationCapability,
          });
          assertRemoteSnapshot(input.vaultId, latest);
        } catch (loadError) {
          const failed: VaultLocalOutboxRecord = {
            ...sending,
            status: "conflict",
            errorCode:
              loadError instanceof VaultError
                ? loadError.code
                : "VAULT_PERSISTENCE_UNAVAILABLE",
            remoteEnvelope: null,
            remoteGeneration: null,
            conflictReason: "remote-unavailable",
          };
          await input.store.updateOutbox(failed);
          input.onConflict?.({ record: failed, latest: null });
          return { status: "conflict", record: failed, latest: null };
        }
        const conflicted: VaultLocalOutboxRecord = {
          ...sending,
          status: "conflict",
          errorCode: latest
            ? "VAULT_SNAPSHOT_CONFLICT"
            : "VAULT_PERSISTENCE_UNAVAILABLE",
          remoteEnvelope: latest?.encryptedEnvelope ?? null,
          remoteGeneration: latest?.generation ?? null,
          conflictReason: latest ? "generation" : "remote-unavailable",
        };
        await input.store.updateOutbox(conflicted);
        input.onConflict?.({ record: conflicted, latest });
        return { status: "conflict", record: conflicted, latest };
      }

      const code =
        error instanceof VaultError
          ? error.code
          : "VAULT_PERSISTENCE_UNAVAILABLE";
      if (isRetryable(error) && sending.attempts < maxAttempts) {
        const pending: VaultLocalOutboxRecord = {
          ...sending,
          status: "pending",
          errorCode: code,
        };
        await input.store.updateOutbox(pending);
        await wait(
          retryBaseDelayMs * Math.min(2 ** (sending.attempts - 1), 16),
        );
        return { status: "offline", record: pending };
      }
      const failed: VaultLocalOutboxRecord = {
        ...sending,
        status: "failed",
        errorCode: code,
      };
      await input.store.updateOutbox(failed);
      return { status: "failed", record: failed, errorCode: code };
    }
  };

  const drain = async () => {
    if (drainPromise) {
      return drainPromise;
    }
    drainPromise = (async () => {
      const records = await input.store.listOutbox({
        vaultId: input.vaultId,
        roomId: input.roomId,
      });
      const results: VaultOutboxSendResult[] = [];
      for (const record of records) {
        if (disposed) {
          break;
        }
        const result = await send(record.updateId);
        if (result) {
          results.push(result);
        }
        if (result?.status === "conflict" || result?.status === "failed") {
          break;
        }
      }
      return results;
    })().finally(() => {
      drainPromise = undefined;
    });
    return drainPromise;
  };

  return Object.freeze({
    send,
    drain,
    dispose() {
      disposed = true;
    },
  });
};
