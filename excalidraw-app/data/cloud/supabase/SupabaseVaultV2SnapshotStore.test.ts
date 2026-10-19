import { beforeEach, describe, expect, it, vi } from "vitest";

import { VaultError } from "../../vault/errors";

import {
  VAULT_V2_RPC,
  createSupabaseVaultV2Creator,
  createSupabaseVaultV2SnapshotStore,
} from "./SupabaseVaultV2SnapshotStore";

import type { VaultEnvelopeV2 } from "../../vault/v2/protocol";
import type { SupabaseVaultRpcClient } from "./SupabaseVaultPersistenceService";

const VAULT_ID = "123e4567-e89b-42d3-a456-426614174000";
const SNAPSHOT_ID = "423e4567-e89b-42d3-a456-426614174000";
const CAPABILITY = "A".repeat(43);

const chunk = (
  generation: number,
  chunkIndex: number,
  chunkCount: number,
): VaultEnvelopeV2 => ({
  version: 2,
  schemaVersion: 2,
  protocolVersion: 2,
  vaultId: VAULT_ID,
  roomId: "room_1",
  purpose: "snapshot",
  messageType: "snapshot.scene",
  messageId: `323e4567-e89b-42d3-a456-42661417400${chunkIndex}`,
  generation,
  chunkIndex,
  chunkCount,
  iv: "AAAAAAAAAAAAAAAA",
  ciphertext: "A".repeat(22),
});

const rpc = vi.fn();
const client: SupabaseVaultRpcClient = { rpc };
const store = () =>
  createSupabaseVaultV2SnapshotStore({
    vaultId: VAULT_ID,
    invitationCapability: CAPABILITY,
    client,
  });

describe("SupabaseVaultV2SnapshotStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects malformed Vault IDs and capabilities before any RPC", () => {
    expect(() =>
      createSupabaseVaultV2SnapshotStore({
        vaultId: "nope",
        invitationCapability: CAPABILITY,
        client,
      }),
    ).toThrow(VaultError);
    expect(() =>
      createSupabaseVaultV2SnapshotStore({
        vaultId: VAULT_ID,
        invitationCapability: "short",
        client,
      }),
    ).toThrow(VaultError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("loads null before the first snapshot", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(store().load()).resolves.toBeNull();
    expect(rpc).toHaveBeenCalledWith(VAULT_V2_RPC.loadSnapshot, {
      p_vault_id: VAULT_ID,
      p_capability: CAPABILITY,
    });
  });

  it("loads ordered chunks of the current generation", async () => {
    const chunks = [chunk(3, 0, 2), chunk(3, 1, 2)];
    rpc.mockResolvedValueOnce({
      data: {
        vaultId: VAULT_ID,
        generation: 3,
        snapshotId: SNAPSHOT_ID,
        chunks,
        updatedAt: "2026-10-16T00:00:00Z",
      },
      error: null,
    });
    await expect(store().load()).resolves.toEqual({
      generation: 3,
      envelopes: chunks,
    });
  });

  it("refuses chunks from another generation, Vault or order", async () => {
    for (const chunks of [
      [chunk(2, 0, 1)],
      [chunk(3, 1, 2), chunk(3, 0, 2)],
      [{ ...chunk(3, 0, 1), vaultId: SNAPSHOT_ID }],
      [{ ...chunk(3, 0, 1), extra: true }],
    ]) {
      rpc.mockResolvedValueOnce({
        data: { vaultId: VAULT_ID, generation: 3, chunks },
        error: null,
      });
      await expect(store().load()).rejects.toThrow(VaultError);
    }
  });

  it("commits a snapshot with CAS and returns the server generation", async () => {
    const envelopes = [chunk(5, 0, 1)];
    rpc.mockResolvedValueOnce({
      data: { vaultId: VAULT_ID, snapshotId: SNAPSHOT_ID, generation: 5 },
      error: null,
    });
    await expect(
      store().cas({
        expectedGeneration: 4,
        snapshotId: SNAPSHOT_ID,
        envelopes,
      }),
    ).resolves.toEqual({ ok: true, generation: 5 });
    expect(rpc).toHaveBeenCalledWith(VAULT_V2_RPC.casSnapshot, {
      p_vault_id: VAULT_ID,
      p_capability: CAPABILITY,
      p_expected_generation: 4,
      p_snapshot_id: SNAPSHOT_ID,
      p_chunks: envelopes,
    });
  });

  it("maps a CAS conflict to a merge-and-retry result", async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "P0001", message: "VAULT_SNAPSHOT_CONFLICT" },
    });
    await expect(
      store().cas({
        expectedGeneration: 0,
        snapshotId: SNAPSHOT_ID,
        envelopes: [chunk(1, 0, 1)],
      }),
    ).resolves.toEqual({ ok: false, reason: "conflict" });
  });

  it("surfaces other server errors as stable Vault errors", async () => {
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "P0001", message: "VAULT_CAPABILITY_FORBIDDEN" },
    });
    await expect(
      store().cas({
        expectedGeneration: 0,
        snapshotId: SNAPSHOT_ID,
        envelopes: [chunk(1, 0, 1)],
      }),
    ).rejects.toMatchObject({ code: "VAULT_CAPABILITY_FORBIDDEN" });
  });

  it("never sends chunks that do not belong to the next generation", async () => {
    await expect(
      store().cas({
        expectedGeneration: 0,
        snapshotId: SNAPSHOT_ID,
        envelopes: [chunk(2, 0, 1)],
      }),
    ).rejects.toThrow(VaultError);
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("createSupabaseVaultV2Creator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends only the capability hash and checks the v2 result", async () => {
    rpc.mockResolvedValueOnce({
      data: {
        vaultId: VAULT_ID,
        state: "creating",
        invitationId: SNAPSHOT_ID,
        snapshotGeneration: 0,
        protocolVersion: 2,
      },
      error: null,
    });
    const create = createSupabaseVaultV2Creator({ client });
    await expect(
      create({
        vaultId: VAULT_ID,
        editorInvitationCapability: CAPABILITY,
        editorExpiresAt: null,
      }),
    ).resolves.toEqual({ vaultId: VAULT_ID, invitationId: SNAPSHOT_ID });
    const [name, params] = rpc.mock.calls[0];
    expect(name).toBe(VAULT_V2_RPC.createVault);
    expect(Object.keys(params).sort()).toEqual([
      "p_editor_capability_hash",
      "p_editor_expires_at",
      "p_vault_id",
    ]);
    expect(params.p_editor_capability_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(params.p_editor_capability_hash).not.toBe(CAPABILITY);
  });

  it("rejects a v1 create result", async () => {
    rpc.mockResolvedValueOnce({
      data: {
        vaultId: VAULT_ID,
        state: "creating",
        invitationId: SNAPSHOT_ID,
        snapshotGeneration: 0,
      },
      error: null,
    });
    await expect(
      createSupabaseVaultV2Creator({ client })({
        vaultId: VAULT_ID,
        editorInvitationCapability: CAPABILITY,
        editorExpiresAt: null,
      }),
    ).rejects.toThrow(VaultError);
  });
});
