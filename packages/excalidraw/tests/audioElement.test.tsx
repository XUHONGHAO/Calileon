import type { ExcalidrawAudioElement, FileId } from "@excalidraw/element/types";

import { isPropertyEditable } from "../components/Stats/utils";
import { serializeAsClipboardJSON } from "../clipboard";
import { restoreElements } from "../data/restore";
import { exportToSvg } from "../scene/export";

import { API } from "./helpers/api";

import type { BinaryFiles, DataURL } from "../types";

const voice = (overrides: Partial<ExcalidrawAudioElement> = {}) =>
  ({
    ...API.createElement({
      type: "audio",
      fileId: "voice-1",
      duration: 12_000,
      author: { name: "Ann", avatar: { color: "#1f9e8f", glyph: "文" } },
    } as any),
    ...overrides,
  } as ExcalidrawAudioElement);

const files: BinaryFiles = {
  "voice-1": {
    id: "voice-1" as FileId,
    mimeType: "audio/webm",
    dataURL: "data:audio/webm;base64,dm9pY2U=" as DataURL,
    created: 1,
  },
};

describe("audio element in the editor (ADR 0034)", () => {
  it("round-trips through restore without losing the element", () => {
    const element = voice();
    const [restored] = restoreElements([element], null);
    expect(restored).toMatchObject({
      type: "audio",
      fileId: "voice-1",
      source: "recording",
      duration: 12_000,
      width: element.width,
      height: element.height,
      author: element.author,
    });
  });

  it("filters out audio with an unknown source", () => {
    const element = { ...voice(), source: "upload" } as any;
    expect(restoreElements([element], null)).toEqual([]);
  });

  it("copies the audio file along with the bubble", () => {
    const json = JSON.parse(
      serializeAsClipboardJSON({ elements: [voice()], files }),
    );
    expect(json.files["voice-1"]).toMatchObject({ mimeType: "audio/webm" });
  });

  it("exports a static bubble to SVG without embedding the audio", async () => {
    const svg = await exportToSvg(
      [voice()],
      { exportBackground: false, viewBackgroundColor: "#ffffff" },
      files,
      { skipInliningFonts: true },
    );
    const texts = [...svg.querySelectorAll("text")].map(
      (node) => node.textContent,
    );
    expect(texts).toEqual(expect.arrayContaining(["文", "12″"]));
    expect(svg.outerHTML).not.toContain("data:audio");
  });

  it("keeps width, height and angle read-only in Stats", () => {
    const element = voice();
    expect(isPropertyEditable(element, "width")).toBe(false);
    expect(isPropertyEditable(element, "height")).toBe(false);
    expect(isPropertyEditable(element, "angle")).toBe(false);
    expect(isPropertyEditable(element, "x")).toBe(true);
  });
});
