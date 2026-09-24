import { VaultError } from "./errors";
import { loadVaultSnapshot } from "./snapshot";
import { openVaultClientSession, readVaultSessionSecrets } from "./session";

import type { VaultDeploymentReady } from "./capabilities";
import type { VaultLocalStore } from "./local-store/store";
import type { VaultPersistenceService } from "./persistence";
import type { VaultClientSession } from "./session";
import type { VaultLinkData } from "./types";

export interface OpenedVault<TSnapshot> {
  readonly session: VaultClientSession;
  readonly snapshot: TSnapshot;
  readonly generation: number;
  readonly isEmpty: boolean;
  readonly syncStatus: "synced" | "unsynced";
  readonly localStore?: VaultLocalStore;
}

export const openVault = async <TSnapshot>(input: {
  deployment: VaultDeploymentReady;
  persistence: VaultPersistenceService;
  link: VaultLinkData;
  createEmptySnapshot: () => TSnapshot;
  senderSessionId?: string;
  localStore?: VaultLocalStore;
}): Promise<OpenedVault<TSnapshot>> => {
  const session = await openVaultClientSession({
    deployment: input.deployment,
    persistence: input.persistence,
    link: input.link,
    senderSessionId: input.senderSessionId,
  });
  const secrets = readVaultSessionSecrets(session);
  const retainedLocalStore =
    session.role === "editor" ? input.localStore : undefined;
  if (session.role !== "editor") {
    input.localStore?.close();
  }
  const loaded = await loadVaultSnapshot<TSnapshot>({
    persistence: input.persistence,
    vaultId: session.vaultId,
    invitationCapability: secrets.invitationCapability,
    rootKey: secrets.rootKey,
  });
  let localPending = false;
  let localSnapshot: {
    snapshot: TSnapshot;
    generation: number;
    updatedAt: number;
  } | null = null;
  if (retainedLocalStore) {
    const pendingOutbox = await retainedLocalStore.listOutbox({
      vaultId: session.vaultId,
      roomId: session.admission.activeRoomId,
    });
    if (pendingOutbox.length > 0) {
      localSnapshot = await retainedLocalStore.getSnapshot<TSnapshot>({
        vaultId: session.vaultId,
        roomId: session.admission.activeRoomId,
        rootKey: secrets.rootKey,
      });
      if (!localSnapshot) {
        throw new VaultError(
          "VAULT_LOCAL_STORAGE_UNAVAILABLE",
          "Vault outbox has no matching local snapshot.",
        );
      }
      localPending = true;
    }
  }
  if (loaded === null) {
    if (session.snapshotGeneration !== 0) {
      throw new VaultError(
        "VAULT_PERSISTENCE_UNAVAILABLE",
        "Vault snapshot is missing.",
      );
    }
    return Object.freeze({
      session,
      snapshot: localSnapshot?.snapshot ?? input.createEmptySnapshot(),
      generation: 0,
      isEmpty: !localPending,
      syncStatus: localPending ? ("unsynced" as const) : ("synced" as const),
      localStore: retainedLocalStore,
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
    snapshot: localSnapshot?.snapshot ?? loaded.snapshot,
    generation: loaded.generation,
    isEmpty: false,
    syncStatus: localPending ? ("unsynced" as const) : ("synced" as const),
    localStore: retainedLocalStore,
  });
};
