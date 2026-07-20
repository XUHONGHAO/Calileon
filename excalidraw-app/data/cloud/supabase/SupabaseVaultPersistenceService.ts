import { VAULT_RPC } from "../../vault/backendContract";
import {
  assertVaultDeploymentReadyToken,
  type VaultDeploymentReady,
} from "../../vault/capabilities";
import { base64UrlToBytes, isCanonicalBase64Url } from "../../vault/encoding";
import {
  isVaultErrorCode,
  VaultError,
  type VaultErrorCode,
} from "../../vault/errors";
import {
  createVaultPersistenceService,
  createVaultRpcInvoker,
  type VaultCapabilityInput,
  type VaultPersistenceService,
} from "../../vault/persistence";
import { assertVaultEncryptedEnvelopeV1 } from "../../vault/protocol";

import { getSupabaseClient } from "./client";
import {
  mapVaultAssetRegistrationResult,
  mapVaultAssetResolution,
  mapVaultCapabilityResolution,
  mapVaultSnapshotCasResult,
  mapVaultSnapshotRecord,
} from "./vaultMappers";

import type {
  VaultAssetRegistrationInput,
  VaultSnapshotCasInput,
} from "../../vault/backendContract";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILE_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_SNAPSHOT_CIPHERTEXT_BYTES = 52_428_800;
const MAX_ASSET_CIPHERTEXT_BYTES = 104_857_600;

interface SupabaseVaultRpcResult {
  data: unknown;
  error: unknown;
}

export interface SupabaseVaultRpcClient {
  rpc(
    rpcName: string,
    params: Readonly<Record<string, unknown>>,
  ): PromiseLike<SupabaseVaultRpcResult>;
}

const RECOVERABLE_CODES = new Set<VaultErrorCode>([
  "VAULT_PERSISTENCE_UNAVAILABLE",
  "VAULT_RATE_LIMITED",
  "VAULT_SNAPSHOT_CONFLICT",
  "VAULT_ASSET_CONFLICT",
]);

const toStableVaultError = (code: VaultErrorCode): VaultError =>
  new VaultError(code, "Vault persistence operation failed.", {
    recoverable: RECOVERABLE_CODES.has(code),
  });

export const mapSupabaseVaultError = (error: unknown): VaultError => {
  if (error instanceof VaultError) {
    return error;
  }
  const candidate =
    typeof error === "object" && error !== null
      ? (error as {
          message?: unknown;
          code?: unknown;
          name?: unknown;
          status?: unknown;
          statusCode?: unknown;
        })
      : null;
  if (candidate?.code === "P0001" && isVaultErrorCode(candidate.message)) {
    return toStableVaultError(candidate.message);
  }
  if (
    error instanceof TypeError ||
    candidate?.name === "FetchError" ||
    candidate?.name === "AuthRetryableFetchError"
  ) {
    return toStableVaultError("VAULT_PERSISTENCE_UNAVAILABLE");
  }
  const status = Number(candidate?.statusCode ?? candidate?.status);
  if (status === 401 || status === 403) {
    return toStableVaultError("VAULT_CAPABILITY_FORBIDDEN");
  }
  if (status === 413) {
    return toStableVaultError("VAULT_PAYLOAD_TOO_LARGE");
  }
  if (status === 429) {
    return toStableVaultError("VAULT_RATE_LIMITED");
  }
  return toStableVaultError("VAULT_INTERNAL");
};

const assertCapabilityInput = (input: VaultCapabilityInput) => {
  if (!UUID_RE.test(input.vaultId)) {
    throw new VaultError("VAULT_URL_INVALID", "Invalid Vault ID.");
  }
  if (
    input.invitationCapability.length !== 43 ||
    !isCanonicalBase64Url(input.invitationCapability, 32)
  ) {
    throw new VaultError(
      "VAULT_CAPABILITY_INVALID",
      "Invalid Vault capability.",
    );
  }
};

const assertFileId = (fileId: string) => {
  if (!FILE_ID_RE.test(fileId)) {
    throw new VaultError("VAULT_ENVELOPE_INVALID", "Invalid Vault file ID.");
  }
};

const assertCiphertextBytes = (value: number, maximum: number) => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new VaultError(
      "VAULT_ENVELOPE_INVALID",
      "Invalid Vault ciphertext size.",
    );
  }
  if (value > maximum) {
    throw new VaultError(
      "VAULT_PAYLOAD_TOO_LARGE",
      "Vault ciphertext exceeds the allowed size.",
    );
  }
};

export const createSupabaseVaultPersistenceService = (
  deployment: VaultDeploymentReady,
  options?: { client?: SupabaseVaultRpcClient },
): VaultPersistenceService => {
  assertVaultDeploymentReadyToken(deployment);
  const client =
    options?.client ??
    (getSupabaseClient() as unknown as SupabaseVaultRpcClient);
  const invoker = createVaultRpcInvoker(deployment, {
    invoke: async <TResult>(
      rpcName: string,
      params: Readonly<Record<string, unknown>>,
    ) => {
      try {
        const { data, error } = await client.rpc(rpcName, params);
        if (error) {
          throw mapSupabaseVaultError(error);
        }
        return data as TResult;
      } catch (error) {
        throw mapSupabaseVaultError(error);
      }
    },
  });

  return createVaultPersistenceService(deployment, {
    resolveCapability: async (input) => {
      assertCapabilityInput(input);
      const data = await invoker.invoke(VAULT_RPC.resolveCapability, {
        p_vault_id: input.vaultId,
        p_capability: input.invitationCapability,
      });
      const result = mapVaultCapabilityResolution(data);
      if (result.vaultId !== input.vaultId) {
        throw new VaultError("VAULT_INTERNAL", "Invalid Vault RPC response.");
      }
      return result;
    },
    loadSnapshot: async (input) => {
      assertCapabilityInput(input);
      const data = await invoker.invoke(VAULT_RPC.loadSnapshot, {
        p_vault_id: input.vaultId,
        p_capability: input.invitationCapability,
      });
      if (data === null) {
        return null;
      }
      const result = mapVaultSnapshotRecord(data);
      if (result.vaultId !== input.vaultId) {
        throw new VaultError("VAULT_INTERNAL", "Invalid Vault RPC response.");
      }
      return result;
    },
    casSnapshot: async (input: VaultSnapshotCasInput) => {
      assertCapabilityInput(input);
      if (
        !Number.isSafeInteger(input.expectedGeneration) ||
        input.expectedGeneration < 0
      ) {
        throw new VaultError(
          "VAULT_ENVELOPE_INVALID",
          "Invalid Vault snapshot generation.",
        );
      }
      assertCiphertextBytes(
        input.ciphertextBytes,
        MAX_SNAPSHOT_CIPHERTEXT_BYTES,
      );
      assertVaultEncryptedEnvelopeV1(input.envelope);
      if (
        input.envelope.purpose !== "snapshot" ||
        input.envelope.vaultId !== input.vaultId ||
        input.envelope.generation !== input.expectedGeneration + 1 ||
        base64UrlToBytes(input.envelope.ciphertext).byteLength !==
          input.ciphertextBytes
      ) {
        throw new VaultError(
          "VAULT_ENVELOPE_INVALID",
          "Invalid Vault snapshot.",
        );
      }
      const data = await invoker.invoke(VAULT_RPC.casSnapshot, {
        p_vault_id: input.vaultId,
        p_capability: input.invitationCapability,
        p_expected_generation: input.expectedGeneration,
        p_encrypted_envelope: input.envelope,
        p_ciphertext_bytes: input.ciphertextBytes,
      });
      const result = mapVaultSnapshotCasResult(data);
      if (
        result.vaultId !== input.vaultId ||
        result.generation !== input.expectedGeneration + 1
      ) {
        throw new VaultError("VAULT_INTERNAL", "Invalid Vault RPC response.");
      }
      return result;
    },
    registerAsset: async (input: VaultAssetRegistrationInput) => {
      assertCapabilityInput(input);
      assertFileId(input.fileId);
      assertCiphertextBytes(input.ciphertextBytes, MAX_ASSET_CIPHERTEXT_BYTES);
      if (
        input.encryptedDigest.length !== 43 ||
        !isCanonicalBase64Url(input.encryptedDigest, 32)
      ) {
        throw new VaultError(
          "VAULT_ENVELOPE_INVALID",
          "Invalid Vault asset digest.",
        );
      }
      const data = await invoker.invoke(VAULT_RPC.registerAsset, {
        p_vault_id: input.vaultId,
        p_capability: input.invitationCapability,
        p_file_id: input.fileId,
        p_encrypted_digest: input.encryptedDigest,
        p_ciphertext_bytes: input.ciphertextBytes,
      });
      const result = mapVaultAssetRegistrationResult(data);
      if (result.vaultId !== input.vaultId || result.fileId !== input.fileId) {
        throw new VaultError("VAULT_INTERNAL", "Invalid Vault RPC response.");
      }
      return result;
    },
    resolveAsset: async (input) => {
      assertCapabilityInput(input);
      assertFileId(input.fileId);
      const data = await invoker.invoke(VAULT_RPC.resolveAsset, {
        p_vault_id: input.vaultId,
        p_capability: input.invitationCapability,
        p_file_id: input.fileId,
      });
      const result = mapVaultAssetResolution(data);
      if (result.vaultId !== input.vaultId || result.fileId !== input.fileId) {
        throw new VaultError("VAULT_INTERNAL", "Invalid Vault RPC response.");
      }
      return result;
    },
  });
};
