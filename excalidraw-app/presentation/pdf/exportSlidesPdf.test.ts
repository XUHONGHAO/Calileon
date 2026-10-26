import { vi } from "vitest";

import { getSlides } from "../slides";
import { makeFrame } from "../testUtils";

import {
  SlidesPdfAbortError,
  exportSlidesToPdf,
  getSlidesPdfFileName,
  wrapNoteLines,
} from "./exportSlidesPdf";

// The real renderer is the editor's export path; a small fixed-size canvas is
// enough to check paging, notes and progress.
vi.mock("../renderSlide", () => ({
  renderSlideToCanvas: async ({
    frame,
  }: {
    frame: { width: number; height: number };
  }) => {
    const canvas = document.createElement("canvas");
    const scale = 48 / Math.max(frame.width, frame.height);
    canvas.width = Math.round(frame.width * scale);
    canvas.height = Math.round(frame.height * scale);
    return canvas;
  },
}));

// jsdom's Blob has no arrayBuffer()
const readBytes = (blob: Blob) =>
  new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });

const readPdf = async (blob: Blob) => {
  const bytes = await readBytes(blob);
  let out = "";
  for (const byte of bytes) {
    out += String.fromCharCode(byte);
  }
  return out;
};

const mediaBoxes = (pdf: string) =>
  [...pdf.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((match) => [
    Number(match[1]),
    Number(match[2]),
  ]);

const deck = () =>
  getSlides([
    makeFrame({ id: "a", x: 0, width: 1600, height: 900 }),
    makeFrame({
      id: "b",
      x: 2000,
      width: 1600,
      height: 900,
      slide: { hidden: true },
    }),
    makeFrame({
      id: "c",
      x: 4000,
      width: 900,
      height: 1600,
      slide: { notes: "Closing words\n结束语" },
    }),
  ]);

const baseOptions = () => ({
  slides: deck(),
  elements: [],
  files: null,
  viewBackgroundColor: "#ffffff",
  darkMode: false,
  title: "Deck",
});

describe("exportSlidesToPdf", () => {
  it("writes one page per playable slide, long edge at 960 pt", async () => {
    const onProgress = vi.fn();
    const blob = await exportSlidesToPdf({
      ...baseOptions(),
      includeNotes: false,
      onProgress,
    });
    expect(blob.type).toBe("application/pdf");
    const pdf = await readPdf(blob);
    expect(pdf).toContain("/Count 2");
    expect(mediaBoxes(pdf)).toEqual([
      [960, 540],
      [540, 960],
    ]);
    expect(onProgress.mock.calls).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
  });

  it("adds a notes band under slides that have notes when asked", async () => {
    const pdf = await readPdf(
      await exportSlidesToPdf({ ...baseOptions(), includeNotes: true }),
    );
    const [first, last] = mediaBoxes(pdf);
    expect(first).toEqual([960, 540]);
    expect(last[0]).toBe(540);
    expect(last[1]).toBeGreaterThan(960);
  });

  it("stops with an abort error", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      exportSlidesToPdf({
        ...baseOptions(),
        includeNotes: false,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(SlidesPdfAbortError);
  });
});

describe("wrapNoteLines", () => {
  // one unit per character
  const measure = (value: string) => Array.from(value).length;

  it("breaks between words and keeps paragraphs", () => {
    expect(wrapNoteLines("one two three four", 9, measure)).toEqual([
      "one two",
      "three",
      "four",
    ]);
    expect(wrapNoteLines("a\n\nb\r\nc", 10, measure)).toEqual([
      "a",
      "",
      "b",
      "c",
    ]);
  });

  it("breaks CJK text between any two characters", () => {
    expect(wrapNoteLines("这是一段很长的备注", 4, measure)).toEqual([
      "这是一段",
      "很长的备",
      "注",
    ]);
    expect(wrapNoteLines("Hi 你好世界", 5, measure)).toEqual([
      "Hi 你好",
      "世界",
    ]);
  });

  it("splits a word longer than the line", () => {
    expect(wrapNoteLines("abcdefghij", 4, measure)).toEqual([
      "abcd",
      "efgh",
      "ij",
    ]);
  });
});

describe("getSlidesPdfFileName", () => {
  it("strips unsafe characters and falls back to a default name", () => {
    expect(getSlidesPdfFileName("Q3: plan/review")).toBe(
      "Q3- plan-review-slides.pdf",
    );
    expect(getSlidesPdfFileName("  ")).toBe("presentation-slides.pdf");
    expect(getSlidesPdfFileName("a\u0007b")).toBe("a-b-slides.pdf");
  });
});
