import { describe, expect, it, vi } from "vitest";

import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type { BinaryFileData, DataURL } from "@excalidraw/excalidraw/types";

import {
  FileManager,
  getSceneFileIds,
  isRealtimeFileBackedElement,
} from "../data/FileManager";
import { getSyncableElements, isSyncableElement } from "../data/index";

import { getCollabStartBlock } from "./collabStartGate";

// ADR 0035 §7: camera recordings never enter realtime collaboration, on any
// path (scene sync, file sync, room start).

const element = (type: string, extra: Record<string, unknown> = {}) =>
  ({
    id: `el-${type}-${extra.fileId ?? "x"}`,
    type,
    fileId: null,
    status: "pending",
    isDeleted: false,
    updated: Date.now(),
    width: 100,
    height: 100,
    x: 0,
    y: 0,
    ...extra,
  } as unknown as OrderedExcalidrawElement);

const videoFile = (id: string): BinaryFileData => ({
  id: id as FileId,
  mimeType: "video/mp4",
  dataURL: "data:video/mp4;base64,AAAAIGZ0eXA=" as DataURL,
  created: 1,
});

describe("camera recordings and realtime collaboration (ADR 0035 §7)", () => {
  it("never syncs a video element, deleted or not", () => {
    const video = element("video", { fileId: "v-1" });
    const deletedVideo = element("video", { fileId: "v-2", isDeleted: true });
    const rect = element("rectangle");
    expect(isSyncableElement(video)).toBe(false);
    expect(isSyncableElement(deletedVideo)).toBe(false);
    expect(isSyncableElement(rect)).toBe(true);
    expect(getSyncableElements([video, rect, deletedVideo])).toEqual([rect]);
  });

  it("keeps video files out of realtime file sync but in local GC", () => {
    const video = element("video", { fileId: "v-1" });
    const image = element("image", { fileId: "img-1" });
    expect(isRealtimeFileBackedElement(video)).toBe(false);
    expect(isRealtimeFileBackedElement(image)).toBe(true);
    // the owner's local storage still keeps the recording
    expect(getSceneFileIds([video, image] as ExcalidrawElement[])).toEqual(
      expect.arrayContaining(["v-1", "img-1"]),
    );
  });

  it("doesn't upload recordings through the collab file manager", async () => {
    const saveFiles = vi.fn(async ({ addedFiles }) => ({
      savedFiles: addedFiles,
      erroredFiles: new Map(),
    }));
    const manager = new FileManager({ getFiles: vi.fn(), saveFiles });
    const video = element("video", { fileId: "v-1" });
    await manager.saveFiles({
      elements: [video],
      files: { "v-1": videoFile("v-1") },
    });
    const added = saveFiles.mock.calls[0]?.[0].addedFiles;
    expect(added ? [...added.keys()] : []).toEqual([]);
    expect(manager.shouldUpdateImageElementStatus(video)).toBe(false);
    expect(manager.shouldPreventUnload([video])).toBe(false);
  });

  it("still saves recordings to the browser's own file store", async () => {
    const saveFiles = vi.fn(async ({ addedFiles }) => ({
      savedFiles: addedFiles,
      erroredFiles: new Map(),
    }));
    // LocalData.fileStorage opts in; without it a reload loses the clip
    const local = new FileManager({
      getFiles: vi.fn(),
      saveFiles,
      includeVideo: true,
    });
    const video = element("video", { fileId: "v-1" });
    await local.saveFiles({
      elements: [video],
      files: { "v-1": videoFile("v-1") },
    });
    expect([...saveFiles.mock.calls[0][0].addedFiles.keys()]).toEqual(["v-1"]);
    expect(local.shouldUpdateImageElementStatus(video)).toBe(true);
  });

  it("blocks starting a room from a scene with recordings or AI videos", () => {
    expect(getCollabStartBlock([element("rectangle")])).toBeNull();
    expect(getCollabStartBlock([element("video", { fileId: "v-1" })])).toMatch(
      /camera recordings/,
    );
    // a deleted recording doesn't block
    expect(
      getCollabStartBlock([
        element("video", { fileId: "v-1", isDeleted: true }),
      ]),
    ).toBeNull();
    expect(
      getCollabStartBlock([
        element("image", {
          fileId: "img-1",
          customData: { aiVideoGeneration: { taskId: "t" } },
        }),
      ]),
    ).not.toBeNull();
  });
});
