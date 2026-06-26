import type {
  CollabRoomCreateInput,
  CollabRoomRecord,
  CollabRoomStatus,
} from "../types";

export interface CollabRoomRow {
  id: string;
  owner_id: string;
  scene_id: string;
  room_id: string;
  status: string;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

const toEpochMs = (value: string | null): number => {
  if (!value) {
    return 0;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
};

const toStatus = (value: string): CollabRoomStatus =>
  value === "revoked" ? "revoked" : "active";

export const rowToCollabRoomRecord = (
  row: CollabRoomRow,
): CollabRoomRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  sceneId: row.scene_id,
  roomId: row.room_id,
  status: toStatus(row.status),
  createdAt: toEpochMs(row.created_at),
  updatedAt: toEpochMs(row.updated_at),
  revokedAt: row.revoked_at ? toEpochMs(row.revoked_at) : null,
});

export const collabRoomCreateToInsert = (
  input: CollabRoomCreateInput,
  ownerId: string,
): Pick<CollabRoomRow, "owner_id" | "scene_id" | "room_id" | "status"> => ({
  owner_id: ownerId,
  scene_id: input.sceneId,
  room_id: input.roomId,
  status: "active",
});
