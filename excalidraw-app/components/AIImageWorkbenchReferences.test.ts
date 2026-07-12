import type { FileId } from "@excalidraw/element/types";
import type { DataURL } from "@excalidraw/excalidraw/types";

import { getAIWorkbenchReferenceManifestKey } from "../ai/workbenchPersistenceScope";

import {
  appendSelectedImageSources,
  clearReferenceWeight,
  markMissingReferenceElements,
  reindexReferenceImages,
  loadPersistedReferenceState,
  persistReferenceState,
  persistReferenceStateV3ForMigrationTests,
  tokenizePromptReferences,
  validatePromptReferences,
} from "./AIImageWorkbenchReferences";

import type { AIImageSourceEnhanced } from "../ai/types";

const idbMock = vi.hoisted(() => ({
  deferNextWrite: false,
  failReads: false,
  failWrites: false,
  payloads: new Map<string, unknown>(),
  resolveWrite: null as (() => void) | null,
}));

vi.mock("../data/AIWorkbenchIndexedDB", () => ({
  AIWorkbenchIndexedDBAdapter: {
    setRevisionPayloads: async (
      descriptor: { scopeId: string; revision: string; kind: string },
      payloads: Array<{ id: string; value: unknown }>,
    ) => {
      if (idbMock.failWrites) {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }
      if (idbMock.deferNextWrite) {
        idbMock.deferNextWrite = false;
        await new Promise<void>((resolve) => {
          idbMock.resolveWrite = resolve;
        });
      }
      return payloads.map((payload) => {
        const key = `${descriptor.kind}:${descriptor.scopeId}:${descriptor.revision}:${payload.id}`;
        idbMock.payloads.set(key, payload.value);
        return key;
      });
    },
    getMany: async (keys: string[]) => {
      if (idbMock.failReads) {
        throw new Error("IndexedDB read failed");
      }
      return keys.map((key) => idbMock.payloads.get(key));
    },
    deleteMany: async (keys: string[]) => {
      keys.forEach((key) => idbMock.payloads.delete(key));
    },
  },
}));

const createReferenceSource = (
  overrides: Partial<AIImageSourceEnhanced> = {},
): AIImageSourceEnhanced => ({
  index: 1,
  elementId: "element-1",
  elementIds: ["element-1"],
  fileId: "file-1" as FileId,
  file: new File(["image"], "reference-1.png", { type: "image/png" }),
  dataURL: "data:image/png;base64,cmVm" as DataURL,
  width: 320,
  height: 240,
  sourceType: "canvas",
  createdAt: 1,
  ...overrides,
});

describe("AIImageWorkbenchReferences", () => {
  beforeEach(() => {
    localStorage.clear();
    idbMock.failReads = false;
    idbMock.failWrites = false;
    idbMock.deferNextWrite = false;
    idbMock.payloads.clear();
    idbMock.resolveWrite = null;
  });
  it("reindexes reference sources after list operations", () => {
    expect(
      reindexReferenceImages([
        createReferenceSource({ index: 8, elementId: "a" }),
        createReferenceSource({ index: 2, elementId: "b" }),
      ]).map((source) => source.index),
    ).toEqual([1, 2]);
  });

  it("appends new selected sources and deduplicates existing canvas sources", () => {
    const current = createReferenceSource({
      index: 3,
      elementId: "element-1",
      missingElement: true,
      sourceType: "canvas",
    });
    const selectedExisting = createReferenceSource({
      index: 99,
      elementId: "element-1",
      dataURL: "data:image/png;base64,bmV3" as DataURL,
    });
    const selectedNew = createReferenceSource({
      index: 99,
      elementId: "element-2",
      elementIds: ["element-2"],
      fileId: "file-2" as FileId,
    });

    const nextSources = appendSelectedImageSources(
      [current],
      [selectedExisting, selectedNew],
    );

    expect(nextSources).toHaveLength(2);
    expect(nextSources[0]).toMatchObject({
      elementId: "element-1",
      index: 1,
      missingElement: false,
      dataURL: "data:image/png;base64,cmVm",
    });
    expect(nextSources[1]).toMatchObject({
      elementId: "element-2",
      index: 2,
    });
  });

  it("refreshes imported reference image data when the same element is selected", () => {
    const imported = createReferenceSource({
      sourceType: "imported",
      missingElement: true,
      width: 320,
      height: 240,
    });
    const selected = createReferenceSource({
      dataURL: "data:image/png;base64,dXBkYXRlZA==" as DataURL,
      file: new File(["updated"], "updated.webp", { type: "image/webp" }),
      fileId: "updated-file" as FileId,
      width: 800,
      height: 600,
    });

    const [updated] = appendSelectedImageSources([imported], [selected]);

    expect(updated).toMatchObject({
      dataURL: "data:image/png;base64,dXBkYXRlZA==",
      fileId: "updated-file",
      width: 800,
      height: 600,
      missingElement: false,
    });
    expect(updated.file.name).toBe("updated.webp");
  });

  it("marks missing reference elements and clears reference weights", () => {
    const weighted = createReferenceSource({
      elementId: "missing",
      elementIds: ["missing", "fallback"],
      weight: 0.8,
    });

    expect(
      markMissingReferenceElements([weighted], [{ id: "fallback" }])[0],
    ).toMatchObject({
      missingElement: false,
    });
    expect(
      markMissingReferenceElements(
        [weighted],
        [{ id: "fallback", isDeleted: true }],
      )[0],
    ).toMatchObject({
      missingElement: true,
    });
    expect(clearReferenceWeight(weighted).weight).toBeUndefined();
  });

  it("warns when prompt reference indexes are outside the reference tray", () => {
    expect(validatePromptReferences("use #1", 0)).toEqual([
      "Warning: #1 not found (0 references).",
    ]);
    expect(validatePromptReferences("use #1 and image 4", 2)).toEqual([
      "Warning: #4 not found (2 references).",
    ]);
    expect(validatePromptReferences("use #2 twice #2", 1)).toEqual([
      "Warning: #2 not found (1 reference).",
    ]);
    expect(validatePromptReferences("use 图 3", 2)).toEqual([
      "Warning: #3 not found (2 references).",
    ]);
  });

  it("tokenizes a prompt into text, valid, and out-of-range reference runs", () => {
    const segments = tokenizePromptReferences("blend #1 with #3 here", 2);

    expect(segments).toEqual([
      { text: "blend ", type: "text" },
      { text: "#1", type: "reference" },
      { text: " with ", type: "text" },
      { text: "#3", type: "invalid-reference" },
      { text: " here", type: "text" },
    ]);
  });

  it("recognizes the 图 and image reference spellings", () => {
    expect(tokenizePromptReferences("参考 图 1 和 image 2", 2)).toEqual([
      { text: "参考 ", type: "text" },
      { text: "图 1", type: "reference" },
      { text: " 和 ", type: "text" },
      { text: "image 2", type: "reference" },
    ]);
  });

  it("preserves the original prompt when segments are concatenated", () => {
    const prompt = "#1 leading, #9 trailing #2";
    const rebuilt = tokenizePromptReferences(prompt, 3)
      .map((segment) => segment.text)
      .join("");

    expect(rebuilt).toBe(prompt);
  });

  it("migrates a v3 reference snapshot to a v4 manifest without data URLs", async () => {
    const legacyKey = "ai-reference-images-legacy";
    persistReferenceStateV3ForMigrationTests(legacyKey, {
      locked: true,
      images: [createReferenceSource({ fileId: undefined })],
    });

    const restored = await loadPersistedReferenceState(
      "local:test",
      {},
      legacyKey,
    );

    expect(restored?.images).toHaveLength(1);
    const manifest = JSON.parse(
      localStorage.getItem(getAIWorkbenchReferenceManifestKey("local:test"))!,
    );
    expect(manifest).toMatchObject({ version: 4, locked: true });
    expect(manifest.images[0].dataURL).toBeUndefined();
    expect(manifest.images[0].payloadKey).toContain("reference:local:test:");
    expect(localStorage.getItem(legacyKey)).toBeNull();
  });

  it("keeps the v3 snapshot when IndexedDB migration fails", async () => {
    const legacyKey = "ai-reference-images-legacy";
    persistReferenceStateV3ForMigrationTests(legacyKey, {
      locked: false,
      images: [createReferenceSource()],
    });
    idbMock.failWrites = true;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const restored = await loadPersistedReferenceState(
      "local:test",
      {},
      legacyKey,
    );

    expect(restored?.images).toHaveLength(1);
    expect(localStorage.getItem(legacyKey)).not.toBeNull();
    expect(
      localStorage.getItem(getAIWorkbenchReferenceManifestKey("local:test")),
    ).toBeNull();
  });

  it("prevents an older delayed write from overwriting the latest manifest", async () => {
    idbMock.deferNextWrite = true;
    const firstWrite = persistReferenceState("local:race", {
      locked: false,
      images: [createReferenceSource({ elementId: "old", createdAt: 1 })],
    });
    await vi.waitFor(() => expect(idbMock.resolveWrite).not.toBeNull());
    const latestWrite = persistReferenceState("local:race", {
      locked: true,
      images: [createReferenceSource({ elementId: "latest", createdAt: 2 })],
    });

    idbMock.resolveWrite?.();
    await Promise.all([firstWrite, latestWrite]);

    const manifest = JSON.parse(
      localStorage.getItem(getAIWorkbenchReferenceManifestKey("local:race"))!,
    );
    expect(manifest).toMatchObject({ locked: true });
    expect(manifest.images[0].elementId).toBe("latest");
    expect(
      [...idbMock.payloads.keys()].some((key) => key.endsWith(":1:0")),
    ).toBe(false);
  });

  it("does not silently cap v4 references at the legacy localStorage limit", async () => {
    const images = Array.from({ length: 30 }, (_, index) =>
      createReferenceSource({
        index: index + 1,
        elementId: `element-${index}`,
        elementIds: [`element-${index}`],
        fileId: `file-${index}` as FileId,
        file: new File([`image-${index}`], `reference-${index}.png`, {
          type: "image/png",
        }),
        createdAt: index + 1,
      }),
    );

    await persistReferenceState("local:all-references", {
      locked: true,
      images,
    });

    const manifest = JSON.parse(
      localStorage.getItem(
        getAIWorkbenchReferenceManifestKey("local:all-references"),
      )!,
    );
    expect(manifest.images).toHaveLength(30);

    const restored = await loadPersistedReferenceState(
      "local:all-references",
      {},
    );
    expect(restored?.images).toHaveLength(30);
  });

  it("cleans the new revision when manifest commit fails", async () => {
    const originalSetItem = window.localStorage.setItem.bind(
      window.localStorage,
    );
    vi.spyOn(window.localStorage, "setItem").mockImplementation(
      (key, value) => {
        if (key === getAIWorkbenchReferenceManifestKey("local:commit-fail")) {
          throw new DOMException("Quota exceeded", "QuotaExceededError");
        }
        originalSetItem(key, value);
      },
    );

    await expect(
      persistReferenceState("local:commit-fail", {
        locked: false,
        images: [createReferenceSource()],
      }),
    ).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(idbMock.payloads.size).toBe(0);
  });

  it("cleans the new revision when payload verification throws", async () => {
    idbMock.failReads = true;

    await expect(
      persistReferenceState("local:verify-fail", {
        locked: false,
        images: [createReferenceSource()],
      }),
    ).rejects.toThrow("IndexedDB read failed");
    expect(idbMock.payloads.size).toBe(0);
    expect(
      localStorage.getItem(
        getAIWorkbenchReferenceManifestKey("local:verify-fail"),
      ),
    ).toBeNull();
  });

  it("returns a single text segment when there are no references", () => {
    expect(tokenizePromptReferences("just a plain prompt", 3)).toEqual([
      { text: "just a plain prompt", type: "text" },
    ]);
  });
});
