import { describe, expect, it } from "vitest";

import {
  castExportCreateToInsert,
  castScriptAttachToUpdate,
  castSessionCreateToInsert,
  rowToCastExportRecord,
  rowToCastSessionRecord,
} from "./castMappers";

describe("castMappers", () => {
  it("maps cast session rows to adapter records", () => {
    expect(
      rowToCastSessionRecord({
        id: "session-1",
        owner_id: "owner-1",
        scene_id: "scene-1",
        title: "Demo",
        status: "ready",
        script_asset_id: "asset-script",
        cover_asset_id: null,
        duration_ms: 1200,
        created_at: "2026-06-24T01:00:00.000Z",
        updated_at: "2026-06-24T01:00:01.000Z",
        deleted_at: null,
      }),
    ).toEqual({
      id: "session-1",
      ownerId: "owner-1",
      sceneId: "scene-1",
      title: "Demo",
      status: "ready",
      scriptAssetId: "asset-script",
      coverAssetId: null,
      durationMs: 1200,
      createdAt: Date.parse("2026-06-24T01:00:00.000Z"),
      updatedAt: Date.parse("2026-06-24T01:00:01.000Z"),
      deletedAt: null,
    });
  });

  it("maps create and attach inputs to Supabase rows", () => {
    expect(
      castSessionCreateToInsert(
        {
          sceneId: "scene-1",
          title: "Demo",
          scriptAssetId: null,
          coverAssetId: "cover-1",
          durationMs: 1500,
        },
        "owner-1",
      ),
    ).toEqual({
      owner_id: "owner-1",
      scene_id: "scene-1",
      title: "Demo",
      status: "draft",
      script_asset_id: null,
      cover_asset_id: "cover-1",
      duration_ms: 1500,
      deleted_at: null,
    });

    expect(
      castScriptAttachToUpdate({
        scriptAssetId: "script-1",
        durationMs: 2000,
      }),
    ).toEqual({
      status: "ready",
      script_asset_id: "script-1",
      duration_ms: 2000,
    });
  });

  it("maps cast export rows and inserts", () => {
    expect(
      rowToCastExportRecord({
        id: "export-1",
        owner_id: "owner-1",
        scene_id: "scene-1",
        session_id: "session-1",
        asset_id: "asset-1",
        type: "mp4",
        label: "MP4",
        mime_type: "video/mp4",
        bytes: 42,
        created_at: "2026-06-24T02:00:00.000Z",
        deleted_at: null,
      }),
    ).toEqual({
      id: "export-1",
      ownerId: "owner-1",
      sceneId: "scene-1",
      sessionId: "session-1",
      assetId: "asset-1",
      type: "mp4",
      label: "MP4",
      mimeType: "video/mp4",
      bytes: 42,
      createdAt: Date.parse("2026-06-24T02:00:00.000Z"),
      deletedAt: null,
    });

    expect(
      castExportCreateToInsert(
        {
          sceneId: "scene-1",
          sessionId: "session-1",
          assetId: "asset-1",
          type: "interactive",
          label: null,
          mimeType: "application/json",
          bytes: 12,
        },
        "owner-1",
      ),
    ).toEqual({
      owner_id: "owner-1",
      scene_id: "scene-1",
      session_id: "session-1",
      asset_id: "asset-1",
      type: "interactive",
      label: null,
      mime_type: "application/json",
      bytes: 12,
      deleted_at: null,
    });
  });
});
