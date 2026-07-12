import { beforeEach, describe, expect, it } from "vitest";

import { AIWorkbenchIndexedDBAdapter } from "../data/AIWorkbenchIndexedDB";

import {
  deleteManyMindsBatch,
  listManyMindsBatches,
  loadManyMindsAsset,
  loadManyMindsBatch,
  saveManyMindsAsset,
  saveManyMindsBatch,
} from "./manyMindsPersistence";
import { createManyMindsBatch } from "./manyMindsTypes";

describe("Many Minds persistence", () => {
  beforeEach(async () => AIWorkbenchIndexedDBAdapter.clearAll());

  const batch = () =>
    createManyMindsBatch({
      persistenceScopeId: "scope-a",
      input: {
        kind: "text",
        prompt: "Authorization: top-secret",
        sourceElementIds: [],
        assets: [],
        createdAt: 1,
      },
      perspectives: [
        {
          id: "p1",
          name: "Safe",
          icon: "sparkles",
          prompt: "api_key=sk-abcdefghijklmnop",
          isBuiltIn: false,
        },
      ],
      modelId: "model-1",
      params: { size: "1024x1024", n: 1 },
      now: 1,
    });

  it("scopes, sanitizes, updates, lists, and deletes batch state", async () => {
    const value = batch();
    value.tasks[value.taskOrder[0]].status = "running";
    await saveManyMindsBatch("scope-a", value);

    const restored = await loadManyMindsBatch("scope-a", value.id);
    expect(restored!.tasks[value.taskOrder[0]].status).toBe("interrupted");
    expect(JSON.stringify(restored)).not.toContain("top-secret");
    expect(JSON.stringify(restored)).not.toContain("sk-abcdefghijklmnop");
    expect(await loadManyMindsBatch("scope-b", value.id)).toBeNull();
    expect(await listManyMindsBatches("scope-a")).toHaveLength(1);

    restored!.tasks[value.taskOrder[0]].status = "failed";
    await saveManyMindsBatch("scope-a", restored!);
    expect(
      (await loadManyMindsBatch("scope-a", value.id))!.tasks[value.taskOrder[0]]
        .status,
    ).toBe("failed");
    await deleteManyMindsBatch("scope-a", value.id);
    expect(await loadManyMindsBatch("scope-a", value.id)).toBeNull();
  });

  it("round-trips stable Blob assets without a Blob or signed URL", async () => {
    await saveManyMindsAsset("scope-a", {
      version: 1,
      ref: {
        assetId: "asset-1",
        role: "output",
        mimeType: "image/png",
        width: 64,
        height: 32,
      },
      blob: new Blob([new Uint8Array([137, 80, 78, 71])], {
        type: "image/png",
      }),
      createdAt: 1,
    });
    const restored = await loadManyMindsAsset("scope-a", "asset-1");
    expect(restored?.ref.assetId).toBe("asset-1");
    expect(restored?.blob).toBeInstanceOf(Blob);
    expect(await readBlob(restored!.blob)).toEqual(
      new Uint8Array([137, 80, 78, 71]).buffer,
    );
    expect(JSON.stringify(restored?.ref)).not.toMatch(
      /blob:|https?:|signature/i,
    );
    expect(await loadManyMindsAsset("scope-b", "asset-1")).toBeNull();
  });
});

const readBlob = (blob: Blob) =>
  new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
