import { VaultError } from "./errors";

const hasValue = (value: string | undefined): value is string =>
  typeof value === "string" && value.trim().length > 0;

export interface VaultClientConfig {
  readonly enabled: boolean;
  readonly persistenceCapabilitiesUrl: string | null;
  readonly roomCapabilitiesUrl: string | null;
  readonly roomProvisionUrl: string | null;
}

const requireVaultEndpointUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new VaultError(
      "VAULT_PERSISTENCE_UNAVAILABLE",
      "Vault deployment endpoint is invalid.",
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
      "VAULT_PERSISTENCE_UNAVAILABLE",
      "Vault deployment endpoint is invalid.",
    );
  }
  return url.toString();
};

export const readVaultClientConfig = (): VaultClientConfig =>
  Object.freeze({
    enabled: import.meta.env.VITE_APP_VAULT_ENABLED === "true",
    persistenceCapabilitiesUrl: hasValue(
      import.meta.env.VITE_APP_VAULT_PERSISTENCE_CAPABILITIES_URL,
    )
      ? import.meta.env.VITE_APP_VAULT_PERSISTENCE_CAPABILITIES_URL.trim()
      : null,
    roomCapabilitiesUrl: hasValue(
      import.meta.env.VITE_APP_VAULT_ROOM_CAPABILITIES_URL,
    )
      ? import.meta.env.VITE_APP_VAULT_ROOM_CAPABILITIES_URL.trim()
      : null,
    roomProvisionUrl: hasValue(
      import.meta.env.VITE_APP_VAULT_ROOM_PROVISION_URL,
    )
      ? import.meta.env.VITE_APP_VAULT_ROOM_PROVISION_URL.trim()
      : null,
  });

export function assertVaultClientConfig(
  config: VaultClientConfig,
): asserts config is VaultClientConfig & {
  enabled: true;
  persistenceCapabilitiesUrl: string;
  roomCapabilitiesUrl: string;
  roomProvisionUrl: string;
} {
  if (!config.enabled) {
    throw new VaultError(
      "VAULT_PERSISTENCE_UNAVAILABLE",
      "Vault capability is disabled.",
      { recoverable: true },
    );
  }
  if (
    !config.persistenceCapabilitiesUrl ||
    !config.roomCapabilitiesUrl ||
    !config.roomProvisionUrl
  ) {
    throw new VaultError(
      "VAULT_PERSISTENCE_UNAVAILABLE",
      "Vault deployment configuration is incomplete.",
      { recoverable: true },
    );
  }
  requireVaultEndpointUrl(config.persistenceCapabilitiesUrl);
  requireVaultEndpointUrl(config.roomCapabilitiesUrl);
  requireVaultEndpointUrl(config.roomProvisionUrl);
}
