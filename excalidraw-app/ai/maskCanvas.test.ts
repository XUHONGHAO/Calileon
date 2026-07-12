import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { pointFrom } from "@excalidraw/math";
import { vi } from "vitest";

import type {
  BinaryFileData,
  BinaryFiles,
  DataURL,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawImageElement, FileId } from "@excalidraw/element/types";
import type { LocalPoint, Radians } from "@excalidraw/math";

import {
  MASK_DRAWING_CONFIG,
  MASK_ERASER_CONFIG,
  MASK_SOURCE_IMAGE_LOAD_TIMEOUT_MS,
  exportMaskAsFile,
  generateMaskPreview,
  getMaskDisplayToNaturalTransform,
  getMaskDrawingConfig,
  localMaskPointToDisplayPoint,
} from "./maskCanvas";

const TEST_FILE_ID = "mask-image-file" as FileId;
const TEST_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lw9H8wAAAABJRU5ErkJggg==" as DataURL;

describe("maskCanvas", () => {
  beforeEach(() => {
    vi.stubGlobal("Image", TestImage);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

  it("decodes the real source data URL dimensions for export", async () => {
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

    const file = await exportMaskAsFile(targetImage, [whiteStroke], {
      [TEST_FILE_ID]: createBinaryFileData(createSVGDataURL(200, 160)),
    } as BinaryFiles);
    const bytes = new Uint8Array(await readFileAsArrayBuffer(file));

    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("mask-target-image.png");
    expect(file.type).toBe("image/png");
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(160);
    expect(context.moveTo).toHaveBeenCalledWith(10, 10);
    expect(context.lineTo).toHaveBeenCalledWith(40, 20);
    expect(context.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
    expect(strokes).toEqual([{ lineWidth: 12, strokeStyle: "#ffffff" }]);
  });

  it.each([
    {
      name: "crop offset",
      scale: [1, 1] as [number, number],
      expected: [1, 0, 0, 1, 100, 50],
    },
    {
      name: "horizontal flip",
      scale: [-1, 1] as [number, number],
      expected: [-1, 0, 0, 1, 300, 50],
    },
    {
      name: "vertical flip",
      scale: [1, -1] as [number, number],
      expected: [1, 0, 0, -1, 100, 200],
    },
    {
      name: "combined flips",
      scale: [-1, -1] as [number, number],
      expected: [-1, 0, 0, -1, 300, 200],
    },
  ])(
    "maps display pixels through $name into the natural crop",
    ({ scale, expected }) => {
      const targetImage = createTargetImage({
        width: 200,
        height: 150,
        scale,
        crop: {
          x: 100,
          y: 50,
          width: 200,
          height: 150,
          naturalWidth: 400,
          naturalHeight: 300,
        },
      });

      const transform = getMaskDisplayToNaturalTransform(targetImage, {
        width: 400,
        height: 300,
      });

      expect([
        transform.scaleX,
        0,
        0,
        transform.scaleY,
        transform.translateX,
        transform.translateY,
      ]).toEqual(expected);
    },
  );

  it("removes target and stroke rotation before natural-pixel mapping", () => {
    const targetImage = createTargetImage({
      x: 100,
      y: 200,
      width: 200,
      height: 100,
      angle: (Math.PI / 2) as Radians,
    });
    const targetCenter = [200, 250] as const;
    const intendedDisplayPoint = [120, 230] as const;
    const rotatedScenePoint = rotateTestPoint(
      intendedDisplayPoint,
      targetCenter,
      targetImage.angle,
    );
    const stroke = API.createElement({
      type: "freedraw",
      x: rotatedScenePoint[0],
      y: rotatedScenePoint[1],
      angle: 0,
      points: [pointFrom<LocalPoint>(0, 0)],
    });

    const displayPoint = localMaskPointToDisplayPoint(
      targetImage,
      stroke,
      stroke.points[0],
    );
    expect(displayPoint[0]).toBeCloseTo(20);
    expect(displayPoint[1]).toBeCloseTo(30);
  });

  it("fails explicitly when the source image dimensions cannot be decoded", async () => {
    const targetImage = createTargetImage();
    vi.stubGlobal(
      "Image",
      class BrokenImage extends TestImage {
        public override set src(_value: string) {
          queueMicrotask(() => this.onerror?.(new Event("error")));
        }
      },
    );

    await expect(
      exportMaskAsFile(targetImage, [], {
        [TEST_FILE_ID]: createBinaryFileData(
          "data:image/png;base64,invalid" as DataURL,
        ),
      } as BinaryFiles),
    ).rejects.toThrow("Could not decode the source image dimensions.");
  });

  it("aborts a pending source image decode and cleans up its handlers", async () => {
    const targetImage = createTargetImage();
    const controller = new AbortController();
    const hangingImage = new HangingImage();
    vi.stubGlobal(
      "Image",
      class ImageStub {
        constructor() {
          return hangingImage;
        }
      },
    );

    const exportPromise = exportMaskAsFile(
      targetImage,
      [],
      {
        [TEST_FILE_ID]: createBinaryFileData(createSVGDataURL(200, 160)),
      } as BinaryFiles,
      controller.signal,
    );
    const rejection = expect(exportPromise).rejects.toMatchObject({
      name: "AbortError",
    });

    controller.abort();

    await rejection;
    expect(hangingImage.onload).toBeNull();
    expect(hangingImage.onerror).toBeNull();
  });

  it("times out a source image decode that never settles", async () => {
    vi.useFakeTimers();
    const targetImage = createTargetImage();
    const hangingImage = new HangingImage();
    vi.stubGlobal(
      "Image",
      class ImageStub {
        constructor() {
          return hangingImage;
        }
      },
    );

    const exportPromise = exportMaskAsFile(targetImage, [], {
      [TEST_FILE_ID]: createBinaryFileData(createSVGDataURL(200, 160)),
    } as BinaryFiles);
    const rejection = expect(exportPromise).rejects.toThrow(
      "Timed out while decoding the source image dimensions.",
    );

    await vi.advanceTimersByTimeAsync(MASK_SOURCE_IMAGE_LOAD_TIMEOUT_MS);

    await rejection;
    expect(hangingImage.onload).toBeNull();
    expect(hangingImage.onerror).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

const createTargetImage = (overrides: Partial<ExcalidrawImageElement> = {}) => {
  const image = API.createElement({
    type: "image",
    id: "target-image",
    fileId: TEST_FILE_ID,
    x: 10,
    y: 20,
    width: 100,
    height: 80,
    status: "saved",
  });

  return {
    ...image,
    ...overrides,
  } as ExcalidrawImageElement;
};

const createBinaryFileData = (
  dataURL: DataURL = TEST_PNG_DATA_URL,
): BinaryFileData => ({
  id: TEST_FILE_ID,
  dataURL,
  mimeType: dataURL.startsWith("data:image/svg+xml")
    ? "image/svg+xml"
    : "image/png",
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
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
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

const createSVGDataURL = (width: number, height: number) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"></svg>`,
  )}` as DataURL;

class TestImage {
  public naturalWidth = 0;
  public naturalHeight = 0;
  public width = 0;
  public height = 0;
  public onload: ((event: Event) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;

  public set src(value: string) {
    const decoded = decodeURIComponent(value.slice(value.indexOf(",") + 1));
    const width = Number(decoded.match(/width="(\d+)"/)?.[1]);
    const height = Number(decoded.match(/height="(\d+)"/)?.[1]);

    if (!width || !height) {
      queueMicrotask(() => this.onerror?.(new Event("error")));
      return;
    }

    this.naturalWidth = width;
    this.naturalHeight = height;
    queueMicrotask(() => this.onload?.(new Event("load")));
  }
}

class HangingImage extends TestImage {
  public override set src(_value: string) {}
}

const rotateTestPoint = (
  point: readonly [number, number],
  center: readonly [number, number],
  angle: number,
) => {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const x = point[0] - center[0];
  const y = point[1] - center[1];

  return [
    x * cos - y * sin + center[0],
    x * sin + y * cos + center[1],
  ] as const;
};
