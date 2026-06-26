import { afterEach, describe, expect, it } from "vitest";

import {
  createCloudEncryptionService,
  isEncryptedScenePayloadV1,
} from "./CloudEncryptionService";

const readBlobAsText = async (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsText(blob);
  });

describe("CloudEncryptionService", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("encrypts and decrypts scene payloads without plaintext in the envelope", async () => {
    const service = createCloudEncryptionService(true);
    const key = await service.generateKey();
    const payload = {
      type: "excalidraw",
      elements: [{ id: "text-1", type: "text", text: "secret" }],
      appState: { name: "Private board" },
    };

    const encrypted = await service.encryptScenePayload(payload, key);

    expect(isEncryptedScenePayloadV1(encrypted)).toBe(true);
    expect(JSON.stringify(encrypted)).not.toContain("secret");
    expect(await service.decryptScenePayload(encrypted, key)).toEqual(payload);
  });

  it("encrypts and decrypts blob payloads", async () => {
    const service = createCloudEncryptionService(true);
    const key = await service.generateKey();
    const encrypted = await service.encryptBlob(
      new Blob(["asset-secret"], { type: "text/plain" }),
      key,
    );

    expect(await readBlobAsText(encrypted)).not.toContain("asset-secret");
    const decrypted = await service.decryptBlob(encrypted, key);
    expect(await readBlobAsText(decrypted)).toBe("asset-secret");
  });

  it("stores keys only in the local keyring", async () => {
    const service = createCloudEncryptionService(true);
    service.saveKey({
      sceneId: "scene-1",
      key: "key-1",
      createdAt: 1,
      updatedAt: 1,
    });

    expect(service.getKey("scene-1")?.key).toBe("key-1");
    service.removeKey("scene-1");
    expect(service.getKey("scene-1")).toBeNull();
  });
});
