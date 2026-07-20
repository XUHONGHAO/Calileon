import { issueVaultAdmission } from "./admission";
import { assertVaultDeploymentReadyToken } from "./capabilities";
import { VaultError } from "./errors";
import { assertVaultPersistenceService } from "./persistence";

import type { VaultAdmission } from "./admission";
import type { VaultDeploymentReady } from "./capabilities";
import type { VaultPersistenceService } from "./persistence";
import type { VaultLinkData, VaultRole } from "./types";

const vaultSessionBrand: unique symbol = Symbol("VaultClientSession");
const issuedSessions = new WeakSet<object>();
const sessionSecrets = new WeakMap<
  object,
  Readonly<{ rootKey: string; invitationCapability: string }>
>();

export type VaultSyncStatus =
  | "loading"
  | "synced"
  | "syncing"
  | "unsynced"
  | "revoked"
  | "expired"
  | "closed";

export interface VaultClientSession {
  readonly kind: "vault-client-session";
  readonly vaultId: string;
  readonly role: VaultRole;
  readonly admission: VaultAdmission;
  readonly snapshotGeneration: number;
  readonly syncStatus: VaultSyncStatus;
  readonly [vaultSessionBrand]: true;
}

const createSession = (input: {
  link: VaultLinkData;
  admission: VaultAdmission;
  snapshotGeneration: number;
}): VaultClientSession => {
  const session = Object.freeze({
    kind: "vault-client-session" as const,
    vaultId: input.link.vaultId,
    role: input.admission.role,
    admission: input.admission,
    snapshotGeneration: input.snapshotGeneration,
    syncStatus: "loading" as const,
    [vaultSessionBrand]: true as const,
  });
  issuedSessions.add(session);
  sessionSecrets.set(
    session,
    Object.freeze({
      rootKey: input.link.rootKey,
      invitationCapability: input.link.invitationCapability,
    }),
  );
  return session;
};

export const openVaultClientSession = async (input: {
  deployment: VaultDeploymentReady;
  persistence: VaultPersistenceService;
  link: VaultLinkData;
  senderSessionId?: string;
}): Promise<VaultClientSession> => {
  assertVaultDeploymentReadyToken(input.deployment);
  assertVaultPersistenceService(input.persistence);
  const resolution = await input.persistence.resolveCapability({
    vaultId: input.link.vaultId,
    invitationCapability: input.link.invitationCapability,
  });
  if (resolution.vaultId !== input.link.vaultId) {
    throw new VaultError(
      "VAULT_CAPABILITY_INVALID",
      "Vault capability resolved to a different Vault.",
    );
  }
  const senderSessionId = input.senderSessionId ?? crypto.randomUUID();
  const admission = issueVaultAdmission(
    input.deployment,
    resolution,
    senderSessionId,
  );
  return createSession({
    link: input.link,
    admission,
    snapshotGeneration: resolution.snapshotGeneration,
  });
};

export const isVaultClientSession = (
  value: unknown,
): value is VaultClientSession =>
  typeof value === "object" &&
  value !== null &&
  issuedSessions.has(value) &&
  sessionSecrets.has(value);

export const readVaultSessionSecrets = (
  session: VaultClientSession,
): Readonly<{ rootKey: string; invitationCapability: string }> => {
  if (!isVaultClientSession(session)) {
    throw new VaultError(
      "VAULT_CAPABILITY_INVALID",
      "Vault session proof is missing or invalid.",
    );
  }
  const secrets = sessionSecrets.get(session);
  if (!secrets) {
    throw new VaultError(
      "VAULT_INTERNAL",
      "Vault session secrets are missing.",
    );
  }
  return secrets;
};
