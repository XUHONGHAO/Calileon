import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { pointFrom } from "@excalidraw/math";
import { vi } from "vitest";

import type {
  BinaryFileData,
  BinaryFiles,
  DataURL,
} from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/element/types";
import type { LocalPoint } from "@excalidraw/math";

import {
  MASK_DRAWING_CONFIG,
  MASK_ERASER_CONFIG,
  exportMaskAsFile,
  generateMaskPreview,
  getMaskDrawingConfig,
} from "./maskCanvas";

const TEST_FILE_ID = "mask-image-file" as FileId;
const TEST_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lw9H8wAAAABJRU5ErkJggg==" as DataURL;

describe("maskCanvas", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exposes mask drawing and eraser configs", () => {
    expect(MASK_DRAWING_CONFIG).toMatchObject({
      strokeColor: "#ffffff",
      backgroundColor: "transparent",
      strokeWidth: 20,
      roughness: 0,
      opacity: 0,
      strokeStyle: "solid",
    });
    expect(MASK_ERASER_CONFIG).toMatchObject({
      strokeColor: "#000000",
      strokeWidth: 20,
      opacity: 0,
    });
    expect(getMaskDrawingConfig(false)).toBe(MASK_DRAWING_CONFIG);
    expect(getMaskDrawingConfig(true)).toBe(MASK_ERASER_CONFIG);
  });

  it("generates a black mask preview with a white freedraw stroke", () => {
    const targetImage = createTargetImage();
    const whiteStroke = API.createElement({
      type: "freedraw",
      x: 20,
      y: 30,
      strokeColor: "#ffffff",
      strokeWidth: 12,
      points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(30, 10)],
    });
    const { canvas, context, fills, strokes } = createCanvasMock();

    const dataURL = generateMaskPreview(targetImage, [whiteStroke], canvas);

    expect(dataURL).toBe(TEST_PNG_DATA_URL);
    expect(canvas.width).toBe(100);
    expect(canvas.height).toBe(80);
    expect(context.clearRect).toHaveBeenCalledWith(0, 0, 100, 80);
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 100, 80);
    expect(fills).toEqual([{ fillStyle: "#000000" }]);
    expect(context.moveTo).toHaveBeenCalledWith(10, 10);
    expect(context.lineTo).toHaveBeenCalledWith(40, 20);
    expect(strokes).toEqual([{ lineWidth: 12, strokeStyle: "#ffffff" }]);
  });

  it("renders black freedraw strokes as mask eraser marks", () => {
    const targetImage = createTargetImage();
    const whiteStroke = API.createElement({
      type: "freedraw",
      x: 20,
      y: 30,
      strokeColor: "#ffffff",
      strokeWidth: 12,
      points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(30, 10)],
    });
    const blackStroke = API.createElement({
      type: "freedraw",
      x: 30,
      y: 40,
      strokeColor: "#000000",
      strokeWidth: 18,
      points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(20, 5)],
    });
    const { canvas, context, strokes } = createCanvasMock();

    const dataURL = generateMaskPreview(
      targetImage,
      [whiteStroke, blackStroke],
      canvas,
    );

    expect(dataURL).toBe(TEST_PNG_DATA_URL);
    expect(canvas.width).toBe(100);
    expect(canvas.height).toBe(80);
    expect(context.moveTo).toHaveBeenNthCalledWith(2, 20, 20);
    expect(context.lineTo).toHaveBeenNthCalledWith(2, 40, 25);
    expect(strokes).toEqual([
      { lineWidth: 12, strokeStyle: "#ffffff" },
      { lineWidth: 18, strokeStyle: "#000000" },
    ]);
  });

  it("exports a valid PNG File at the source image dimensions", async () => {
    const targetImage = createTargetImage();
    const whiteStroke = API.createElement({
      type: "freedraw",
      x: 20,
      y: 30,
      strokeColor: "#ffffff",
      strokeWidth: 12,
      points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(30, 10)],
    });
    const { canvas, context, strokes } = createCanvasMock();
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((
      tagName: string,
      options?: ElementCreationOptions,
    ) => {
      if (tagName === "canvas") {
        return canvas;
      }

      return originalCreateElement(tagName, options);
    }) as typeof document.createElement);

    const file = exportMaskAsFile(targetImage, [whiteStroke], {
      [TEST_FILE_ID]: {
        ...createBinaryFileData(),
        naturalWidth: 200,
        naturalHeight: 160,
      } as BinaryFileData & { naturalWidth: number; naturalHeight: number },
    } as BinaryFiles);
    const bytes = new Uint8Array(await readFileAsArrayBuffer(file));

    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("mask-target-image.png");
    expect(file.type).toBe("image/png");
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(160);
    expect(context.moveTo).toHaveBeenCalledWith(20, 20);
    expect(context.lineTo).toHaveBeenCalledWith(80, 40);
    expect(strokes).toEqual([{ lineWidth: 24, strokeStyle: "#ffffff" }]);
  });
});

const createTargetImage = () =>
  API.createElement({
    type: "image",
    id: "target-image",
    fileId: TEST_FILE_ID,
    x: 10,
    y: 20,
    width: 100,
    height: 80,
    status: "saved",
  });

const createBinaryFileData = (): BinaryFileData => ({
  id: TEST_FILE_ID,
  dataURL: TEST_PNG_DATA_URL,
  mimeType: "image/png",
  created: 1,
  lastRetrieved: 1,
});

const readFileAsArrayBuffer = (file: File) =>
  new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });

const createCanvasMock = () => {
  const fills: Array<{ fillStyle: string }> = [];
  const strokes: Array<{ lineWidth: number; strokeStyle: string }> = [];
  const context = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    lineCap: "butt" as CanvasLineCap,
    lineJoin: "miter" as CanvasLineJoin,
    clearRect: vi.fn(),
    fillRect: vi.fn(() => {
      fills.push({
        fillStyle: context.fillStyle,
      });
    }),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(() => {
      strokes.push({
        lineWidth: context.lineWidth,
        strokeStyle: context.strokeStyle,
      });
    }),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context as unknown as CanvasRenderingContext2D),
    toDataURL: vi.fn(() => TEST_PNG_DATA_URL),
  } as unknown as HTMLCanvasElement;

  return { canvas, context, fills, strokes };
};
