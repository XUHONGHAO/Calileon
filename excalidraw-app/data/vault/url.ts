import {
  VAULT_BASE64URL_SECRET_LENGTH,
  VAULT_PROTOCOL_VERSION,
  VAULT_URL_MARKER,
  VAULT_URL_VERSION,
} from "./constants";
import { isCanonicalBase64Url } from "./encoding";
import { VaultError } from "./errors";

import type { VaultLinkData } from "./types";

const VAULT_URL_FIELDS = ["vault", "id", "key", "cap"] as const;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isVaultSecret = (value: string | null): value is string =>
  typeof value === "string" &&
  value.length === VAULT_BASE64URL_SECRET_LENGTH &&
  isCanonicalBase64Url(value, 32);

const toUrl = (link: string): URL => {
  try {
    return new URL(link, window.location.href);
  } catch {
    throw new VaultError("VAULT_URL_INVALID", "Invalid Vault URL.");
  }
};

export const hasVaultUrlMarker = (link: string): boolean => {
  const url = toUrl(link);
  return new URLSearchParams(url.hash.slice(1)).has(VAULT_URL_MARKER);
};

/**
 * Returns null only when the Vault marker is absent. Once `vault` is present,
 * every malformed or unsupported value throws so callers cannot fall through
 * to ordinary collaboration or legacy persistence.
 */
export const getVaultLinkData = (link: string): VaultLinkData | null => {
  const url = toUrl(link);
  const params = new URLSearchParams(url.hash.slice(1));

  if (!params.has(VAULT_URL_MARKER)) {
    return null;
  }

  const keys = [...params.keys()];
  const hasExactFields =
    keys.length === VAULT_URL_FIELDS.length &&
    VAULT_URL_FIELDS.every(
      (field) => params.getAll(field).length === 1 && keys.includes(field),
    );
  if (!hasExactFields) {
    throw new VaultError("VAULT_URL_INVALID", "Invalid Vault URL fields.");
  }

  const version = params.get(VAULT_URL_MARKER);
  if (version !== VAULT_URL_VERSION) {
    throw new VaultError(
      "VAULT_PROTOCOL_UNSUPPORTED",
      "Unsupported Vault protocol version.",
    );
  }

  const vaultId = params.get("id");
  const rootKey = params.get("key");
  const invitationCapability = params.get("cap");

  if (
    !vaultId ||
    !UUID_RE.test(vaultId) ||
    !isVaultSecret(rootKey) ||
    !isVaultSecret(invitationCapability)
  ) {
    throw new VaultError("VAULT_URL_INVALID", "Invalid Vault URL values.");
  }

  return {
    version: VAULT_PROTOCOL_VERSION,
    vaultId: vaultId.toLowerCase(),
    rootKey,
    invitationCapability,
  };
};

export const getVaultLink = (
  data: VaultLinkData,
  baseUrl = window.location.href,
): string => {
  if (data.version !== VAULT_PROTOCOL_VERSION) {
    throw new VaultError(
      "VAULT_PROTOCOL_UNSUPPORTED",
      "Unsupported Vault protocol version.",
    );
  }

  const url = toUrl(baseUrl);
  const params = new URLSearchParams();
  params.set(VAULT_URL_MARKER, VAULT_URL_VERSION);
  params.set("id", data.vaultId.toLowerCase());
  params.set("key", data.rootKey);
  params.set("cap", data.invitationCapability);

  const link = `${url.origin}${url.pathname}#${params.toString()}`;
  getVaultLinkData(link);
  return link;
};
