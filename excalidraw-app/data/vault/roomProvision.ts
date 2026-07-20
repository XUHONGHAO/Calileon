import { VAULT_PROTOCOL_VERSION } from "./constants";
import { VaultError } from "./errors";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROOM_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;

export interface VaultRoomProvisionTransport {
  provision(input: {
    vaultId: string;
    invitationId: string;
  }): Promise<{ readonly kind: "vault-room"; readonly activeRoomId: string }>;
}

export type VaultRoomProvisionFetcher = (
  url: string,
  init: {
    method: "POST";
    credentials: "omit";
    cache: "no-store";
    headers: Readonly<{
      Accept: "application/json";
      "Content-Type": "application/json";
    }>;
    body: string;
  },
) => Promise<{ readonly ok: boolean; json(): Promise<unknown> }>;

const requireProvisionUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new VaultError(
      "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
      "Vault room provision URL is invalid.",
    );
  }
  const isLocalHttp =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !isLocalHttp) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new VaultError(
      "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
      "Vault room provision URL is invalid.",
    );
  }
  return url.toString();
};

const parseProvisionResponse = (
  value: unknown,
): { readonly kind: "vault-room"; readonly activeRoomId: string } => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VaultError(
      "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
      "Vault room provision response is invalid.",
    );
  }
  const response = value as Record<string, unknown>;
  if (
    Object.keys(response).length !== 2 ||
    response.protocolVersion !== VAULT_PROTOCOL_VERSION ||
    typeof response.activeRoomId !== "string" ||
    !ROOM_ID_RE.test(response.activeRoomId)
  ) {
    throw new VaultError(
      "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
      "Vault room provision response is invalid.",
    );
  }
  return Object.freeze({
    kind: "vault-room" as const,
    activeRoomId: response.activeRoomId,
  });
};

export const createHttpVaultRoomProvisionTransport = (options: {
  provisionUrl: string;
  fetcher?: VaultRoomProvisionFetcher;
}): VaultRoomProvisionTransport => {
  const provisionUrl = requireProvisionUrl(options.provisionUrl);
  const fetcher: VaultRoomProvisionFetcher =
    options.fetcher ??
    (async (url, init) => await fetch(url, init as RequestInit));
  return Object.freeze({
    provision: async (input: { vaultId: string; invitationId: string }) => {
      if (!UUID_RE.test(input.vaultId) || !UUID_RE.test(input.invitationId)) {
        throw new VaultError(
          "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
          "Vault room provision input is invalid.",
        );
      }
      let response: Awaited<ReturnType<VaultRoomProvisionFetcher>>;
      try {
        response = await fetcher(provisionUrl, {
          method: "POST",
          credentials: "omit",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            protocolVersion: VAULT_PROTOCOL_VERSION,
            vaultId: input.vaultId.toLowerCase(),
            invitationId: input.invitationId.toLowerCase(),
          }),
        });
      } catch {
        throw new VaultError(
          "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
          "Vault room provisioning failed.",
          { recoverable: true },
        );
      }
      if (!response.ok) {
        throw new VaultError(
          "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
          "Vault room provisioning failed.",
          { recoverable: true },
        );
      }
      return parseProvisionResponse(await response.json());
    },
  });
};
