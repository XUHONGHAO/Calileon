import {
  rowToSceneActivityRecord,
  sceneActivityToInsert,
} from "./activityMappers";

const ISO = "2026-06-23T10:00:00.000Z";
const ISO_MS = Date.parse(ISO);

describe("activity mappers", () => {
  it("maps activity rows to domain records", () => {
    expect(
      rowToSceneActivityRecord({
        id: "activity-1",
        owner_id: "owner-1",
        scene_id: "scene-1",
        element_id: "element-1",
        actor_id: "owner-1",
        op_type: "status-change",
        summary: "Approved",
        created_at: ISO,
      }),
    ).toEqual({
      id: "activity-1",
      ownerId: "owner-1",
      sceneId: "scene-1",
      elementId: "element-1",
      actorId: "owner-1",
      operation: "status-change",
      summary: "Approved",
      createdAt: ISO_MS,
    });
  });

  it("stamps owner_id on insert and preserves nullable fields", () => {
    expect(
      sceneActivityToInsert(
        {
          sceneId: "scene-1",
          elementId: null,
          actorId: "anonymous-client",
          operation: "create",
          summary: null,
        },
        "owner-1",
      ),
    ).toEqual({
      owner_id: "owner-1",
      scene_id: "scene-1",
      element_id: null,
      actor_id: "anonymous-client",
      op_type: "create",
      summary: null,
    });
  });

  it("normalizes unknown operations to update", () => {
    expect(
      rowToSceneActivityRecord({
        id: "activity-1",
        owner_id: "owner-1",
        scene_id: "scene-1",
        element_id: null,
        actor_id: "owner-1",
        op_type: "unexpected",
        summary: null,
        created_at: ISO,
      }).operation,
    ).toBe("update");
  });
});
