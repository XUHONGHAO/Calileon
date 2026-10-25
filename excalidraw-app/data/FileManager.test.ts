import { describe, expect, it, vi } from "vitest";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type { BinaryFileData, DataURL } from "@excalidraw/excalidraw/types";

import { FileManager, getSceneFileIds } from "./FileManager";

const element = (type: string, fileId: string | null, extra = {}) =>
  ({
    id: `el-${type}-${fileId}`,
    type,
    fileId,
    status: "pending",
    isDeleted: false,
    ...extra,
  } as unknown as ExcalidrawElement);

const audioFile = (id: string): BinaryFileData => ({
  id: id as FileId,
  mimeType: "audio/webm",
  dataURL: "data:audio/webm;base64,dm9pY2U=" as DataURL,
  created: 1,
});

describe("FileManager with audio (ADR 0034)", () => {
  it("keeps audio files in the local GC set, deleted elements included", () => {
    expect(
      getSceneFileIds([
        element("image", "img-1"),
        element("audio", "voice-1"),
        element("audio", "voice-deleted", { isDeleted: true }),
        element("audio", null),
        element("rectangle", null),
      ]),
    ).toEqual(["img-1", "voice-1", "voice-deleted"]);
  });

  it("saves audio files and then flags the bubble for a saved status", async () => {
    const saveFiles = vi.fn(async ({ addedFiles }) => ({
      savedFiles: addedFiles,
      erroredFiles: new Map(),
    }));
    const manager = new FileManager({
      getFiles: vi.fn(),
      saveFiles,
    });
    const voice = element("audio", "voice-1");

    await manager.saveFiles({
      elements: [voice],
      files: { "voice-1": audioFile("voice-1") },
    });

    expect(saveFiles).toHaveBeenCalledTimes(1);
    expect([...saveFiles.mock.calls[0][0].addedFiles.keys()]).toEqual([
      "voice-1",
    ]);
    expect(manager.shouldUpdateImageElementStatus(voice)).toBe(true);
  });
});
