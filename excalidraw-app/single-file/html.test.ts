import { API } from "@excalidraw/excalidraw/tests/helpers/api";

import type { FileId } from "@excalidraw/element/types";
import type { DataURL } from "@excalidraw/excalidraw/types";

import {
  injectSingleFilePayload,
  parseSingleFilePayload,
  serializeRuntimeDocument,
  serializeSingleFilePayload,
} from "./html";
import { createSingleFilePayload } from "./payload";
import {
  SINGLE_FILE_PAYLOAD_PLACEHOLDER,
  SINGLE_FILE_PAYLOAD_SCRIPT_ID,
} from "./types";

const createPayload = () => {
  const fileId = "roundtrip-image" as FileId;
  return createSingleFilePayload({
    elements: [
      API.createElement({
        type: "text",
        id: "dangerous-text",
        text: "</script><script>window.leaked=true</script>\u2028\u2029",
      }),
      API.createElement({
        type: "rectangle",
        id: "lumina-material",
        customData: {
          luminaMaterial: { roughness: 0.4, metallic: 0.5 },
          luminaLight: {
            light: "point",
            color: "#ffaa00",
            intensity: 0.8,
            radius: 300,
          },
        },
      }),
      API.createElement({
        type: "image",
        id: "roundtrip-image-element",
        fileId,
      }),
    ],
    appState: { luminaEnabled: true, luminaAmbient: 0.3 },
    files: {
      [fileId]: {
        id: fileId,
        dataURL: "data:image/png;base64,cm91bmR0cmlw" as DataURL,
        mimeType: "image/png",
        created: 1,
        lastRetrieved: 1,
      },
    },
    name: "Round trip",
    generatorVersion: "test",
    createdAt: 10,
    updatedAt: 20,
  });
};

describe("single-file HTML", () => {
  it("safely injects and parses payload without losing scene data", () => {
    const payload = createPayload();
    const template = `<!doctype html><html><body><div id="root"></div><script id="${SINGLE_FILE_PAYLOAD_SCRIPT_ID}" type="application/json">${SINGLE_FILE_PAYLOAD_PLACEHOLDER}</script><script>window.runtime=true</script></body></html>`;

    const html = injectSingleFilePayload(template, payload);

    expect(html).not.toContain("</script><script>window.leaked=true");
    expect(html).toContain("\\u003c/script>");
    expect(html).not.toContain(SINGLE_FILE_PAYLOAD_PLACEHOLDER);

    const restored = parseSingleFilePayload(html);
    expect(restored).toEqual(payload);
    expect(restored.scene.elements[1].customData).toEqual(
      payload.scene.elements[1].customData,
    );
    expect(restored.scene.files).toEqual(payload.scene.files);
  });

  it("serializes a live runtime document with an empty root", () => {
    const payload = createPayload();
    const document = new DOMParser().parseFromString(
      `<!doctype html><html><body><div id="root"><canvas></canvas></div><script id="${SINGLE_FILE_PAYLOAD_SCRIPT_ID}" type="application/json">{}</script></body></html>`,
      "text/html",
    );

    const html = serializeRuntimeDocument(document, payload);
    const serializedDocument = new DOMParser().parseFromString(
      html,
      "text/html",
    );

    expect(serializedDocument.querySelector("#root")?.childNodes).toHaveLength(
      0,
    );
    expect(parseSingleFilePayload(html)).toEqual(payload);
  });

  it("escapes script-breaking and JavaScript separator characters", () => {
    const serialized = serializeSingleFilePayload(createPayload());

    expect(serialized).not.toContain("</script>");
    expect(serialized).toContain("\\u003c/script>");
    expect(serialized).toContain("\\u2028");
    expect(serialized).toContain("\\u2029");
  });
});
