import { generateVaultInvitationCapability } from "./crypto";
import { VaultError } from "./errors";
import { assertVaultOwnerService } from "./owner";
import { getVaultLink } from "./url";

import type { VaultErrorCode } from "./errors";
import type { VaultOwnerService } from "./owner";
import type { VaultRole } from "./types";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CREATE_RESULT_FIELDS = [
  "vaultId",
  "invitationId",
  "role",
  "authorizationVersion",
  "expiresAt",
] as const;
const REVOCATION_FIELDS = [
  "vaultId",
  "invitationId",
  "authorizationVersion",
  "reason",
] as const;

export interface VaultShareInvitationMetadata {
  readonly vaultId: string;
  readonly invitationId: string;
  readonly role: VaultRole;
  readonly authorizationVersion: number;
  readonly expiresAt: number | null;
}

export interface VaultShareInvitationResult {
  /** Bearer secret intended only for the explicit copy/share action. */
  readonly link: string;
  /** Secret-free record safe for invitation management UI enumeration. */
  readonly metadata: VaultShareInvitationMetadata;
}

export interface VaultShareInvitationRevocation {
  readonly vaultId: string;
  readonly invitationId: string;
  readonly authorizationVersion: number;
  readonly reason: "revoked";
}

export interface CreateVaultShareInvitationInput {
  readonly owner: VaultOwnerService;
  readonly vaultId: string;
  readonly rootKey: string;
  readonly role: VaultRole;
  readonly expiresAt: number | null;
  readonly baseUrl?: string;
}

export interface RevokeVaultShareInvitationInput {
  readonly owner: VaultOwnerService;
  readonly vaultId: string;
  readonly invitationId: string;
}

const hasExactFields = (value: object, fields: readonly string[]): boolean => {
  const keys = Object.keys(value);
  return (
    keys.length === fields.length &&
    fields.every((field) => Object.prototype.hasOwnProperty.call(value, field))
  );
};

const isAuthorizationVersion = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

const assertRole = (role: VaultRole) => {
  if (role !== "viewer" && role !== "editor") {
    throw new VaultError(
      "VAULT_CAPABILITY_INVALID",
      "Invalid Vault invitation role.",
    );
  }
};

const assertExpiresAt = (expiresAt: number | null) => {
  if (
    expiresAt !== null &&
    (!Number.isSafeInteger(expiresAt) ||
      expiresAt <= Date.now() ||
      !Number.isFinite(new Date(expiresAt).getTime()))
  ) {
    throw new VaultError(
      "VAULT_CAPABILITY_EXPIRED",
      "Vault invitation expiry is invalid.",
    );
  }
};

const toSafeSharingError = (
  error: unknown,
  operation: "creation" | "revocation",
): VaultError => {
  const code: VaultErrorCode =
    error instanceof VaultError ? error.code : "VAULT_INTERNAL";
  return new VaultError(code, `Vault invitation ${operation} failed.`, {
    recoverable: error instanceof VaultError ? error.recoverable : false,
  });
};

/**
 * Creates a viewer/editor invitation without exposing a plain-share fallback.
 * The caller supplies the in-memory root key; it is used only to assemble the
 * returned bearer link and is never passed to the owner service or metadata.
 */
export const createVaultShareInvitation = async (
  input: CreateVaultShareInvitationInput,
): Promise<VaultShareInvitationResult> => {
  try {
    assertVaultOwnerService(input.owner);
    assertRole(input.role);
    assertExpiresAt(input.expiresAt);

    const invitationCapability = generateVaultInvitationCapability();
    const vaultId = input.vaultId.toLowerCase();
    const link = getVaultLink(
      {
        version: 1,
        vaultId,
        rootKey: input.rootKey,
        invitationCapability,
      },
      input.baseUrl,
    );
    const invitation = await input.owner.createInvitation({
      vaultId,
      role: input.role,
      invitationCapability,
      expiresAt: input.expiresAt,
    });

    if (
      !hasExactFields(invitation, CREATE_RESULT_FIELDS) ||
      invitation.vaultId !== vaultId ||
      !UUID_RE.test(invitation.invitationId) ||
      invitation.role !== input.role ||
      !isAuthorizationVersion(invitation.authorizationVersion) ||
      invitation.expiresAt !== input.expiresAt
    ) {
      throw new VaultError(
        "VAULT_INTERNAL",
        "Invalid Vault invitation response.",
      );
    }

    return Object.freeze({
      link,
      metadata: Object.freeze({
        vaultId,
        invitationId: invitation.invitationId.toLowerCase(),
        role: invitation.role,
        authorizationVersion: invitation.authorizationVersion,
        expiresAt: invitation.expiresAt,
      }),
    });
  } catch (error) {
    throw toSafeSharingError(error, "creation");
  }
};

/** Idempotency and authorization-version stability are provided by the owner RPC. */
export const revokeVaultShareInvitation = async (
  input: RevokeVaultShareInvitationInput,
): Promise<VaultShareInvitationRevocation> => {
  try {
    assertVaultOwnerService(input.owner);
    const vaultId = input.vaultId.toLowerCase();
    const invitationId = input.invitationId.toLowerCase();
    if (!UUID_RE.test(vaultId) || !UUID_RE.test(invitationId)) {
      throw new VaultError(
        "VAULT_CAPABILITY_INVALID",
        "Invalid Vault invitation reference.",
      );
    }

    const revocation = await input.owner.revokeInvitation({
      vaultId,
      invitationId,
    });
    if (
      !hasExactFields(revocation, REVOCATION_FIELDS) ||
      revocation.vaultId !== vaultId ||
      revocation.invitationId !== invitationId ||
      !isAuthorizationVersion(revocation.authorizationVersion) ||
      revocation.reason !== "revoked"
    ) {
      throw new VaultError(
        "VAULT_INTERNAL",
        "Invalid Vault invitation revocation response.",
      );
    }

    return Object.freeze({
      vaultId,
      invitationId,
      authorizationVersion: revocation.authorizationVersion,
      reason: "revoked" as const,
    });
  } catch (error) {
    throw toSafeSharingError(error, "revocation");
  }
};
