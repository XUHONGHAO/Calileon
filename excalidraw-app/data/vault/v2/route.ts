/**
 * Vault v2 (P4c) entry points for the App (W6). Everything here is gated by
 * `VITE_APP_VAULT_V2_ENABLED === "true"` (default OFF) *and* the deployment
 * advertising protocol 2 on both the persistence and room side.
 *
 * With the flag off nothing in this module runs: a `#vault=2` link then goes
 * down the v1 route, whose parser refuses it with VAULT_PROTOCOL_UNSUPPORTED
 * (fail closed, no plain fallback).
 */
import { VaultError } from "../errors";

import { createVaultV2 } from "./creation";
import { getVaultV2LinkData } from "./link";
import { openVaultV2Session } from "./session";

import type { VaultDeploymentCapabilities } from "../types";
import type { CreatedVaultV2, VaultV2Creator } from "./creation";
import type { VaultV2LinkData } from "./link";
import type { VaultV2LocalStore } from "./localStore";
import type { VaultV2Session, VaultV2SessionSocket } from "./session";
import type { VaultV2SnapshotStore } from "./syncEngine";
import type { VaultOwnerService } from "../owner";
import type { VaultRoomProvisionTransport } from "../roomProvision";

export { isVaultV2Enabled, isVaultV2Route } from "./flag";

export const VAULT_V2_PROTOCOL = 2 as const;

export function assertVaultV2Deployment(
  capabilities: Pick<
    VaultDeploymentCapabilities,
    "protocolVersions" | "roomProtocolVersions"
  >,
) {
  if (!capabilities.protocolVersions.includes(VAULT_V2_PROTOCOL)) {
    throw new VaultError(
      "VAULT_PROTOCOL_UNSUPPORTED",
      "Vault persistence does not support protocol 2.",
    );
  }
  if (!capabilities.roomProtocolVersions.includes(VAULT_V2_PROTOCOL)) {
    throw new VaultError(
      "VAULT_ROOM_PROTOCOL_UNSUPPORTED",
      "Vault room server does not support protocol 2.",
    );
  }
}

export type VaultV2RouteDependencies = {
  /** v1 discovery (deployment readiness) + the raw capability lists */
  discover: () => Promise<
    Pick<
      VaultDeploymentCapabilities,
      "protocolVersions" | "roomProtocolVersions"
    >
  >;
  createSocket: () => VaultV2SessionSocket;
  createSnapshotStore: (input: {
    vaultId: string;
    invitationCapability: string;
  }) => VaultV2SnapshotStore;
  openLocalStore?: () => Promise<VaultV2LocalStore>;
  onStatus?: Parameters<typeof openVaultV2Session>[0]["onStatus"];
  onBlocked?: Parameters<typeof openVaultV2Session>[0]["onBlocked"];
  onError?: (error: unknown) => void;
};

/** opens a `#vault=2` link; throws a VaultError the App renders as blocked */
export const openVaultV2Route = async (
  href: string,
  deps: VaultV2RouteDependencies,
): Promise<{ link: VaultV2LinkData; session: VaultV2Session }> => {
  const link = getVaultV2LinkData(href);
  if (!link) {
    throw new VaultError("VAULT_URL_INVALID", "Invalid Vault URL.");
  }
  assertVaultV2Deployment(await deps.discover());
  let localStore: VaultV2LocalStore | null = null;
  try {
    localStore = (await deps.openLocalStore?.()) ?? null;
  } catch (error) {
    // the local cache is optional; the Vault still opens online
    deps.onError?.(error);
  }
  const socket = deps.createSocket();
  try {
    const session = await openVaultV2Session({
      link,
      socket,
      createSnapshotStore: deps.createSnapshotStore,
      localStore,
      onStatus: deps.onStatus,
      onBlocked: deps.onBlocked,
      onError: deps.onError,
    });
    const dispose = session.dispose;
    return {
      link,
      session: Object.freeze({
        ...session,
        dispose: () => {
          dispose();
          localStore?.close();
        },
      }),
    };
  } catch (error) {
    socket.close?.();
    localStore?.close();
    throw error;
  }
};

/** owner flow: new v2 Vault (never an upgrade of a v1 Vault, ADR 0030 §5) */
export const createVaultV2Route = async (deps: {
  discover: VaultV2RouteDependencies["discover"];
  createV2: VaultV2Creator;
  owner: VaultOwnerService;
  rooms: VaultRoomProvisionTransport;
  baseUrl?: string;
}): Promise<CreatedVaultV2> => {
  assertVaultV2Deployment(await deps.discover());
  return createVaultV2(deps);
};
