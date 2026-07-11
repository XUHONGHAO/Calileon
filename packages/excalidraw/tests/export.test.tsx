import React from "react";

import { SVG_NS } from "@excalidraw/common";

import type { FileId } from "@excalidraw/element/types";

import { getDefaultAppState } from "../appState";
import { getDataURL } from "../data/blob";
import { encodePngMetadata } from "../data/image";
import { serializeAsJSON } from "../data/json";
import { Excalidraw } from "../index";
import {
  decodeSvgBase64Payload,
  encodeSvgBase64Payload,
  exportToCanvas,
  exportToSvg,
} from "../scene/export";

import { API } from "./helpers/api";
import { render, waitFor } from "./test-utils";

const { h } = window;

const testElements = [
  {
    ...API.createElement({
      type: "text",
      id: "A",
      text: "😀",
      created: 1,
      updated: 1,
    }),
    // can't get jsdom text measurement to work so this is a temp hack
    // to ensure the element isn't stripped as invisible
    width: 16,
    height: 16,
  },
];

// tiny polyfill for TextDecoder.decode on which we depend
Object.defineProperty(window, "TextDecoder", {
  value: class TextDecoder {
    decode(ab: ArrayBuffer) {
      return new Uint8Array(ab).reduce(
        (acc, c) => acc + String.fromCharCode(c),
        "",
      );
    }
  },
});

describe("export", () => {
  beforeEach(async () => {
    await render(<Excalidraw />);
  });

  it("export embedded png and reimport", async () => {
    const pngBlob = await API.loadFile("./fixtures/smiley.png");
    const pngBlobEmbedded = await encodePngMetadata({
      blob: pngBlob,
      metadata: serializeAsJSON(testElements, h.state, {}, "local"),
    });
    await API.drop([{ kind: "file", file: pngBlobEmbedded }]);

    await waitFor(() => {
      expect(h.elements).toEqual([
        expect.objectContaining({ type: "text", text: "😀" }),
      ]);
    });
  });

  it("test encoding/decoding scene for SVG export", async () => {
    const metadataElement = document.createElementNS(SVG_NS, "metadata");

    encodeSvgBase64Payload({
      metadataElement,
      payload: serializeAsJSON(testElements, h.state, {}, "local"),
    });

    const decoded = JSON.parse(
      decodeSvgBase64Payload({ svg: metadataElement.innerHTML }),
    );
    expect(decoded.elements).toEqual([
      expect.objectContaining({ type: "text", text: "😀" }),
    ]);
  });

  it("keeps Lumina game effects off by default and includes all three raster modes when enabled", async () => {
    const light = API.createElement({
      type: "ellipse",
      id: "lumina-light",
      x: 0,
      y: 0,
      width: 40,
      height: 40,
      customData: {
        luminaLight: {
          light: "point",
          color: "#80eaff",
          intensity: 1,
          radius: 500,
          castShadows: true,
        },
        luminaGame: { role: "emitter" },
      },
    });
    const roleElement = (role: "target" | "shadowTarget" | "treasure") =>
      API.createElement({
        type: "rectangle",
        id: `lumina-${role}`,
        x: 100,
        y: 0,
        width: 40,
        height: 40,
        customData: {
          luminaGame: { role, tolerance: role === "target" ? 24 : 0.25 },
        },
      });
    const renderCount = async (
      style: "laser" | "shadow-reveal" | "dark-room",
      includeGameEffects?: boolean,
    ) => {
      const role =
        style === "laser"
          ? "target"
          : style === "shadow-reveal"
          ? "shadowTarget"
          : "treasure";
      let drawImageCalls = 0;
      await exportToCanvas(
        [light, roleElement(role)],
        {
          ...h.state,
          luminaEnabled: true,
          luminaAmbient: 0.35,
          luminaGameMode: { style, phase: "play" },
          exportIncludeGameEffects: includeGameEffects ?? false,
        },
        {},
        {
          exportBackground: true,
          viewBackgroundColor: "#ffffff",
          includeGameEffects,
        },
        (width, height) => {
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d")!;
          const originalDrawImage = ctx.drawImage.bind(ctx);
          ctx.drawImage = ((...args: Parameters<typeof ctx.drawImage>) => {
            drawImageCalls += 1;
            return originalDrawImage(...args);
          }) as typeof ctx.drawImage;
          return { canvas, scale: 1 };
        },
        async () => undefined,
      );
      return drawImageCalls;
    };

    for (const style of ["laser", "shadow-reveal", "dark-room"] as const) {
      const defaultCount = await renderCount(style);
      const explicitOffCount = await renderCount(style, false);
      const enabledCount = await renderCount(style, true);
      expect(defaultCount).toBe(explicitOffCount);
      expect(enabledCount).toBeGreaterThan(explicitOffCount);
    }
  });

  it("does not write game session progress into elements during raster export", async () => {
    const elements = [
      API.createElement({
        type: "ellipse",
        id: "light",
        x: 0,
        y: 0,
        width: 40,
        height: 40,
        customData: {
          luminaLight: {
            light: "point",
            color: "#fff",
            intensity: 1,
            radius: 500,
            castShadows: true,
          },
        },
      }),
      API.createElement({
        type: "diamond",
        id: "treasure",
        x: 100,
        y: 0,
        width: 40,
        height: 40,
        customData: {
          luminaGame: { role: "treasure", tolerance: 0.2 },
        },
      }),
    ];
    const beforeCustomData = elements.map((element) => element.customData);
    await exportToCanvas(
      elements,
      {
        ...h.state,
        luminaEnabled: true,
        luminaGameMode: { style: "dark-room", phase: "play" },
      },
      {},
      {
        exportBackground: true,
        viewBackgroundColor: "#fff",
        includeGameEffects: true,
      },
      undefined,
      async () => undefined,
    );
    expect(elements.map((element) => element.customData)).toEqual(
      beforeCustomData,
    );
  });

  it("keeps SVG output identical when raster game effects are enabled", async () => {
    const element = API.createElement({
      type: "rectangle",
      id: "svg-treasure",
      x: 0,
      y: 0,
      width: 40,
      height: 40,
      customData: { luminaGame: { role: "treasure" } },
    });
    const appState = {
      ...getDefaultAppState(),
      luminaEnabled: true,
      luminaGameMode: { style: "dark-room", phase: "play" } as const,
    };
    const withoutEffects = await exportToSvg(
      [element],
      { ...appState, exportIncludeGameEffects: false } as any,
      {},
    );
    const withEffects = await exportToSvg(
      [element],
      { ...appState, exportIncludeGameEffects: true } as any,
      {},
    );
    expect(withEffects.outerHTML).toBe(withoutEffects.outerHTML);
  });

  it("export svg-embedded scene", async () => {
    const appState = {
      ...getDefaultAppState(),
      luminaAmbient: 1,
    };
    const svg = await exportToSvg(
      testElements,
      {
        ...appState,
        exportEmbedScene: true,
      },
      {},
    );
    const svgText = svg.outerHTML;

    expect(svgText).toMatchSnapshot(`svg-embdedded scene export output`);
  });

  it("import embedded png (legacy v1)", async () => {
    await API.drop([
      {
        kind: "file",
        file: await API.loadFile("./fixtures/test_embedded_v1.png"),
      },
    ]);
    await waitFor(() => {
      expect(h.elements).toEqual([
        expect.objectContaining({ type: "text", text: "test" }),
      ]);
    });
  });

  it("import embedded png (v2)", async () => {
    await API.drop([
      {
        kind: "file",
        file: await API.loadFile("./fixtures/smiley_embedded_v2.png"),
      },
    ]);
    await waitFor(() => {
      expect(h.elements).toEqual([
        expect.objectContaining({ type: "text", text: "😀" }),
      ]);
    });
  });

  it("import embedded svg (legacy v1)", async () => {
    await API.drop([
      {
        kind: "file",
        file: await API.loadFile("./fixtures/test_embedded_v1.svg"),
      },
    ]);
    await waitFor(() => {
      expect(h.elements).toEqual([
        expect.objectContaining({ type: "text", text: "test" }),
      ]);
    });
  });

  it("import embedded svg (v2)", async () => {
    await API.drop([
      {
        kind: "file",
        file: await API.loadFile("./fixtures/smiley_embedded_v2.svg"),
      },
    ]);
    await waitFor(() => {
      expect(h.elements).toEqual([
        expect.objectContaining({ type: "text", text: "😀" }),
      ]);
    });
  });

  it("exporting svg containing transformed images", async () => {
    const normalizeAngle = (angle: number) => (angle / 180) * Math.PI;

    const elements = [
      API.createElement({
        type: "image",
        fileId: "file_A",
        x: 0,
        y: 0,
        scale: [1, 1],
        width: 100,
        height: 100,
        angle: normalizeAngle(315),
      }),
      API.createElement({
        type: "image",
        fileId: "file_A",
        x: 100,
        y: 0,
        scale: [-1, 1],
        width: 50,
        height: 50,
        angle: normalizeAngle(45),
      }),
      API.createElement({
        type: "image",
        fileId: "file_A",
        x: 0,
        y: 100,
        scale: [1, -1],
        width: 100,
        height: 100,
        angle: normalizeAngle(45),
      }),
      API.createElement({
        type: "image",
        fileId: "file_A",
        x: 100,
        y: 100,
        scale: [-1, -1],
        width: 50,
        height: 50,
        angle: normalizeAngle(315),
      }),
    ];
    const appState = { ...getDefaultAppState(), exportBackground: false };
    const files = {
      file_A: {
        id: "file_A" as FileId,
        dataURL: await getDataURL(await API.loadFile("./fixtures/deer.png")),
        mimeType: "image/png",
        created: Date.now(),
        lastRetrieved: Date.now(),
      },
    } as const;

    const svg = await exportToSvg(elements, appState, files);

    const svgText = svg.outerHTML;
    const snapshotSvgText = svgText.replace(
      /\sdata-id="[^"]+"/g,
      ' data-id="<normalized>"',
    );

    // expect 1 <image> element (deduped)
    expect(svgText.match(/<image/g)?.length).toBe(1);
    // expect 4 <use> elements (one for each excalidraw image element)
    expect(svgText.match(/<use/g)?.length).toBe(4);

    // in case of regressions, save the SVG to a file and visually compare to:
    // src/tests/fixtures/svg-image-exporting-reference.svg
    expect(snapshotSvgText).toMatchSnapshot(`svg export output`);
  });
});
