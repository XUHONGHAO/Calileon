import { assertVaultDeploymentReady } from "./capabilities";
import {
  VAULT_DEPLOYMENT_VERSION,
  VAULT_ROOM_SERVER_VERSION,
  VAULT_SCHEMA_VERSION,
} from "./constants";
import { VaultError } from "./errors";

import type {
  VaultDeploymentReady,
  VaultRuntimeSecurityContext,
} from "./capabilities";
import type { VaultDeploymentCapabilities } from "./types";

export interface VaultPersistenceCapabilityDocument {
  deploymentVersion: string;
  schemaVersion: number;
  enabled: boolean;
  protocolVersions: readonly number[];
  invitationService: boolean;
  encryptedSnapshotPersistence: boolean;
  encryptedAssetPersistence: boolean;
}

export interface VaultRoomCapabilityDocument {
  deploymentVersion: string;
  roomServerVersion: number;
  protocolVersions: readonly number[];
}

export interface VaultDeploymentDiscoveryTransport {
  loadPersistenceCapabilities(): Promise<unknown>;
  loadRoomCapabilities(): Promise<unknown>;
}

export interface VaultCapabilityDiscoveryResponse {
  readonly ok: boolean;
  json(): Promise<unknown>;
}

export type VaultCapabilityDiscoveryFetcher = (
  url: string,
  init: {
    method: "GET";
    credentials: "omit";
    cache: "no-store";
    headers: { Accept: "application/json" };
  },
) => Promise<VaultCapabilityDiscoveryResponse>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertExactKeys = (
  value: unknown,
  expected: readonly string[],
  code: "VAULT_PERSISTENCE_UNAVAILABLE" | "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new VaultError(code, "Vault capability discovery failed.");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    !expected.every((key) => keys.includes(key))
  ) {
    throw new VaultError(code, "Vault capability discovery failed.");
  }
  return value;
};

const requireProtocolVersions = (
  value: unknown,
  code: "VAULT_PERSISTENCE_UNAVAILABLE" | "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
): readonly number[] => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (version) =>
        typeof version !== "number" ||
        !Number.isSafeInteger(version) ||
        version < 1,
    )
  ) {
    throw new VaultError(code, "Vault capability discovery failed.");
  }
  return Object.freeze([...new Set(value)]);
};

export const parseVaultPersistenceCapabilities = (
  value: unknown,
): VaultPersistenceCapabilityDocument => {
  const document = assertExactKeys(
    value,
    [
      "deploymentVersion",
      "schemaVersion",
      "enabled",
      "protocolVersions",
      "invitationService",
      "encryptedSnapshotPersistence",
      "encryptedAssetPersistence",
    ],
    "VAULT_PERSISTENCE_UNAVAILABLE",
  );
  if (
    typeof document.deploymentVersion !== "string" ||
    typeof document.schemaVersion !== "number" ||
    !Number.isSafeInteger(document.schemaVersion) ||
    document.schemaVersion < 1 ||
    typeof document.enabled !== "boolean" ||
    typeof document.invitationService !== "boolean" ||
    typeof document.encryptedSnapshotPersistence !== "boolean" ||
    typeof document.encryptedAssetPersistence !== "boolean"
  ) {
    throw new VaultError(
      "VAULT_PERSISTENCE_UNAVAILABLE",
      "Vault capability discovery failed.",
    );
  }
  return Object.freeze({
    deploymentVersion: document.deploymentVersion,
    schemaVersion: document.schemaVersion,
    enabled: document.enabled,
    protocolVersions: requireProtocolVersions(
      document.protocolVersions,
      "VAULT_PERSISTENCE_UNAVAILABLE",
    ),
    invitationService: document.invitationService,
    encryptedSnapshotPersistence: document.encryptedSnapshotPersistence,
    encryptedAssetPersistence: document.encryptedAssetPersistence,
  });
};

export const parseVaultRoomCapabilities = (
  value: unknown,
): VaultRoomCapabilityDocument => {
  const document = assertExactKeys(
    value,
    ["deploymentVersion", "roomServerVersion", "protocolVersions"],
    "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
  );
  if (
    typeof document.deploymentVersion !== "string" ||
    typeof document.roomServerVersion !== "number" ||
    !Number.isSafeInteger(document.roomServerVersion) ||
    document.roomServerVersion < 1
  ) {
    throw new VaultError(
      "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
      "Vault room capability discovery failed.",
    );
  }
  return Object.freeze({
    deploymentVersion: document.deploymentVersion,
    roomServerVersion: document.roomServerVersion,
    protocolVersions: requireProtocolVersions(
      document.protocolVersions,
      "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
    ),
  });
};

const mapDiscoveryFailure = (
  error: unknown,
  code: "VAULT_PERSISTENCE_UNAVAILABLE" | "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
) => {
  if (error instanceof VaultError) {
    return error;
  }
  return new VaultError(code, "Vault capability discovery failed.", {
    recoverable: true,
  });
};

const requireDiscoveryUrl = (
  value: string,
  code: "VAULT_PERSISTENCE_UNAVAILABLE" | "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new VaultError(code, "Vault capability discovery URL is invalid.");
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
    throw new VaultError(code, "Vault capability discovery URL is invalid.");
  }
  return url.toString();
};

export const createHttpVaultDeploymentDiscoveryTransport = (options: {
  persistenceCapabilitiesUrl: string;
  roomCapabilitiesUrl: string;
  fetcher?: VaultCapabilityDiscoveryFetcher;
}): VaultDeploymentDiscoveryTransport => {
  const persistenceUrl = requireDiscoveryUrl(
    options.persistenceCapabilitiesUrl,
    "VAULT_PERSISTENCE_UNAVAILABLE",
  );
  const roomUrl = requireDiscoveryUrl(
    options.roomCapabilitiesUrl,
    "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
  );
  const fetcher: VaultCapabilityDiscoveryFetcher =
    options.fetcher ??
    (async (url, init) => await fetch(url, init as RequestInit));
  const load = async (
    url: string,
    code: "VAULT_PERSISTENCE_UNAVAILABLE" | "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
  ) => {
    const response = await fetcher(url, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new VaultError(code, "Vault capability discovery failed.", {
        recoverable: true,
      });
    }
    return await response.json();
  };
  return Object.freeze({
    loadPersistenceCapabilities: () =>
      load(persistenceUrl, "VAULT_PERSISTENCE_UNAVAILABLE"),
    loadRoomCapabilities: () =>
      load(roomUrl, "VAULT_ROOM_PROTOCOL_UNSUPPORTED"),
  });
};

export const discoverVaultDeployment = async (
  transport: VaultDeploymentDiscoveryTransport,
  runtime?: VaultRuntimeSecurityContext,
): Promise<{
  capabilities: VaultDeploymentCapabilities;
  ready: VaultDeploymentReady;
}> => {
  let persistence: VaultPersistenceCapabilityDocument;
  try {
    persistence = parseVaultPersistenceCapabilities(
      await transport.loadPersistenceCapabilities(),
    );
  } catch (error) {
    throw mapDiscoveryFailure(error, "VAULT_PERSISTENCE_UNAVAILABLE");
  }

  let room: VaultRoomCapabilityDocument;
  try {
    room = parseVaultRoomCapabilities(await transport.loadRoomCapabilities());
  } catch (error) {
    throw mapDiscoveryFailure(error, "VAULT_ROOM_PROTOCOL_UNSUPPORTED");
  }

  if (
    persistence.deploymentVersion !== VAULT_DEPLOYMENT_VERSION ||
    persistence.schemaVersion !== VAULT_SCHEMA_VERSION
  ) {
    throw new VaultError(
      "VAULT_PROTOCOL_UNSUPPORTED",
      "Vault persistence deployment is incompatible.",
    );
  }
  if (
    room.deploymentVersion !== VAULT_DEPLOYMENT_VERSION ||
    room.roomServerVersion !== VAULT_ROOM_SERVER_VERSION
  ) {
    throw new VaultError(
      "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
      "Vault room deployment is incompatible.",
    );
  }

  const capabilities = Object.freeze({
    enabled: persistence.enabled,
    protocolVersions: persistence.protocolVersions,
    roomProtocolVersions: room.protocolVersions,
    invitationService: persistence.invitationService,
    encryptedSnapshotPersistence: persistence.encryptedSnapshotPersistence,
    encryptedAssetPersistence: persistence.encryptedAssetPersistence,
  });

  return {
    capabilities,
    ready: assertVaultDeploymentReady(capabilities, runtime),
  };
};
