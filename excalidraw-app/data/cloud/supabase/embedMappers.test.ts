import { describe, expect, it } from "vitest";

import {
  embedCreateToInsert,
  embedUpdateToUpdate,
  rowToEmbedRecord,
} from "./embedMappers";

const row = {
  id: "embed-1",
  owner_id: "owner-1",
  scene_id: "scene-1",
  mode: "write" as const,
  token: "token-1",
  allowed_origins: ["http://127.0.0.1:4313/host.html"],
  theme: "dark" as const,
  size: "wide" as const,
  revoked: false,
  created_at: "2026-06-24T01:00:00.000Z",
  updated_at: "2026-06-24T01:00:01.000Z",
};

describe("embedMappers", () => {
  it("maps rows to domain records", () => {
    expect(rowToEmbedRecord(row)).toMatchObject({
      id: "embed-1",
      ownerId: "owner-1",
      sceneId: "scene-1",
      mode: "write",
      allowedOrigins: ["http://127.0.0.1:4313"],
      theme: "dark",
      size: "wide",
      revoked: false,
    });
  });

  it("maps create input to insert rows", () => {
    expect(
      embedCreateToInsert(
        {
          sceneId: "scene-1",
          mode: "read",
          allowedOrigins: [
            "http://127.0.0.1:4313/a",
            "http://127.0.0.1:4313/b",
          ],
        },
        "owner-1",
        "token-1",
      ),
    ).toEqual({
      owner_id: "owner-1",
      scene_id: "scene-1",
      mode: "read",
      token: "token-1",
      allowed_origins: ["http://127.0.0.1:4313"],
      theme: "system",
      size: "responsive",
    });
  });

  it("maps partial updates", () => {
    expect(
      embedUpdateToUpdate({
        allowedOrigins: ["https://example.com/page"],
        revoked: true,
      }),
    ).toEqual({
      allowed_origins: ["https://example.com"],
      revoked: true,
    });
  });
});
