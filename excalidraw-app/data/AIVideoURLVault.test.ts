import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __clearLocalAIVideoURLVaultForTests,
  createLocalAIVideoAssetId,
  loadLocalAIVideoAsset,
  loadLocalAIVideoBlobAsset,
  persistLocalAIVideoBlob,
  persistLocalAIVideoURL,
  removeLocalAIVideoAsset,
  resolveLocalAIVideoPlayback,
} from "./AIVideoURLVault";

describe("AIVideoURLVault", () => {
  beforeEach(async () => {
    await __clearLocalAIVideoURLVaultForTests();
  });

  const { createObjectURL, revokeObjectURL } = URL;

  afterEach(() => {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  });

  it("persists an opaque signed URL outside scene JSON", async () => {
    const asset = await persistLocalAIVideoURL({
      taskId: "task/one",
      url: "https://cdn.example/output?X-Amz-Signature=secret",
      mimeType: "video/mp4",
    });

    expect(asset.assetId).toBe(createLocalAIVideoAssetId("task/one"));
    await expect(loadLocalAIVideoAsset(asset.assetId)).resolves.toEqual(asset);
    expect(
      JSON.stringify({ link: `urn:excalidraw:ai-video:${asset.assetId}` }),
    ).not.toContain("Signature");
  });

  it("uses the task id as an idempotent local asset identity", async () => {
    const first = await persistLocalAIVideoURL({
      taskId: "same-task",
      url: "https://cdn.example/first?token=one",
      mimeType: "video/mp4",
    });
    const second = await persistLocalAIVideoURL({
      taskId: "same-task",
      url: "https://cdn.example/second?token=two",
      mimeType: "video/mp4",
    });

    expect(first.assetId).toBe(second.assetId);
    expect((await loadLocalAIVideoAsset(first.assetId))?.url).toContain(
      "second",
    );
  });

  it("stores video bytes and plays them through one object URL", async () => {
    const createObjectURL = vi.fn(() => "blob:local-video");
    const revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;

    const asset = await persistLocalAIVideoBlob({
      taskId: "rolldek-task",
      blob: new Blob([new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70])], {
        type: "video/mp4",
      }),
      mimeType: "video/mp4",
    });
    expect(asset).toMatchObject({
      assetId: createLocalAIVideoAssetId("rolldek-task"),
      mimeType: "video/mp4",
      bytes: 8,
    });
    await expect(loadLocalAIVideoAsset(asset.assetId)).resolves.toBeUndefined();

    const first = await resolveLocalAIVideoPlayback(asset.assetId);
    const second = await resolveLocalAIVideoPlayback(asset.assetId);
    expect(first).toEqual({ url: "blob:local-video", mimeType: "video/mp4" });
    expect(second).toEqual(first);
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    await removeLocalAIVideoAsset(asset.assetId);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:local-video");
    await expect(
      loadLocalAIVideoBlobAsset(asset.assetId),
    ).resolves.toBeUndefined();
    await expect(
      resolveLocalAIVideoPlayback(asset.assetId),
    ).resolves.toBeUndefined();
  });

  it("prefers a stored URL when resolving playback", async () => {
    const asset = await persistLocalAIVideoURL({
      taskId: "url-task",
      url: "https://cdn.example/output",
      mimeType: "video/webm",
    });
    await expect(resolveLocalAIVideoPlayback(asset.assetId)).resolves.toEqual({
      url: "https://cdn.example/output",
      mimeType: "video/webm",
    });
  });

  it("keeps v1 URL records when upgrading to v2", async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase("excalidraw-ai-video-db");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open("excalidraw-ai-video-db", 1);
      request.onupgradeneeded = () => {
        request.result
          .createObjectStore("url-vault", { keyPath: "assetId" })
          .put({
            assetId: "local:v1-task",
            url: "https://cdn.example/v1",
            mimeType: "video/mp4",
            createdAt: 1,
          });
      };
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });

    await expect(loadLocalAIVideoAsset("local:v1-task")).resolves.toMatchObject(
      { url: "https://cdn.example/v1" },
    );
    await expect(
      loadLocalAIVideoBlobAsset("local:v1-task"),
    ).resolves.toBeUndefined();
  });

  it("removes obsolete local assets", async () => {
    const asset = await persistLocalAIVideoURL({
      taskId: "remove-task",
      url: "https://cdn.example/output",
      mimeType: "video/webm",
    });
    await removeLocalAIVideoAsset(asset.assetId);
    await expect(loadLocalAIVideoAsset(asset.assetId)).resolves.toBeUndefined();
  });
});
