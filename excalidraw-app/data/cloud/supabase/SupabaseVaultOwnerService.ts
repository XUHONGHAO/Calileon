import { VAULT_RPC } from "../../vault/backendContract";
import {
  assertVaultDeploymentReadyToken,
  type VaultDeploymentReady,
} from "../../vault/capabilities";
import { VAULT_PROTOCOL_VERSION } from "../../vault/constants";
import { hashVaultInvitationCapability } from "../../vault/crypto";
import {
  isVaultErrorCode,
  VaultError,
  type VaultErrorCode,
} from "../../vault/errors";
import {
  createVaultOwnerService,
  type VaultOwnerService,
} from "../../vault/owner";
import { createVaultRpcInvoker } from "../../vault/persistence";

import { getSupabaseClient } from "./client";
import {
  mapVaultOwnerActivateResult,
  mapVaultOwnerCreateResult,
  mapVaultOwnerInvitationResult,
  mapVaultOwnerInvitationRevocation,
  mapVaultOwnerVaultDeletion,
  mapVaultOwnerVaultRevocation,
} from "./vaultMappers";
import {
  mapSupabaseVaultError,
  type SupabaseVaultRpcClient,
} from "./SupabaseVaultPersistenceService";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROOM_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const VAULT_CONTROL_PLANE_FUNCTION = "vault-control-plane";

interface SupabaseVaultFunctionResult {
  data: unknown;
  error: unknown;
}

export interface SupabaseVaultControlPlaneClient {
  invoke(
    functionName: string,
    options: Readonly<{ body: Readonly<Record<string, unknown>> }>,
  ): PromiseLike<SupabaseVaultFunctionResult>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readFunctionErrorCode = async (
  data: unknown,
  error: unknown,
): Promise<VaultErrorCode | null> => {
  if (
    isRecord(data) &&
    typeof data.error === "string" &&
    isVaultErrorCode(data.error)
  ) {
    return data.error;
  }
  if (isRecord(error) && isRecord(error.context)) {
    const context = error.context as {
      clone?: () => unknown;
      json?: () => unknown;
    };
    const response =
      typeof context.clone === "function" ? context.clone() : context;
    if (isRecord(response) && typeof response.json === "function") {
      try {
        const body = await response.json();
        if (
          isRecord(body) &&
          typeof body.error === "string" &&
          isVaultErrorCode(body.error)
        ) {
          return body.error;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
};

const assertVaultId = (vaultId: string) => {
  if (!UUID_RE.test(vaultId)) {
    throw new VaultError("VAULT_URL_INVALID", "Invalid Vault ID.");
  }
};

const assertInvitationId = (invitationId: string) => {
  if (!UUID_RE.test(invitationId)) {
    throw new VaultError(
      "VAULT_CAPABILITY_INVALID",
      "Invalid Vault invitation ID.",
    );
  }
};

const toRpcTimestamp = (expiresAt: number | null): string | null => {
  if (expiresAt === null) {
    return null;
  }
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now() ||
    !Number.isFinite(new Date(expiresAt).getTime())
  ) {
    throw new VaultError(
      "VAULT_CAPABILITY_EXPIRED",
      "Vault invitation expiry is invalid.",
    );
  }
  return new Date(expiresAt).toISOString();
};

const assertResultVaultId = (actual: string, expected: string) => {
  if (actual !== expected) {
    throw new VaultError("VAULT_INTERNAL", "Invalid Vault RPC response.");
  }
};

export const createSupabaseVaultOwnerService = (
  deployment: VaultDeploymentReady,
  options?: {
    client?: SupabaseVaultRpcClient;
    controlPlaneClient?: SupabaseVaultControlPlaneClient;
  },
): VaultOwnerService => {
  assertVaultDeploymentReadyToken(deployment);
  const supabaseClient = options?.client ? null : getSupabaseClient();
  const client =
    options?.client ?? (supabaseClient as unknown as SupabaseVaultRpcClient);
  const controlPlaneClient =
    options?.controlPlaneClient ??
    (supabaseClient?.functions as unknown as SupabaseVaultControlPlaneClient);
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

  return createVaultOwnerService(deployment, {
    create: async (input) => {
      assertVaultId(input.vaultId);
      const editorExpiresAt = toRpcTimestamp(input.editorExpiresAt);
      const capabilityHash = await hashVaultInvitationCapability(
        input.vaultId,
        input.editorInvitationCapability,
      );
      const data = await invoker.invoke(VAULT_RPC.createVault, {
        p_vault_id: input.vaultId,
        p_protocol_version: VAULT_PROTOCOL_VERSION,
        p_editor_capability_hash: capabilityHash,
        p_editor_expires_at: editorExpiresAt,
      });
      const result = mapVaultOwnerCreateResult(data);
      assertResultVaultId(result.vaultId, input.vaultId);
      return result;
    },
    activate: async (input) => {
      assertVaultId(input.vaultId);
      if (!ROOM_ID_RE.test(input.activeRoomId)) {
        throw new VaultError(
          "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
          "Invalid Vault room ID.",
        );
      }
      const data = await invoker.invoke(VAULT_RPC.activateVault, {
        p_vault_id: input.vaultId,
        p_active_room_id: input.activeRoomId,
      });
      const result = mapVaultOwnerActivateResult(data);
      if (
        result.vaultId !== input.vaultId ||
        result.activeRoomId !== input.activeRoomId
      ) {
        throw new VaultError("VAULT_INTERNAL", "Invalid Vault RPC response.");
      }
      return result;
    },
    failCreation: async (vaultId) => {
      assertVaultId(vaultId);
      const data = await invoker.invoke(VAULT_RPC.failVaultCreation, {
        p_vault_id: vaultId,
      });
      if (data !== null) {
        throw new VaultError("VAULT_INTERNAL", "Invalid Vault RPC response.");
      }
    },
    createInvitation: async (input) => {
      assertVaultId(input.vaultId);
      if (input.role !== "viewer" && input.role !== "editor") {
        throw new VaultError(
          "VAULT_CAPABILITY_INVALID",
          "Invalid Vault invitation role.",
        );
      }
      const expiresAt = toRpcTimestamp(input.expiresAt);
      const capabilityHash = await hashVaultInvitationCapability(
        input.vaultId,
        input.invitationCapability,
      );
      const data = await invoker.invoke(VAULT_RPC.createInvitation, {
        p_vault_id: input.vaultId,
        p_role: input.role,
        p_capability_hash: capabilityHash,
        p_expires_at: expiresAt,
      });
      const result = mapVaultOwnerInvitationResult(data);
      if (result.vaultId !== input.vaultId || result.role !== input.role) {
        throw new VaultError("VAULT_INTERNAL", "Invalid Vault RPC response.");
      }
      return result;
    },
    revokeInvitation: async (input) => {
      assertVaultId(input.vaultId);
      assertInvitationId(input.invitationId);
      if (!controlPlaneClient) {
        throw new VaultError(
          "VAULT_PERSISTENCE_UNAVAILABLE",
          "Vault control plane is unavailable.",
          { recoverable: true },
        );
      }
      let data: unknown;
      try {
        const result = await controlPlaneClient.invoke(
          VAULT_CONTROL_PLANE_FUNCTION,
          {
            body: {
              action: "revoke-invitation",
              vaultId: input.vaultId,
              invitationId: input.invitationId,
            },
          },
        );
        if (result.error) {
          const code = await readFunctionErrorCode(result.data, result.error);
          if (code) {
            throw new VaultError(code, "Vault invitation revocation failed.");
          }
          throw result.error;
        }
        data = result.data;
      } catch (error) {
        throw mapSupabaseVaultError(error);
      }
      const result = mapVaultOwnerInvitationRevocation(data);
      if (
        result.vaultId !== input.vaultId ||
        result.invitationId !== input.invitationId
      ) {
        throw new VaultError("VAULT_INTERNAL", "Invalid Vault RPC response.");
      }
      return result;
    },
    revokeVault: async (vaultId) => {
      assertVaultId(vaultId);
      const data = await invoker.invoke(VAULT_RPC.revokeVault, {
        p_vault_id: vaultId,
      });
      const result = mapVaultOwnerVaultRevocation(data);
      assertResultVaultId(result.vaultId, vaultId);
      return result;
    },
    softDeleteVault: async (vaultId) => {
      assertVaultId(vaultId);
      const data = await invoker.invoke(VAULT_RPC.softDeleteVault, {
        p_vault_id: vaultId,
      });
      const result = mapVaultOwnerVaultDeletion(data);
      assertResultVaultId(result.vaultId, vaultId);
      return result;
    },
  });
};
