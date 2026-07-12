import { API } from "@excalidraw/excalidraw/tests/helpers/api";

import type { FileId } from "@excalidraw/element/types";
import type { BinaryFiles, DataURL } from "@excalidraw/excalidraw/types";

import { createSingleFilePayload, isSingleFilePayload } from "./payload";

const binaryFile = (id: FileId, dataURL: string) => ({
  id,
  dataURL: dataURL as DataURL,
  mimeType: "image/png" as const,
  created: 1,
  lastRetrieved: 1,
});

describe("single-file payload", () => {
  it("keeps referenced files and Lumina data while excluding private state", () => {
    const referencedId = "referenced" as FileId;
    const deletedId = "deleted" as FileId;
    const unusedId = "unused" as FileId;
    const semanticCustomData = {
      lineTone: {
        version: 1,
        tone: "possible",
      },
      luminaMaterial: {
        roughness: 0.35,
        metallic: 0.7,
      },
      luminaLight: {
        light: "point",
        color: "#80eaff",
        intensity: 1.25,
        radius: 480,
        castShadows: true,
      },
    };
    const elements = [
      API.createElement({
        type: "arrow",
        id: "semantic-line",
        customData: semanticCustomData,
      }),
      API.createElement({
        type: "image",
        id: "referenced-image",
        fileId: referencedId,
      }),
      API.createElement({
        type: "image",
        id: "deleted-image",
        fileId: deletedId,
        isDeleted: true,
      }),
    ];
    const files: BinaryFiles = {
      [referencedId]: binaryFile(
        referencedId,
        "data:image/png;base64,cmVmZXJlbmNlZA==",
      ),
      [deletedId]: binaryFile(deletedId, "data:image/png;base64,ZGVsZXRlZA=="),
      [unusedId]: binaryFile(unusedId, "data:image/png;base64,dW51c2Vk"),
    };
    const fileHandle = { name: "private.html" } as FileSystemFileHandle;

    const payload = createSingleFilePayload({
      elements,
      appState: {
        name: "Old name",
        theme: "dark",
        luminaEnabled: true,
        luminaAmbient: 0.22,
        fileHandle,
        collaborators: new Map(),
        apiKey: "test-api-key",
        accessToken: "test-access-token",
        roomKey: "test-room-key",
      } as any,
      files,
      name: "Offline board",
      generatorVersion: "test-version",
      createdAt: 100,
      updatedAt: 200,
    });

    expect(payload.scene.elements[0].customData).toEqual(semanticCustomData);
    expect(payload.scene.appState).toMatchObject({
      name: "Offline board",
      theme: "dark",
      luminaEnabled: true,
      luminaAmbient: 0.22,
    });
    expect(payload.scene.appState).not.toHaveProperty("fileHandle");
    expect(payload.scene.appState).not.toHaveProperty("collaborators");
    expect(payload.scene.appState).not.toHaveProperty("apiKey");
    expect(payload.scene.appState).not.toHaveProperty("accessToken");
    expect(payload.scene.appState).not.toHaveProperty("roomKey");
    expect(payload.scene.files).toEqual({
      [referencedId]: files[referencedId],
    });
    expect(payload).toMatchObject({
      version: 1,
      createdAt: 100,
      updatedAt: 200,
      generator: { name: "Calileon", version: "test-version" },
      document: { name: "Offline board" },
      capabilities: {
        editable: true,
        cloud: false,
        collaboration: false,
        ai: false,
      },
    });
    expect(isSingleFilePayload(payload)).toBe(true);
  });

  it("rejects payloads that enable private runtime capabilities", () => {
    expect(
      isSingleFilePayload({
        version: 1,
        generator: { name: "Calileon", version: "test" },
        scene: { elements: [], appState: {}, files: {} },
        capabilities: {
          editable: true,
          cloud: true,
          collaboration: false,
          ai: false,
        },
      }),
    ).toBe(false);
  });
});
