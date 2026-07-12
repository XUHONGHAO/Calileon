import type { DataURL } from "@excalidraw/excalidraw/types";

import { getAIWorkbenchMaskManifestKey } from "../ai/workbenchPersistenceScope";

import {
  loadPersistedMaskState,
  persistMaskState,
  persistMaskStateV1ForMigrationTests,
} from "./AIImageWorkbenchMasks";

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

const maskDataURL = "data:image/png;base64,bWFzaw==" as DataURL;

describe("AIImageWorkbenchMasks persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    idbMock.failReads = false;
    idbMock.failWrites = false;
    idbMock.deferNextWrite = false;
    idbMock.payloads.clear();
    idbMock.resolveWrite = null;
  });

  it("migrates a v1 mask snapshot to a v2 lightweight manifest", async () => {
    const legacyKey = "ai-inpaint-masks-legacy";
    persistMaskStateV1ForMigrationTests(legacyKey, {
      "image-1": {
        file: new File(["mask"], "mask-image-1.png", { type: "image/png" }),
        dataURL: maskDataURL,
        elements: [{ id: "stroke-1", type: "freedraw" } as any],
        updatedAt: 10,
      },
    });

    const restored = await loadPersistedMaskState("local:test", legacyKey);

    expect(restored["image-1"]).toMatchObject({ updatedAt: 10 });
    const manifest = JSON.parse(
      localStorage.getItem(getAIWorkbenchMaskManifestKey("local:test"))!,
    );
    expect(manifest.version).toBe(2);
    expect(manifest.masks[0].dataURL).toBeUndefined();
    expect(manifest.masks[0].elements).toBeUndefined();
    expect(manifest.masks[0].payloadKey).toContain("mask:local:test:");
    const storedPayload = idbMock.payloads.get(
      manifest.masks[0].payloadKey,
    ) as {
      blob: Blob;
      elements: Array<{ id: string }>;
    };
    expect(storedPayload.blob).toBeInstanceOf(Blob);
    expect(storedPayload.elements[0].id).toBe("stroke-1");
    expect(localStorage.getItem(legacyKey)).toBeNull();
  });

  it("keeps the v1 mask snapshot when IndexedDB migration fails", async () => {
    const legacyKey = "ai-inpaint-masks-legacy";
    persistMaskStateV1ForMigrationTests(legacyKey, {
      "image-1": {
        file: new File(["mask"], "mask-image-1.png", { type: "image/png" }),
        dataURL: maskDataURL,
        elements: [],
        updatedAt: 10,
      },
    });
    idbMock.failWrites = true;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const restored = await loadPersistedMaskState("local:test", legacyKey);

    expect(restored["image-1"]).toBeDefined();
    expect(localStorage.getItem(legacyKey)).not.toBeNull();
    expect(
      localStorage.getItem(getAIWorkbenchMaskManifestKey("local:test")),
    ).toBeNull();
  });

  it("keeps only the latest mask manifest when an older write resolves late", async () => {
    const createMask = (updatedAt: number) => ({
      file: new File([`mask-${updatedAt}`], `mask-${updatedAt}.png`, {
        type: "image/png",
      }),
      dataURL: maskDataURL,
      elements: [],
      updatedAt,
    });
    idbMock.deferNextWrite = true;
    const firstWrite = persistMaskState("local:race", {
      "image-old": createMask(1),
    });
    await vi.waitFor(() => expect(idbMock.resolveWrite).not.toBeNull());
    const latestWrite = persistMaskState("local:race", {
      "image-latest": createMask(2),
    });

    idbMock.resolveWrite?.();
    await Promise.all([firstWrite, latestWrite]);

    const manifest = JSON.parse(
      localStorage.getItem(getAIWorkbenchMaskManifestKey("local:race"))!,
    );
    expect(manifest.masks).toHaveLength(1);
    expect(manifest.masks[0].imageId).toBe("image-latest");
    expect(
      [...idbMock.payloads.keys()].some((key) => key.endsWith("image-old:1")),
    ).toBe(false);
  });

  it("persists and restores a v2 mask while its dataURL is pending", async () => {
    const pngSignature = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const file = new File([pngSignature], "pending-mask.png", {
      type: "image/png",
    });

    await persistMaskState("local:file-only", {
      "image-1": {
        file,
        elements: [{ id: "stroke-1", type: "freedraw" } as any],
        updatedAt: 1,
      },
    });

    const manifest = JSON.parse(
      localStorage.getItem(getAIWorkbenchMaskManifestKey("local:file-only"))!,
    );
    expect(manifest.masks).toHaveLength(1);
    expect(manifest.masks[0].imageId).toBe("image-1");
    const restored = await loadPersistedMaskState("local:file-only");
    expect(restored["image-1"].file).toMatchObject({
      name: "pending-mask.png",
      size: pngSignature.byteLength,
      type: "image/png",
    });
    expect(restored["image-1"].dataURL).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
    expect(restored["image-1"].elements[0].id).toBe("stroke-1");
  });

  it("does not silently cap v2 masks at the legacy localStorage limit", async () => {
    const masks = Object.fromEntries(
      Array.from({ length: 15 }, (_, index) => [
        `image-${index}`,
        {
          file: new File([`mask-${index}`], `mask-${index}.png`, {
            type: "image/png",
          }),
          elements: [],
          updatedAt: index,
        },
      ]),
    );

    await persistMaskState("local:all-masks", masks);

    const manifest = JSON.parse(
      localStorage.getItem(getAIWorkbenchMaskManifestKey("local:all-masks"))!,
    );
    expect(manifest.masks).toHaveLength(15);
    const restored = await loadPersistedMaskState("local:all-masks");
    expect(Object.keys(restored)).toHaveLength(15);
  });
  it("filters orphan masks using scene image ids read at restore completion", async () => {
    const createMask = (name: string, updatedAt: number) => ({
      file: new File([name], `${name}.png`, { type: "image/png" }),
      elements: [],
      updatedAt,
    });
    await persistMaskState("local:orphan", {
      "image-current": createMask("current", 2),
      "image-orphan": createMask("orphan", 1),
    });
    const getCurrentSceneImageIds = vi.fn(
      () => new Set<string>(["image-current"]),
    );

    const restored = await loadPersistedMaskState(
      "local:orphan",
      undefined,
      getCurrentSceneImageIds,
    );

    expect(getCurrentSceneImageIds).toHaveBeenCalledTimes(1);
    expect(Object.keys(restored)).toEqual(["image-current"]);
    expect(restored["image-orphan"]).toBeUndefined();
  });

  it("cleans the new revision when payload verification throws", async () => {
    idbMock.failReads = true;

    await expect(
      persistMaskState("local:verify-fail", {
        "image-1": {
          file: new File(["mask"], "mask.png", { type: "image/png" }),
          dataURL: maskDataURL,
          elements: [],
          updatedAt: 1,
        },
      }),
    ).rejects.toThrow("IndexedDB read failed");
    expect(idbMock.payloads.size).toBe(0);
    expect(
      localStorage.getItem(getAIWorkbenchMaskManifestKey("local:verify-fail")),
    ).toBeNull();
  });
});
