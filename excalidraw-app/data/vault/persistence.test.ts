import { describe, expect, it, vi } from "vitest";

import { VAULT_RPC } from "./backendContract";
import { assertVaultDeploymentReady } from "./capabilities";
import {
  VAULT_RPC_ALLOWLIST,
  assertVaultPersistenceService,
  createVaultPersistenceService,
  createVaultRpcInvoker,
  isVaultPersistenceService,
} from "./persistence";

import type { VaultDeploymentCapabilities } from "./types";
import type {
  VaultPersistenceServiceImplementation,
  VaultRpcName,
  VaultRpcTransport,
} from "./persistence";

const readyCapabilities: VaultDeploymentCapabilities = {
  enabled: true,
  protocolVersions: [1],
  roomProtocolVersions: [1],
  invitationService: true,
  encryptedSnapshotPersistence: true,
  encryptedAssetPersistence: true,
};

const createReadyToken = () =>
  assertVaultDeploymentReady(readyCapabilities, {
    isSecureContext: true,
    hasWebCrypto: true,
  });

const createImplementation = (): VaultPersistenceServiceImplementation => ({
  resolveCapability: vi.fn(),
  loadSnapshot: vi.fn(),
  casSnapshot: vi.fn(),
  registerAsset: vi.fn(),
  resolveAsset: vi.fn(),
});

describe("Vault persistence service boundary", () => {
  it("issues a dedicated service only after deployment preflight", () => {
    const service = createVaultPersistenceService(
      createReadyToken(),
      createImplementation(),
    );

    expect(service.kind).toBe("vault-persistence");
    expect(service.protocolVersion).toBe(1);
    expect(isVaultPersistenceService(service)).toBe(true);
    expect(() => assertVaultPersistenceService(service)).not.toThrow();
    expect(Object.keys(service).sort()).toEqual(
      [
        "casSnapshot",
        "kind",
        "loadSnapshot",
        "protocolVersion",
        "registerAsset",
        "resolveAsset",
        "resolveCapability",
      ].sort(),
    );
    expect("saveScene" in service).toBe(false);
    expect("loadScene" in service).toBe(false);
    expect("saveFiles" in service).toBe(false);
  });

  it("rejects forged deployment and persistence tokens", () => {
    const forgedDeployment = {
      kind: "vault-deployment-ready",
      protocolVersion: 1,
    } as unknown as Parameters<typeof createVaultPersistenceService>[0];

    expect(() =>
      createVaultPersistenceService(forgedDeployment, createImplementation()),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_PERSISTENCE_UNAVAILABLE" }),
    );
    expect(() =>
      assertVaultPersistenceService({
        kind: "vault-persistence",
        protocolVersion: 1,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_PERSISTENCE_UNAVAILABLE" }),
    );
  });
});

describe("Vault RPC fail-closed allowlist", () => {
  it("contains only the frozen Vault RPC contract", () => {
    expect(VAULT_RPC_ALLOWLIST).toEqual(Object.values(VAULT_RPC));
    expect(VAULT_RPC_ALLOWLIST.every((name) => name.includes("vault"))).toBe(
      true,
    );
  });

  it("invokes an allowlisted Vault RPC", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    const invoker = createVaultRpcInvoker(createReadyToken(), { invoke });

    await expect(
      invoker.invoke(VAULT_RPC.loadSnapshot, {
        p_vault_id: "vault-id",
        p_capability: "capability",
      }),
    ).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith(VAULT_RPC.loadSnapshot, {
      p_vault_id: "vault-id",
      p_capability: "capability",
    });
  });

  it.each([
    "save_collab_room_snapshot",
    "load_collab_room_snapshot",
    "register_collab_room_asset",
    "save_scene",
    "firebase_save",
  ])("rejects non-Vault RPC %s without touching transport", async (rpcName) => {
    const invoke = vi.fn();
    const invoker = createVaultRpcInvoker(createReadyToken(), { invoke });

    await expect(
      invoker.invoke(rpcName as VaultRpcName, {}),
    ).rejects.toMatchObject({ code: "VAULT_PLAIN_FALLBACK_FORBIDDEN" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects an invalid ready token before constructing an invoker", () => {
    const transport: VaultRpcTransport = { invoke: vi.fn() };
    const forged = {
      kind: "vault-deployment-ready",
      protocolVersion: 1,
    } as unknown as Parameters<typeof createVaultRpcInvoker>[0];

    expect(() => createVaultRpcInvoker(forged, transport)).toThrowError(
      expect.objectContaining({ code: "VAULT_PERSISTENCE_UNAVAILABLE" }),
    );
    expect(transport.invoke).not.toHaveBeenCalled();
  });
});
