import { beforeEach, describe, expect, it } from "vitest";

import {
  __clearLocalAIVideoURLVaultForTests,
  createLocalAIVideoAssetId,
  loadLocalAIVideoAsset,
  persistLocalAIVideoURL,
  removeLocalAIVideoAsset,
} from "./AIVideoURLVault";

describe("AIVideoURLVault", () => {
  beforeEach(async () => {
    await __clearLocalAIVideoURLVaultForTests();
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
