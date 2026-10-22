import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { FONT_FAMILY, randomId } from "@excalidraw/common";
import { generateIdFromFile } from "@excalidraw/excalidraw/data/blob";
import {
  getCommonBounds,
  newImageElement,
  newTextElement,
  syncInvalidIndices,
} from "@excalidraw/element";
import { normalizeText } from "@excalidraw/element/textMeasurements";

import type {
  BinaryFileData,
  DataURL,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
  FileId,
  InitializedExcalidrawImageElement,
  NonDeleted,
} from "@excalidraw/element/types";

import { dataURLToFile } from "./imageCanvas";
import { sanitizeRorschachRelation } from "./rorschachPersonas";

import type { RorschachPortableRelation } from "./rorschachTypes";

/**
 * G6 inserts the picture and the handwritten reading as ONE scene update so a
 * single undo removes both. `insertGeneratedImageIntoCanvas` cannot be reused:
 * it captures its own history entry before the text exists.
 */

const RORSCHACH_MAX_IMAGE_SIZE = 512;
const RORSCHACH_GAP = 24;
const RORSCHACH_READING_FONT_SIZE = 20;
const RORSCHACH_TEXT_GAP = 12;
const RORSCHACH_PLACEMENT_SCAN_LIMIT = 24;

export type RorschachInsertResult = {
  imageElement: NonDeleted<InitializedExcalidrawImageElement> | null;
  textElement: NonDeleted<ExcalidrawTextElement>;
};

type InsertRorschachOptions = {
  excalidrawAPI: ExcalidrawImperativeAPI;
  relation: RorschachPortableRelation;
  imageOutput: { dataURL: string; mimeType: string } | null;
  reading: string | null;
  /** Bounds of the scribble the reading came from, when still known. */
  sourceBounds: { x: number; y: number; width: number; height: number } | null;
  signal?: AbortSignal;
};

const RORSCHACH_DIMENSION_TIMEOUT_MS = 4000;

/**
 * Intrinsic size of the generated picture. Falls back to the default size when
 * the browser cannot decode it, so a bad payload can never block insertion.
 */
const getImageDimensions = (dataURL: string, signal?: AbortSignal) =>
  new Promise<{ width: number; height: number }>((resolve) => {
    const image = new Image();
    let settled = false;
    const finish = (size: { width: number; height: number }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(size);
    };
    const onAbort = () =>
      finish({
        width: RORSCHACH_MAX_IMAGE_SIZE,
        height: RORSCHACH_MAX_IMAGE_SIZE,
      });
    const timer = setTimeout(
      () =>
        finish({
          width: RORSCHACH_MAX_IMAGE_SIZE,
          height: RORSCHACH_MAX_IMAGE_SIZE,
        }),
      RORSCHACH_DIMENSION_TIMEOUT_MS,
    );

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    image.onload = () =>
      finish({
        width: image.naturalWidth || image.width || RORSCHACH_MAX_IMAGE_SIZE,
        height: image.naturalHeight || image.height || RORSCHACH_MAX_IMAGE_SIZE,
      });
    image.onerror = () =>
      finish({
        width: RORSCHACH_MAX_IMAGE_SIZE,
        height: RORSCHACH_MAX_IMAGE_SIZE,
      });
    image.src = dataURL;
  });

const fitImage = ({ width, height }: { width: number; height: number }) => {
  const safeWidth = Math.max(1, Math.round(width));
  const safeHeight = Math.max(1, Math.round(height));
  const scale = Math.min(
    1,
    RORSCHACH_MAX_IMAGE_SIZE / Math.max(safeWidth, safeHeight),
  );
  return {
    width: Math.round(safeWidth * scale),
    height: Math.round(safeHeight * scale),
  };
};

const overlaps = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) => {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
};

const getElementBounds = (element: ExcalidrawElement) => ({
  x: element.x,
  y: element.y,
  width: element.width,
  height: element.height,
});

/**
 * Places the output to the right of the scribble, then keeps shifting right
 * until it no longer covers anything already on the canvas.
 */
export const getRorschachInsertPosition = ({
  size,
  sourceBounds,
  sceneElements,
}: {
  size: { width: number; height: number };
  sourceBounds: { x: number; y: number; width: number; height: number } | null;
  sceneElements: readonly ExcalidrawElement[];
}) => {
  const live = sceneElements.filter((element) => !element.isDeleted);
  const anchor =
    sourceBounds ||
    (live.length
      ? (() => {
          const [minX, minY, maxX, maxY] = getCommonBounds(live);
          return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
        })()
      : { x: 0, y: 0, width: 0, height: 0 });

  const y = anchor.y;
  let x = anchor.x + anchor.width + RORSCHACH_GAP;

  for (let attempt = 0; attempt < RORSCHACH_PLACEMENT_SCAN_LIMIT; attempt++) {
    const candidate = { x, y, width: size.width, height: size.height };
    const colliding = live.filter((element) =>
      overlaps(candidate, getElementBounds(element)),
    );
    if (!colliding.length) {
      break;
    }
    // Jump past everything currently in the way, then re-check.
    x =
      Math.max(...colliding.map((element) => element.x + element.width)) +
      RORSCHACH_GAP;
  }

  return { x, y };
};

/** Wraps the reading so the text block never gets wider than the picture. */
export const wrapRorschachReading = (
  reading: string,
  maxWidth: number,
): string => {
  const normalized = normalizeText(reading.trim());
  if (!normalized) {
    return "";
  }
  const words = normalized.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  // CJK text has no spaces; fall back to per-character wrapping there.
  const tokens = words.length > 1 ? words : Array.from(normalized);
  const separator = words.length > 1 ? " " : "";
  // Conservative per-token width estimate; the actual metrics come from
  // newTextElement, this only bounds the wrap.
  const tokenBudget = Math.max(
    4,
    Math.floor(maxWidth / (RORSCHACH_READING_FONT_SIZE * 0.6)),
  );

  for (const token of tokens) {
    const next = current ? `${current}${separator}${token}` : token;
    if (next.length > tokenBudget && current) {
      lines.push(current);
      current = token;
    } else {
      current = next;
    }
  }
  if (current) {
    lines.push(current);
  }

  return lines.join("\n");
};

export const insertRorschachResultIntoCanvas = async ({
  excalidrawAPI,
  relation,
  imageOutput,
  reading,
  sourceBounds,
  signal,
}: InsertRorschachOptions): Promise<RorschachInsertResult | null> => {
  signal?.throwIfAborted();

  const sanitized = sanitizeRorschachRelation(relation);
  let file: BinaryFileData | null = null;
  let imageSize: { width: number; height: number } | null = null;

  if (imageOutput?.dataURL?.startsWith("data:image/")) {
    const dataURL = imageOutput.dataURL as DataURL;
    const mimeType = imageOutput.mimeType || "image/png";
    const id = await generateIdFromFile(
      dataURLToFile(dataURL, `rorschach-${sanitized.batchId}.png`, mimeType),
    );
    signal?.throwIfAborted();
    const intrinsic = await getImageDimensions(dataURL, signal);
    signal?.throwIfAborted();
    imageSize = fitImage(intrinsic);
    file = {
      id: id as FileId,
      dataURL,
      mimeType: mimeType as BinaryFileData["mimeType"],
      created: Date.now(),
      lastRetrieved: Date.now(),
    };
  }

  const readingText = reading ? wrapRorschachReading(reading, 320) : "";
  if (!file && !readingText) {
    return null;
  }

  const sceneElements = excalidrawAPI.getSceneElements();
  const position = getRorschachInsertPosition({
    size: imageSize || { width: 240, height: 0 },
    sourceBounds,
    sceneElements,
  });

  const groupId = randomId();
  const customData = { rorschach: sanitized };
  const imageElement = file
    ? (newImageElement({
        type: "image",
        x: position.x,
        y: position.y,
        width: imageSize!.width,
        height: imageSize!.height,
        status: "saved",
        fileId: file.id,
        groupIds: [groupId],
        customData,
      }) as NonDeleted<InitializedExcalidrawImageElement>)
    : null;

  const textWidth = imageElement ? imageElement.width : 240;
  const textElement = newTextElement({
    x: position.x,
    y: imageElement
      ? imageElement.y + imageElement.height + RORSCHACH_TEXT_GAP
      : position.y,
    text: readingText,
    fontSize: RORSCHACH_READING_FONT_SIZE,
    fontFamily: FONT_FAMILY.Excalifont,
    groupIds: [groupId],
    customData,
  }) as NonDeleted<ExcalidrawTextElement>;

  // Text metrics can exceed the planned width (long unbroken CJK runs), so
  // re-wrap once against the measured width and rebuild the element.
  let placedText = textElement;
  if (placedText.width > textWidth) {
    const rewrapped = wrapRorschachReading(readingText, textWidth);
    if (rewrapped && rewrapped !== placedText.text) {
      placedText = newTextElement({
        x: position.x,
        y: textElement.y,
        text: rewrapped,
        fontSize: RORSCHACH_READING_FONT_SIZE,
        fontFamily: FONT_FAMILY.Excalifont,
        groupIds: [groupId],
        customData,
      }) as NonDeleted<ExcalidrawTextElement>;
    }
  }

  signal?.throwIfAborted();

  const inserted = imageElement ? [imageElement, placedText] : [placedText];
  const nextElements = [...sceneElements, ...inserted];
  syncInvalidIndices(nextElements);

  if (file) {
    excalidrawAPI.addFiles([file]);
  }
  excalidrawAPI.updateScene({
    elements: nextElements,
    appState: {
      selectedElementIds: Object.fromEntries(
        inserted.map((element) => [element.id, true]),
      ),
    },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });

  return { imageElement, textElement: placedText };
};
