import { t } from "@excalidraw/excalidraw/i18n";
import { applyDarkModeFilter } from "@excalidraw/common";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type {
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { renderSlideToCanvas } from "../renderSlide";
import { getPlayableSlides, getSlides } from "../slides";

import { PdfWriter, encodePdfImage, rgbaToRgbOnWhite } from "./pdfWriter";

import type { EncodedPdfImage } from "./pdfWriter";
import type { Slide } from "../slides";

/** Bitmap long edge per slide (ADR 0036 §5). */
export const PDF_SLIDE_LONG_EDGE_PX = 2400;
/** The slide's long edge on the PDF page (13.33 in, a 16:9 deck's width). */
export const PDF_SLIDE_LONG_EDGE_PT = 960;
/** Lossless pages above this switch to JPEG when that is smaller. */
const LOSSLESS_PAGE_BUDGET_BYTES = 1.5 * 1024 * 1024;
const JPEG_QUALITY = 0.92;

const NOTES_FONT_FAMILY =
  'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

export class SlidesPdfAbortError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

// CJK ideographs, kana, hangul and full-width forms break anywhere.
const WIDE = "\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef";
const NOTE_TOKEN = new RegExp(`\\s+|[${WIDE}]|[^\\s${WIDE}]+`, "gu");

/**
 * Wraps plain text to `maxWidth`: CJK breaks between any two characters,
 * other scripts between words; an over-long word is split by character.
 */
export const wrapNoteLines = (
  text: string,
  maxWidth: number,
  measure: (value: string) => number,
) => {
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    const tokens = paragraph.match(NOTE_TOKEN) ?? [];
    let line = "";
    const pushToken = (token: string) => {
      if (measure(line + token) <= maxWidth || !line) {
        line += token;
        return;
      }
      lines.push(line.trimEnd());
      line = /^\s+$/.test(token) ? "" : token;
    };
    for (const token of tokens) {
      if (!/^\s+$/.test(token) && measure(token) > maxWidth) {
        for (const char of Array.from(token)) {
          pushToken(char);
        }
      } else {
        pushToken(token);
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
};

const renderNotesCanvas = (notes: string, width: number, darkMode: boolean) => {
  const padding = Math.round(width * 0.04);
  const fontSize = Math.max(16, Math.round(width / 60));
  const labelSize = Math.round(fontSize * 0.8);
  const lineHeight = Math.round(fontSize * 1.5);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  context.font = `${fontSize}px ${NOTES_FONT_FAMILY}`;
  const lines = wrapNoteLines(
    notes,
    width - padding * 2,
    (value) => context.measureText(value).width,
  );
  canvas.width = width;
  canvas.height =
    padding * 2 +
    labelSize +
    Math.round(lineHeight * 0.6) +
    lines.length * lineHeight;
  // resizing resets the context state
  const background = darkMode ? applyDarkModeFilter("#ffffff") : "#ffffff";
  const text = darkMode ? applyDarkModeFilter("#1e1e1e") : "#1e1e1e";
  const muted = darkMode ? applyDarkModeFilter("#6b6b6b") : "#6b6b6b";
  context.fillStyle = background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = muted;
  context.fillRect(padding, 0, width - padding * 2, Math.max(1, width / 1200));
  context.textBaseline = "top";
  context.font = `600 ${labelSize}px ${NOTES_FONT_FAMILY}`;
  context.fillText(t("ai.presentation.notesHeading"), padding, padding);
  context.fillStyle = text;
  context.font = `${fontSize}px ${NOTES_FONT_FAMILY}`;
  const top = padding + labelSize + Math.round(lineHeight * 0.6);
  lines.forEach((line, index) => {
    context.fillText(line, padding, top + index * lineHeight);
  });
  return canvas;
};

const stackCanvases = (top: HTMLCanvasElement, bottom: HTMLCanvasElement) => {
  const canvas = document.createElement("canvas");
  canvas.width = top.width;
  canvas.height = top.height + bottom.height;
  const context = canvas.getContext("2d")!;
  context.drawImage(top, 0, 0);
  context.drawImage(bottom, 0, top.height);
  return canvas;
};

const canvasToJpeg = (canvas: HTMLCanvasElement) =>
  new Promise<Uint8Array | null>((resolve) => {
    if (!canvas.toBlob) {
      resolve(null);
      return;
    }
    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          resolve(null);
          return;
        }
        resolve(new Uint8Array(await blob.arrayBuffer()));
      },
      "image/jpeg",
      JPEG_QUALITY,
    );
  });

/** Lossless first; JPEG only when it is the much smaller choice (photos). */
const encodeCanvas = async (
  canvas: HTMLCanvasElement,
): Promise<EncodedPdfImage> => {
  const context = canvas.getContext("2d")!;
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const lossless = encodePdfImage({
    kind: "rgb",
    width: canvas.width,
    height: canvas.height,
    rgb: rgbaToRgbOnWhite(data),
  });
  if (lossless.data.length <= LOSSLESS_PAGE_BUDGET_BYTES) {
    return lossless;
  }
  const jpeg = await canvasToJpeg(canvas);
  return jpeg && jpeg.length < lossless.data.length
    ? encodePdfImage({
        kind: "jpeg",
        width: canvas.width,
        height: canvas.height,
        jpeg,
      })
    : lossless;
};

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

export type ExportSlidesPdfOptions = {
  slides: readonly Slide[];
  elements: readonly ExcalidrawElement[];
  files: BinaryFiles | null;
  viewBackgroundColor: string;
  darkMode: boolean;
  includeNotes: boolean;
  title: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
};

/** Renders the playable slides page by page into a PDF blob. */
export const exportSlidesToPdf = async ({
  slides,
  elements,
  files,
  viewBackgroundColor,
  darkMode,
  includeNotes,
  title,
  signal,
  onProgress,
}: ExportSlidesPdfOptions): Promise<Blob> => {
  const playable = getPlayableSlides(slides);
  const writer = new PdfWriter(title);
  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw new SlidesPdfAbortError();
    }
  };
  onProgress?.(0, playable.length);
  for (const [index, slide] of playable.entries()) {
    throwIfAborted();
    const slideCanvas = await renderSlideToCanvas({
      frame: slide.frame,
      elements,
      files,
      viewBackgroundColor,
      darkMode,
      longEdge: PDF_SLIDE_LONG_EDGE_PX,
    });
    throwIfAborted();
    const notes = includeNotes ? slide.data.notes?.trim() : "";
    const notesCanvas = notes
      ? renderNotesCanvas(notes, slideCanvas.width, darkMode)
      : null;
    const pageCanvas = notesCanvas
      ? stackCanvases(slideCanvas, notesCanvas)
      : slideCanvas;
    const image = await encodeCanvas(pageCanvas);
    const ptPerPx =
      PDF_SLIDE_LONG_EDGE_PT / Math.max(slideCanvas.width, slideCanvas.height);
    writer.addImagePage(
      image,
      pageCanvas.width * ptPerPx,
      pageCanvas.height * ptPerPx,
    );
    onProgress?.(index + 1, playable.length);
    // let the progress paint and the cancel button respond
    await nextTask();
  }
  throwIfAborted();
  return new Blob(writer.finish() as BlobPart[], { type: "application/pdf" });
};

/** Reads the live scene, exports its playable slides and downloads the PDF. */
export const exportScenePdf = async (
  api: ExcalidrawImperativeAPI,
  opts: Pick<ExportSlidesPdfOptions, "includeNotes" | "signal" | "onProgress">,
) => {
  const appState = api.getAppState();
  const elements = api.getSceneElements();
  const blob = await exportSlidesToPdf({
    ...opts,
    slides: getSlides(elements),
    elements,
    files: api.getFiles(),
    viewBackgroundColor: appState.viewBackgroundColor,
    darkMode: appState.exportWithDarkMode,
    title: api.getName(),
  });
  downloadBlob(blob, getSlidesPdfFileName(api.getName()));
};

// path separators, Windows-reserved characters and control characters
const UNSAFE_FILE_NAME_CHARS = /[\\/:*?"<>|\p{Cc}]+/gu;

export const getSlidesPdfFileName = (sceneName: string) => {
  const base =
    sceneName.replace(UNSAFE_FILE_NAME_CHARS, "-").trim() ||
    t("ai.presentation.defaultFileName");
  return `${base}-${t("ai.presentation.fileSuffix")}.pdf`;
};

export const downloadBlob = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // give the download a moment to start before releasing the blob
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
};
