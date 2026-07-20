import { VaultError } from "./errors";
import { loadVaultSnapshot } from "./snapshot";
import { openVaultClientSession, readVaultSessionSecrets } from "./session";

import type { VaultDeploymentReady } from "./capabilities";
import type { VaultPersistenceService } from "./persistence";
import type { VaultClientSession } from "./session";
import type { VaultLinkData } from "./types";

export interface OpenedVault<TSnapshot> {
  readonly session: VaultClientSession;
  readonly snapshot: TSnapshot;
  readonly generation: number;
  readonly isEmpty: boolean;
  readonly syncStatus: "synced";
}

export const openVault = async <TSnapshot>(input: {
  deployment: VaultDeploymentReady;
  persistence: VaultPersistenceService;
  link: VaultLinkData;
  createEmptySnapshot: () => TSnapshot;
  senderSessionId?: string;
}): Promise<OpenedVault<TSnapshot>> => {
  const session = await openVaultClientSession({
    deployment: input.deployment,
    persistence: input.persistence,
    link: input.link,
    senderSessionId: input.senderSessionId,
  });
  const secrets = readVaultSessionSecrets(session);
  const loaded = await loadVaultSnapshot<TSnapshot>({
    persistence: input.persistence,
    vaultId: session.vaultId,
    invitationCapability: secrets.invitationCapability,
    rootKey: secrets.rootKey,
  });
  if (loaded === null) {
    if (session.snapshotGeneration !== 0) {
      throw new VaultError(
        "VAULT_PERSISTENCE_UNAVAILABLE",
        "Vault snapshot is missing.",
      );
    }
    return Object.freeze({
      session,
      snapshot: input.createEmptySnapshot(),
      generation: 0,
      isEmpty: true,
      syncStatus: "synced" as const,
    });
  }
  if (loaded.generation !== session.snapshotGeneration) {
    throw new VaultError(
      "VAULT_SNAPSHOT_CONFLICT",
      "Vault snapshot generation changed during open.",
      { recoverable: true },
    );
  }
  return Object.freeze({
    session,
    snapshot: loaded.snapshot,
    generation: loaded.generation,
    isEmpty: false,
    syncStatus: "synced" as const,
  });
};
