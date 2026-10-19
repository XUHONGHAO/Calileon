/**
 * Vault v2 (P4c) share link: `#vault=2&id=…&key=…&cap=…`.
 *
 * Same fields as v1 (url.ts), only the marker value differs. A v1 client
 * reading a v2 link throws `VAULT_PROTOCOL_UNSUPPORTED` (fail closed) instead
 * of opening the Vault through the v1 path. v1 links are left to url.ts.
 */
import { VAULT_BASE64URL_SECRET_LENGTH, VAULT_URL_MARKER } from "../constants";
import { isCanonicalBase64Url } from "../encoding";
import { VaultError } from "../errors";

export const VAULT_V2_URL_VERSION = "2" as const;

export type VaultV2LinkData = {
  readonly version: 2;
  readonly vaultId: string;
  readonly rootKey: string;
  readonly invitationCapability: string;
};

const FIELDS = [VAULT_URL_MARKER, "id", "key", "cap"] as const;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isSecret = (value: string | null): value is string =>
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

/** true only for a `vault=2` marker; v1 and non-Vault links return false */
export const isVaultV2Link = (link: string): boolean =>
  new URLSearchParams(toUrl(link).hash.slice(1)).get(VAULT_URL_MARKER) ===
  VAULT_V2_URL_VERSION;

export const getVaultV2LinkData = (link: string): VaultV2LinkData | null => {
  const params = new URLSearchParams(toUrl(link).hash.slice(1));
  if (params.get(VAULT_URL_MARKER) !== VAULT_V2_URL_VERSION) {
    return null;
  }
  const keys = [...params.keys()];
  if (
    keys.length !== FIELDS.length ||
    !FIELDS.every(
      (field) => params.getAll(field).length === 1 && keys.includes(field),
    )
  ) {
    throw new VaultError("VAULT_URL_INVALID", "Invalid Vault URL fields.");
  }
  const vaultId = params.get("id");
  const rootKey = params.get("key");
  const invitationCapability = params.get("cap");
  if (
    !vaultId ||
    !UUID_RE.test(vaultId) ||
    !isSecret(rootKey) ||
    !isSecret(invitationCapability)
  ) {
    throw new VaultError("VAULT_URL_INVALID", "Invalid Vault URL values.");
  }
  return Object.freeze({
    version: 2,
    vaultId: vaultId.toLowerCase(),
    rootKey,
    invitationCapability,
  });
};

export const getVaultV2Link = (
  data: Omit<VaultV2LinkData, "version">,
  baseUrl = window.location.href,
): string => {
  const url = toUrl(baseUrl);
  const params = new URLSearchParams();
  params.set(VAULT_URL_MARKER, VAULT_V2_URL_VERSION);
  params.set("id", data.vaultId.toLowerCase());
  params.set("key", data.rootKey);
  params.set("cap", data.invitationCapability);
  const link = `${url.origin}${url.pathname}#${params.toString()}`;
  getVaultV2LinkData(link);
  return link;
};
