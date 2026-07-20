import { assertVaultDeploymentReadyToken } from "./capabilities";
import {
  generateVaultInvitationCapability,
  generateVaultRootKey,
} from "./crypto";
import { VaultError } from "./errors";
import { assertVaultOwnerService, provisionVault } from "./owner";
import { getVaultLink } from "./url";

import type { VaultDeploymentReady } from "./capabilities";
import type { VaultOwnerService } from "./owner";
import type { VaultRoomProvisionTransport } from "./roomProvision";

export interface CreatedVault {
  readonly vaultId: string;
  readonly invitationId: string;
  readonly activeRoomId: string;
  readonly editorLink: string;
}

export const createVault = async (input: {
  deployment: VaultDeploymentReady;
  owner: VaultOwnerService;
  rooms: VaultRoomProvisionTransport;
  baseUrl?: string;
}): Promise<CreatedVault> => {
  assertVaultDeploymentReadyToken(input.deployment);
  assertVaultOwnerService(input.owner);
  if (!input.rooms || typeof input.rooms.provision !== "function") {
    throw new VaultError(
      "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
      "Vault room provision transport is unavailable.",
    );
  }
  const vaultId = crypto.randomUUID();
  const rootKey = generateVaultRootKey();
  const editorInvitationCapability = generateVaultInvitationCapability();
  const provisioned = await provisionVault(input.owner, {
    vaultId,
    editorInvitationCapability,
    editorExpiresAt: null,
    createVaultRoom: (context) => input.rooms.provision(context),
  });
  if (provisioned.created.vaultId !== vaultId) {
    throw new VaultError("VAULT_INTERNAL", "Vault creation result is invalid.");
  }
  return Object.freeze({
    vaultId,
    invitationId: provisioned.created.invitationId,
    activeRoomId: provisioned.activated.activeRoomId,
    editorLink: getVaultLink(
      {
        version: 1,
        vaultId,
        rootKey,
        invitationCapability: editorInvitationCapability,
      },
      input.baseUrl,
    ),
  });
};
