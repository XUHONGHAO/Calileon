import { describe, expect, it } from "vitest";

import {
  collabRoomCreateToInsert,
  rowToCollabRoomRecord,
} from "./collabRoomMappers";

describe("collabRoomMappers", () => {
  it("maps collab room rows into domain records", () => {
    expect(
      rowToCollabRoomRecord({
        id: "binding-1",
        owner_id: "owner-1",
        scene_id: "scene-1",
        room_id: "room-1",
        status: "active",
        created_at: "2026-06-25T01:00:00.000Z",
        updated_at: "2026-06-25T01:00:01.000Z",
        revoked_at: null,
      }),
    ).toMatchObject({
      id: "binding-1",
      ownerId: "owner-1",
      sceneId: "scene-1",
      roomId: "room-1",
      status: "active",
      revokedAt: null,
    });
  });

  it("builds owner-scoped insert payloads without room keys", () => {
    expect(
      collabRoomCreateToInsert(
        {
          sceneId: "scene-1",
          roomId: "room-1",
        },
        "owner-1",
      ),
    ).toEqual({
      owner_id: "owner-1",
      scene_id: "scene-1",
      room_id: "room-1",
      status: "active",
    });
  });
});
