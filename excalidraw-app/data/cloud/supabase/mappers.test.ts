import {
  rowToSceneRecord,
  rowToSceneSummary,
  sceneRecordToInsert,
  sceneRecordToUpdate,
} from "./mappers";

import type { SceneRow, SceneSummaryRow } from "./mappers";
import type { SceneRecord } from "../types";

const ISO = "2026-06-20T10:00:00.000Z";
const ISO_MS = Date.parse(ISO);

const fullRow: SceneRow = {
  id: "scene-1",
  owner_id: "user-1",
  title: "My board",
  payload_kind: "plain",
  payload: { type: "excalidraw", elements: [] },
  version: 3,
  thumbnail_meta: { width: 100, height: 80 },
  created_at: ISO,
  updated_at: ISO,
  deleted_at: null,
};

describe("supabase mappers", () => {
  describe("rowToSceneRecord", () => {
    it("maps snake_case row to camelCase SceneRecord with epoch ms", () => {
      expect(rowToSceneRecord(fullRow)).toEqual({
        id: "scene-1",
        ownerId: "user-1",
        title: "My board",
        payloadKind: "plain",
        payload: { type: "excalidraw", elements: [] },
        version: 3,
        thumbnailMeta: { width: 100, height: 80 },
        createdAt: ISO_MS,
        updatedAt: ISO_MS,
        deletedAt: null,
      });
    });

    it("maps deleted_at to epoch ms when soft-deleted", () => {
      const record = rowToSceneRecord({ ...fullRow, deleted_at: ISO });
      expect(record.deletedAt).toBe(ISO_MS);
    });

    it("normalizes unknown payload_kind to 'plain'", () => {
      const record = rowToSceneRecord({ ...fullRow, payload_kind: "bogus" });
      expect(record.payloadKind).toBe("plain");
    });

    it("preserves 'encrypted' payload_kind (P4 reserved)", () => {
      const record = rowToSceneRecord({
        ...fullRow,
        payload_kind: "encrypted",
      });
      expect(record.payloadKind).toBe("encrypted");
    });

    it("maps null thumbnail_meta to undefined", () => {
      const record = rowToSceneRecord({ ...fullRow, thumbnail_meta: null });
      expect(record.thumbnailMeta).toBeUndefined();
    });
  });

  describe("rowToSceneSummary", () => {
    it("maps summary row to SceneSummary", () => {
      const row: SceneSummaryRow = {
        id: "scene-1",
        title: "My board",
        version: 3,
        updated_at: ISO,
        thumbnail_meta: { width: 100, height: 80 },
      };
      expect(rowToSceneSummary(row)).toEqual({
        id: "scene-1",
        title: "My board",
        version: 3,
        updatedAt: ISO_MS,
        thumbnailMeta: { width: 100, height: 80 },
      });
    });
  });

  describe("sceneRecordToInsert", () => {
    it("stamps owner_id from caller and omits server-managed columns", () => {
      const scene: SceneRecord = {
        id: null,
        ownerId: "spoofed-owner",
        title: "New board",
        payloadKind: "plain",
        payload: { a: 1 },
        version: 1,
        createdAt: 0,
        updatedAt: 0,
        deletedAt: null,
      };
      const insert = sceneRecordToInsert(scene, "real-owner");
      expect(insert).toEqual({
        owner_id: "real-owner", // adapter-injected, not the spoofed value
        title: "New board",
        payload_kind: "plain",
        payload: { a: 1 },
        thumbnail_meta: null,
      });
      expect(insert).not.toHaveProperty("id");
      expect(insert).not.toHaveProperty("version");
      expect(insert).not.toHaveProperty("created_at");
    });
  });

  describe("sceneRecordToUpdate", () => {
    it("writes the bumped version and never owner_id/created_at", () => {
      const scene: SceneRecord = {
        id: "scene-1",
        ownerId: "user-1",
        title: "Renamed",
        payloadKind: "plain",
        payload: { b: 2 },
        version: 4,
        thumbnailMeta: { width: 10, height: 10 },
        createdAt: ISO_MS,
        updatedAt: ISO_MS,
        deletedAt: null,
      };
      const update = sceneRecordToUpdate(scene, 5);
      expect(update).toEqual({
        title: "Renamed",
        payload_kind: "plain",
        payload: { b: 2 },
        version: 5,
        thumbnail_meta: { width: 10, height: 10 },
      });
      expect(update).not.toHaveProperty("owner_id");
      expect(update).not.toHaveProperty("created_at");
    });
  });
});
