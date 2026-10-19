/**
 * Vault v2 (P4c) creation (W2 D-1, ADR 0030 §5 migration 4-A: v2 Vaults are
 * always new). Mirrors v1 `provisionVault`:
 *   create_vault_v2 → provision room → activate_vault,
 * compensating with fail_vault_creation on any failure after the row exists.
 *
 * `activate_vault`, `fail_vault_creation` and room provisioning are
 * protocol-agnostic (they hand out / store an opaque room ID), so the v1
 * owner service and provision transport are reused. Only the create RPC and
 * the link differ.
 */
import {
  generateVaultInvitationCapability,
  generateVaultRootKey,
} from "../crypto";
import { VaultError } from "../errors";
import { assertVaultOwnerService } from "../owner";

import { getVaultV2Link } from "./link";

import type { VaultOwnerService } from "../owner";
import type { VaultRoomProvisionTransport } from "../roomProvision";

export type VaultV2CreateResult = {
  readonly vaultId: string;
  readonly invitationId: string;
};

/** `create_vault_v2` (Supabase adapter: SupabaseVaultV2SnapshotStore.ts) */
export type VaultV2Creator = (input: {
  vaultId: string;
  editorInvitationCapability: string;
  editorExpiresAt: number | null;
}) => Promise<VaultV2CreateResult>;

export type CreatedVaultV2 = {
  readonly vaultId: string;
  readonly invitationId: string;
  readonly activeRoomId: string;
  /** the only carrier of the secrets (like v1); open it with getVaultV2LinkData */
  readonly editorLink: string;
};

/** the client-generated identity of a new v2 Vault (journaled by W4 migration) */
export type VaultV2Identity = {
  readonly vaultId: string;
  readonly rootKey: string;
  readonly invitationCapability: string;
};

export const generateVaultV2Identity = (): VaultV2Identity =>
  Object.freeze({
    vaultId: crypto.randomUUID(),
    rootKey: generateVaultRootKey(),
    invitationCapability: generateVaultInvitationCapability(),
  });

export const createVaultV2 = async (input: {
  createV2: VaultV2Creator;
  owner: VaultOwnerService;
  rooms: VaultRoomProvisionTransport;
  baseUrl?: string;
  /** pre-generated identity (default: a fresh one) */
  identity?: VaultV2Identity;
}): Promise<CreatedVaultV2> => {
  assertVaultOwnerService(input.owner);
  if (!input.rooms || typeof input.rooms.provision !== "function") {
    throw new VaultError(
      "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
      "Vault room provision transport is unavailable.",
    );
  }
  const identity = input.identity ?? generateVaultV2Identity();
  const { vaultId, rootKey } = identity;
  const editorInvitationCapability = identity.invitationCapability;

  const created = await input.createV2({
    vaultId,
    editorInvitationCapability,
    editorExpiresAt: null,
  });
  if (created.vaultId !== vaultId) {
    throw new VaultError("VAULT_INTERNAL", "Vault creation result is invalid.");
  }

  let activeRoomId: string;
  try {
    const room = await input.rooms.provision({
      vaultId,
      invitationId: created.invitationId,
    });
    if (
      typeof room !== "object" ||
      room === null ||
      Object.keys(room).length !== 2 ||
      room.kind !== "vault-room" ||
      typeof room.activeRoomId !== "string"
    ) {
      throw new VaultError(
        "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
        "Vault room provisioning returned an invalid result.",
      );
    }
    const activated = await input.owner.activate({
      vaultId,
      activeRoomId: room.activeRoomId,
    });
    activeRoomId = activated.activeRoomId;
  } catch (error) {
    await input.owner.failCreation(vaultId);
    throw error;
  }

  return Object.freeze({
    vaultId,
    invitationId: created.invitationId,
    activeRoomId,
    editorLink: getVaultV2Link(
      { vaultId, rootKey, invitationCapability: editorInvitationCapability },
      input.baseUrl,
    ),
  });
};
