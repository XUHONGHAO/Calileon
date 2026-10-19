/**
 * Vault v2 (P4c) snapshot store over Supabase RPC (W2 D-4/D-6,
 * `schema_vault_v2.sql`). Only ciphertext envelopes cross this boundary; the
 * server never sees keys or plaintext.
 *
 * A snapshot is one or more chunk envelopes committed atomically by
 * `cas_vault_snapshot_v2`; `load_vault_snapshot_v2` returns the chunks of the
 * current generation in order (or null before the first snapshot).
 */
import { hashVaultInvitationCapability } from "../../vault/crypto";
import { isCanonicalBase64Url } from "../../vault/encoding";
import { VaultError } from "../../vault/errors";
import {
  VAULT_V2_MAX_CHUNKS,
  assertVaultEnvelopeV2,
} from "../../vault/v2/protocol";

import { getSupabaseClient } from "./client";
import { mapSupabaseVaultError } from "./SupabaseVaultPersistenceService";

import type { SupabaseVaultRpcClient } from "./SupabaseVaultPersistenceService";
import type { VaultV2Creator } from "../../vault/v2/creation";
import type { VaultEnvelopeV2 } from "../../vault/v2/protocol";
import type { VaultV2SnapshotStore } from "../../vault/v2/syncEngine";

export const VAULT_V2_RPC = {
  createVault: "create_vault_v2",
  resolveCapability: "resolve_vault_capability_v2",
  loadSnapshot: "load_vault_snapshot_v2",
  casSnapshot: "cas_vault_snapshot_v2",
} as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalidResponse = () =>
  new VaultError("VAULT_INTERNAL", "Invalid Vault RPC response.");

const assertGeneration = (value: unknown, minimum: number): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw invalidResponse();
  }
  return value;
};

/** `create_vault_v2`: the capability is hashed client-side like v1 */
export const createSupabaseVaultV2Creator =
  (options?: { client?: SupabaseVaultRpcClient }): VaultV2Creator =>
  async (input) => {
    if (!UUID_RE.test(input.vaultId)) {
      throw new VaultError("VAULT_URL_INVALID", "Invalid Vault ID.");
    }
    if (
      input.editorExpiresAt !== null &&
      (!Number.isSafeInteger(input.editorExpiresAt) ||
        input.editorExpiresAt <= Date.now())
    ) {
      throw new VaultError(
        "VAULT_CAPABILITY_EXPIRED",
        "Vault invitation expiry is invalid.",
      );
    }
    const client =
      options?.client ??
      (getSupabaseClient() as unknown as SupabaseVaultRpcClient);
    let data: unknown;
    try {
      const result = await client.rpc(VAULT_V2_RPC.createVault, {
        p_vault_id: input.vaultId,
        p_editor_capability_hash: await hashVaultInvitationCapability(
          input.vaultId,
          input.editorInvitationCapability,
        ),
        p_editor_expires_at:
          input.editorExpiresAt === null
            ? null
            : new Date(input.editorExpiresAt).toISOString(),
      });
      if (result.error) {
        throw result.error;
      }
      data = result.data;
    } catch (error) {
      throw mapSupabaseVaultError(error);
    }
    if (
      !isRecord(data) ||
      data.vaultId !== input.vaultId ||
      data.state !== "creating" ||
      data.snapshotGeneration !== 0 ||
      data.protocolVersion !== 2 ||
      typeof data.invitationId !== "string" ||
      !UUID_RE.test(data.invitationId)
    ) {
      throw invalidResponse();
    }
    return { vaultId: input.vaultId, invitationId: data.invitationId };
  };

export const createSupabaseVaultV2SnapshotStore = (input: {
  vaultId: string;
  invitationCapability: string;
  client?: SupabaseVaultRpcClient;
}): VaultV2SnapshotStore => {
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
  const vaultId = input.vaultId.toLowerCase();
  const client =
    input.client ?? (getSupabaseClient() as unknown as SupabaseVaultRpcClient);

  const invoke = async (
    rpcName: string,
    params: Readonly<Record<string, unknown>>,
  ): Promise<unknown> => {
    try {
      const { data, error } = await client.rpc(rpcName, params);
      if (error) {
        throw error;
      }
      return data;
    } catch (error) {
      throw mapSupabaseVaultError(error);
    }
  };

  const assertChunks = (
    chunks: readonly unknown[],
    generation: number,
  ): VaultEnvelopeV2[] => {
    if (chunks.length < 1 || chunks.length > VAULT_V2_MAX_CHUNKS) {
      throw invalidResponse();
    }
    return chunks.map((chunk, index) => {
      assertVaultEnvelopeV2(chunk);
      if (
        chunk.vaultId.toLowerCase() !== vaultId ||
        chunk.purpose !== "snapshot" ||
        chunk.messageType !== "snapshot.scene" ||
        chunk.generation !== generation ||
        chunk.chunkIndex !== index ||
        chunk.chunkCount !== chunks.length
      ) {
        throw new VaultError(
          "VAULT_ENVELOPE_INVALID",
          "Invalid Vault v2 snapshot chunk.",
        );
      }
      return chunk;
    });
  };

  return {
    load: async () => {
      const data = await invoke(VAULT_V2_RPC.loadSnapshot, {
        p_vault_id: vaultId,
        p_capability: input.invitationCapability,
      });
      if (data === null) {
        return null;
      }
      if (
        !isRecord(data) ||
        typeof data.vaultId !== "string" ||
        data.vaultId.toLowerCase() !== vaultId ||
        !Array.isArray(data.chunks)
      ) {
        throw invalidResponse();
      }
      const generation = assertGeneration(data.generation, 1);
      return { generation, envelopes: assertChunks(data.chunks, generation) };
    },

    cas: async ({ expectedGeneration, snapshotId, envelopes }) => {
      if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
        throw new VaultError(
          "VAULT_ENVELOPE_INVALID",
          "Invalid Vault snapshot generation.",
        );
      }
      if (!UUID_RE.test(snapshotId)) {
        throw new VaultError("VAULT_ENVELOPE_INVALID", "Invalid snapshot ID.");
      }
      assertChunks(envelopes, expectedGeneration + 1);
      let data: unknown;
      try {
        data = await invoke(VAULT_V2_RPC.casSnapshot, {
          p_vault_id: vaultId,
          p_capability: input.invitationCapability,
          p_expected_generation: expectedGeneration,
          p_snapshot_id: snapshotId,
          p_chunks: envelopes,
        });
      } catch (error) {
        if (
          error instanceof VaultError &&
          error.code === "VAULT_SNAPSHOT_CONFLICT"
        ) {
          return { ok: false, reason: "conflict" };
        }
        throw error;
      }
      if (
        !isRecord(data) ||
        typeof data.vaultId !== "string" ||
        data.vaultId.toLowerCase() !== vaultId ||
        typeof data.snapshotId !== "string" ||
        data.snapshotId.toLowerCase() !== snapshotId.toLowerCase()
      ) {
        throw invalidResponse();
      }
      // an idempotent retry returns the original generation (D-4)
      return { ok: true, generation: assertGeneration(data.generation, 1) };
    },
  };
};
