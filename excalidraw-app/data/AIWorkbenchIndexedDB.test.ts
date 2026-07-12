import "fake-indexeddb/auto";

import { beforeEach, describe, expect, it } from "vitest";

import {
  AIWorkbenchIndexedDBAdapter,
  AIWorkbenchRevisionConflictError,
} from "./AIWorkbenchIndexedDB";

const descriptor = {
  scopeId: "local:board/one",
  revision: "revision:1",
  kind: "reference" as const,
};

const binary = (value: string) => new TextEncoder().encode(value);
const readBinary = (value: Uint8Array) => new TextDecoder().decode(value);
const readBlobBytes = (blob: Blob) =>
  new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () =>
      reject(reader.error || new Error("Blob read failed"));
    reader.readAsArrayBuffer(blob);
  });

describe("AIWorkbenchIndexedDBAdapter", () => {
  beforeEach(async () => {
    await AIWorkbenchIndexedDBAdapter.clearAll();
  });

  it("round-trips real PNG blobs and deeply cloned mask strokes", async () => {
    const referenceKey = AIWorkbenchIndexedDBAdapter.createRevisionPayloadKey(
      descriptor,
      "reference/1",
    );
    const maskKey = AIWorkbenchIndexedDBAdapter.createRevisionPayloadKey(
      { ...descriptor, kind: "mask" },
      "image:1",
    );
    const pngBytes = new Uint8Array([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13,
    ]);
    const maskBytes = new Uint8Array([255, 0, 255, 128]);
    const referenceBlob = new Blob([pngBytes], { type: "image/png" });
    const maskPayload = {
      blob: new Blob([maskBytes], { type: "image/png" }),
      elements: [
        {
          id: "stroke-1",
          type: "freedraw",
          points: [
            [0, 0],
            [12, 8],
          ],
          pressures: [0.25, 0.75],
        },
      ],
    };

    await AIWorkbenchIndexedDBAdapter.setMany<Blob | typeof maskPayload>([
      [referenceKey, referenceBlob],
      [maskKey, maskPayload],
    ]);
    maskPayload.elements[0].points[1][0] = 999;
    maskPayload.elements[0].pressures[0] = 1;

    const [restoredReference, restoredMask] =
      await AIWorkbenchIndexedDBAdapter.getMany<Blob | typeof maskPayload>([
        referenceKey,
        maskKey,
      ]);

    expect(restoredReference).toBeInstanceOf(Blob);
    expect((restoredReference as Blob).type).toBe("image/png");
    expect(await readBlobBytes(restoredReference as Blob)).toEqual(pngBytes);
    expect(restoredMask).toMatchObject({
      elements: [
        {
          id: "stroke-1",
          points: [
            [0, 0],
            [12, 8],
          ],
          pressures: [0.25, 0.75],
        },
      ],
    });
    const restoredMaskBlob = (restoredMask as typeof maskPayload).blob;
    expect(restoredMaskBlob).toBeInstanceOf(Blob);
    expect(restoredMaskBlob.type).toBe("image/png");
    expect(await readBlobBytes(restoredMaskBlob)).toEqual(maskBytes);
  });

  it("writes a revision atomically when one value cannot be cloned", async () => {
    const firstKey = AIWorkbenchIndexedDBAdapter.createRevisionPayloadKey(
      descriptor,
      "first",
    );
    const invalidKey = AIWorkbenchIndexedDBAdapter.createRevisionPayloadKey(
      descriptor,
      "invalid",
    );

    await expect(
      AIWorkbenchIndexedDBAdapter.setMany<any>([
        [firstKey, binary("first")],
        [invalidKey, { callback: () => undefined }],
      ]),
    ).rejects.toBeDefined();

    await expect(
      AIWorkbenchIndexedDBAdapter.getMany([firstKey, invalidKey]),
    ).resolves.toEqual([undefined, undefined]);
  });

  it("creates immutable revisions and rejects duplicate payload ids", async () => {
    const payloadKeys = await AIWorkbenchIndexedDBAdapter.setRevisionPayloads(
      descriptor,
      [
        { id: "reference-1", value: binary("one") },
        { id: "reference-2", value: binary("two") },
      ],
    );

    expect(payloadKeys).toHaveLength(2);
    await expect(
      AIWorkbenchIndexedDBAdapter.setRevisionPayloads(descriptor, [
        { id: "reference-1", value: binary("replacement") },
      ]),
    ).rejects.toBeInstanceOf(AIWorkbenchRevisionConflictError);
    await expect(
      AIWorkbenchIndexedDBAdapter.setRevisionPayloads(
        { ...descriptor, revision: "revision-2" },
        [
          { id: "duplicate", value: binary("one") },
          { id: "duplicate", value: binary("two") },
        ],
      ),
    ).rejects.toBeInstanceOf(AIWorkbenchRevisionConflictError);

    const [original] = await AIWorkbenchIndexedDBAdapter.getMany<Uint8Array>([
      payloadKeys[0],
    ]);
    expect(readBinary(original!)).toBe("one");
  });

  it("lists revision keys by encoded prefix without crossing scopes", async () => {
    const firstRevisionKeys =
      await AIWorkbenchIndexedDBAdapter.setRevisionPayloads(descriptor, [
        { id: "one", value: binary("one") },
        { id: "two", value: binary("two") },
      ]);
    await AIWorkbenchIndexedDBAdapter.setRevisionPayloads(
      { ...descriptor, scopeId: "local:board/two" },
      [{ id: "other", value: binary("other") }],
    );

    expect(
      await AIWorkbenchIndexedDBAdapter.listRevisionKeys(descriptor),
    ).toEqual(expect.arrayContaining(firstRevisionKeys));
    expect(
      await AIWorkbenchIndexedDBAdapter.listRevisionKeys(descriptor),
    ).toHaveLength(2);
    expect(firstRevisionKeys[0]).not.toContain("board/one");
  });

  it("deletes multiple revision payloads atomically", async () => {
    const payloadKeys = await AIWorkbenchIndexedDBAdapter.setRevisionPayloads(
      descriptor,
      [
        { id: "one", value: binary("one") },
        { id: "two", value: binary("two") },
      ],
    );

    await AIWorkbenchIndexedDBAdapter.deleteMany(payloadKeys);

    await expect(
      AIWorkbenchIndexedDBAdapter.getMany(payloadKeys),
    ).resolves.toEqual([undefined, undefined]);
    await expect(
      AIWorkbenchIndexedDBAdapter.listRevisionKeys(descriptor),
    ).resolves.toEqual([]);
  });
});
