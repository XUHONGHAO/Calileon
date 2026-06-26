import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSupabaseCollabPersistenceService } from "./SupabaseCollabPersistenceService";

const mockRpc = vi.fn();

vi.mock("./client", () => ({
  getSupabaseClient: () => ({
    rpc: mockRpc,
  }),
  hasSupabaseConfig: () => true,
}));

describe("SupabaseCollabPersistenceService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saves encrypted snapshots through the room snapshot RPC", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });

    await createSupabaseCollabPersistenceService().saveSnapshot({
      roomId: "room-1",
      iv: new Uint8Array([1, 2, 3]),
      encryptedData: new Uint8Array([4, 5, 6]).buffer,
      updatedAt: 0,
    });

    expect(mockRpc).toHaveBeenCalledWith("save_collab_room_snapshot", {
      p_room_id: "room-1",
      p_encrypted_payload: {
        version: 1,
        iv: "AQID",
        ciphertext: "BAUG",
      },
    });
  });

  it("checks whether a collaboration room is still active", async () => {
    mockRpc.mockResolvedValue({ data: "revoked", error: null });

    const isActive =
      await createSupabaseCollabPersistenceService().isRoomActive("room-1");

    expect(isActive).toBe(false);
    expect(mockRpc).toHaveBeenCalledWith("get_collab_room_access", {
      p_room_id: "room-1",
    });
  });

  it("allows ordinary rooms that have no cloud binding metadata", async () => {
    mockRpc.mockResolvedValue({ data: "unknown", error: null });

    await expect(
      createSupabaseCollabPersistenceService().isRoomActive("room-1"),
    ).resolves.toBe(true);
  });

  it("loads encrypted snapshots from the room snapshot RPC", async () => {
    mockRpc.mockResolvedValue({
      data: {
        room_id: "room-1",
        encrypted_payload: {
          version: 1,
          iv: "AQID",
          ciphertext: "BAUG",
        },
        updated_at: "2026-06-25T01:00:00.000Z",
      },
      error: null,
    });

    const snapshot =
      await createSupabaseCollabPersistenceService().loadSnapshot("room-1");

    expect(snapshot?.roomId).toBe("room-1");
    expect(Array.from(snapshot?.iv ?? [])).toEqual([1, 2, 3]);
    expect(Array.from(new Uint8Array(snapshot?.encryptedData ?? []))).toEqual([
      4, 5, 6,
    ]);
  });
});
