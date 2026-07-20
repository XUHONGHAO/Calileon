import { decryptVaultJson, encryptVaultBytes } from "./crypto";
import { base64UrlToBytes } from "./encoding";
import { VaultError } from "./errors";
import {
  assertVaultPersistenceService,
  type VaultPersistenceService,
  type VaultSnapshotRecord,
} from "./persistence";
import {
  assertVaultEncryptedEnvelopeV1,
  createVaultMessageId,
} from "./protocol";

import type { VaultRole, VaultSnapshotEncryptedEnvelopeV1 } from "./types";

export interface VaultSnapshotLoadInput {
  persistence: VaultPersistenceService;
  vaultId: string;
  invitationCapability: string;
  rootKey: string;
}

export interface VaultLoadedSnapshot<TSnapshot> {
  snapshot: TSnapshot;
  generation: number;
  updatedAt: number;
}

export interface VaultSnapshotSaveInput<TSnapshot>
  extends VaultSnapshotLoadInput {
  role: VaultRole;
  expectedGeneration: number;
  snapshot: TSnapshot;
}

export type VaultSnapshotSaveResult<TSnapshot> =
  | {
      status: "synced";
      snapshot: TSnapshot;
      generation: number;
      updatedAt: number;
    }
  | {
      status: "unsynced";
      reason: "conflict";
      errorCode: "VAULT_SNAPSHOT_CONFLICT";
      snapshot: TSnapshot;
      expectedGeneration: number;
    };

const assertGeneration = (generation: number, minimum: number) => {
  if (
    !Number.isSafeInteger(generation) ||
    generation < minimum ||
    generation === Number.MAX_SAFE_INTEGER
  ) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault snapshot generation.",
    );
  }
};

const assertSnapshotRecordBinding = (
  vaultId: string,
  record: VaultSnapshotRecord,
) => {
  assertVaultEncryptedEnvelopeV1(record.encryptedEnvelope);
  if (
    record.vaultId !== vaultId ||
    record.encryptedEnvelope.purpose !== "snapshot" ||
    record.encryptedEnvelope.vaultId !== vaultId ||
    record.encryptedEnvelope.generation !== record.generation ||
    base64UrlToBytes(record.encryptedEnvelope.ciphertext).byteLength !==
      record.ciphertextBytes
  ) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault snapshot binding.",
    );
  }
};

/** Serializes JSON directly into the frozen snapshot-purpose envelope. */
export const encryptVaultSnapshot = async <TSnapshot>(input: {
  vaultId: string;
  rootKey: string;
  generation: number;
  snapshot: TSnapshot;
}): Promise<VaultSnapshotEncryptedEnvelopeV1> => {
  assertGeneration(input.generation, 1);
  try {
    const serialized = JSON.stringify(input.snapshot);
    if (serialized === undefined) {
      throw new VaultError(
        "VAULT_ENVELOPE_INVALID",
        "Vault snapshot is not JSON serializable.",
      );
    }
    return (await encryptVaultBytes(
      input.rootKey,
      {
        version: 1,
        vaultId: input.vaultId,
        purpose: "snapshot",
        messageType: "snapshot.scene",
        messageId: createVaultMessageId(),
        generation: input.generation,
      },
      new TextEncoder().encode(serialized),
    )) as VaultSnapshotEncryptedEnvelopeV1;
  } catch (error) {
    if (error instanceof VaultError) {
      throw error;
    }
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Vault snapshot is not JSON serializable.",
    );
  }
};

export const decryptVaultSnapshot = async <TSnapshot>(input: {
  vaultId: string;
  rootKey: string;
  generation: number;
  envelope: VaultSnapshotEncryptedEnvelopeV1;
}): Promise<TSnapshot> => {
  assertGeneration(input.generation, 1);
  assertVaultEncryptedEnvelopeV1(input.envelope);
  if (
    input.envelope.purpose !== "snapshot" ||
    input.envelope.vaultId !== input.vaultId ||
    input.envelope.generation !== input.generation
  ) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault snapshot binding.",
    );
  }
  return await decryptVaultJson<TSnapshot>(input.rootKey, input.envelope);
};

export const loadVaultSnapshot = async <TSnapshot>(
  input: VaultSnapshotLoadInput,
): Promise<VaultLoadedSnapshot<TSnapshot> | null> => {
  assertVaultPersistenceService(input.persistence);
  const record = await input.persistence.loadSnapshot({
    vaultId: input.vaultId,
    invitationCapability: input.invitationCapability,
  });
  if (record === null) {
    return null;
  }
  assertSnapshotRecordBinding(input.vaultId, record);
  return {
    snapshot: await decryptVaultSnapshot<TSnapshot>({
      vaultId: input.vaultId,
      rootKey: input.rootKey,
      generation: record.generation,
      envelope: record.encryptedEnvelope,
    }),
    generation: record.generation,
    updatedAt: record.updatedAt,
  };
};

export const saveVaultSnapshot = async <TSnapshot>(
  input: VaultSnapshotSaveInput<TSnapshot>,
): Promise<VaultSnapshotSaveResult<TSnapshot>> => {
  assertVaultPersistenceService(input.persistence);
  if (input.role !== "editor") {
    throw new VaultError(
      "VAULT_CAPABILITY_FORBIDDEN",
      "Viewer capability cannot write a Vault snapshot.",
    );
  }
  assertGeneration(input.expectedGeneration, 0);
  const generation = input.expectedGeneration + 1;
  const envelope = await encryptVaultSnapshot({
    vaultId: input.vaultId,
    rootKey: input.rootKey,
    generation,
    snapshot: input.snapshot,
  });

  try {
    const result = await input.persistence.casSnapshot({
      vaultId: input.vaultId,
      invitationCapability: input.invitationCapability,
      expectedGeneration: input.expectedGeneration,
      envelope,
      ciphertextBytes: base64UrlToBytes(envelope.ciphertext).byteLength,
    });
    if (result.vaultId !== input.vaultId || result.generation !== generation) {
      throw new VaultError("VAULT_INTERNAL", "Invalid Vault CAS response.");
    }
    return {
      status: "synced",
      snapshot: input.snapshot,
      generation: result.generation,
      updatedAt: result.updatedAt,
    };
  } catch (error) {
    if (
      error instanceof VaultError &&
      error.code === "VAULT_SNAPSHOT_CONFLICT"
    ) {
      return {
        status: "unsynced",
        reason: "conflict",
        errorCode: "VAULT_SNAPSHOT_CONFLICT",
        snapshot: input.snapshot,
        expectedGeneration: input.expectedGeneration,
      };
    }
    throw error;
  }
};
