import React from "react";

import {
  KEYS,
  VIDEO_RECORDING_MAX_DURATION,
  VIDEO_RECORDING_MIN_DURATION,
  arrayToMap,
} from "@excalidraw/common";
import {
  getTransformHandles,
  getVideoElementLayout,
  newVideoElement,
} from "@excalidraw/element";

import type { ExcalidrawVideoElement, FileId } from "@excalidraw/element/types";

import { Excalidraw, ExtraToolsMenuItem } from "../index";
import { serializeAsClipboardJSON } from "../clipboard";
import { restoreElements } from "../data/restore";
import { getVideoFileIds, stripVideoFiles } from "../data/videoFiles";
import { editorJotaiStore } from "../editor-jotai";
import { exportToSvg } from "../scene/export";
import { videoPlaybackAtom } from "../video/atoms";
import { VideoPlayer } from "../video/player";

import { API } from "./helpers/api";
import { Keyboard, Pointer, UI } from "./helpers/ui";
import { act, fireEvent, render, screen, waitFor } from "./test-utils";

import type { BinaryFiles, DataURL } from "../types";

const { h } = window;
const mouse = new Pointer("mouse");

const POSTER = "data:image/webp;base64,UklGRg==";

const clip = (overrides: Partial<ExcalidrawVideoElement> = {}) =>
  ({
    ...API.createElement({
      type: "video",
      x: 0,
      y: 0,
      width: 480,
      height: 270,
      fileId: "video-1",
      duration: 7_000,
      poster: POSTER,
    } as any),
    ...overrides,
  } as ExcalidrawVideoElement);

const videoFile = (id = "video-1") => ({
  id: id as FileId,
  mimeType: "video/mp4" as const,
  dataURL: "data:video/mp4;base64,AAAAIGZ0eXA=" as DataURL,
  created: 1,
});

const files: BinaryFiles = { "video-1": videoFile() };

describe("video element model (ADR 0035 §2)", () => {
  it("sizes a new clip from the recording, long side 480", () => {
    expect(
      newVideoElement({
        source: "camera",
        duration: 3_000,
        naturalWidth: 1280,
        naturalHeight: 720,
        x: 0,
        y: 0,
      }),
    ).toMatchObject({
      width: 480,
      height: 270,
      angle: 0,
      hasAudio: false,
      poster: null,
      fileId: null,
      backgroundColor: "transparent",
    });
    expect(
      newVideoElement({
        source: "camera",
        duration: 3_000,
        naturalWidth: 720,
        naturalHeight: 1280,
        x: 0,
        y: 0,
      }),
    ).toMatchObject({ width: 270, height: 480 });
  });

  it("round-trips through restore without recomputing geometry", () => {
    const element = clip({ width: 300, height: 400, hasAudio: true });
    const [restored] = restoreElements([element], null);
    expect(restored).toMatchObject({
      type: "video",
      fileId: "video-1",
      source: "camera",
      duration: 7_000,
      hasAudio: true,
      poster: POSTER,
      width: 300,
      height: 400,
    });
  });

  it("drops clips with an unknown source", () => {
    expect(
      restoreElements([{ ...clip(), source: "upload" } as any], null),
    ).toEqual([]);
  });

  it("sanitizes duration, poster and angle", () => {
    const [long, short, bad] = restoreElements(
      [
        clip({ duration: 999_999, angle: 1 as any }),
        clip({ duration: -5 }),
        clip({ poster: "https://tracker.example/pixel.webp" }),
      ],
      null,
    ) as ExcalidrawVideoElement[];
    expect(long.duration).toBe(VIDEO_RECORDING_MAX_DURATION);
    expect(long.angle).toBe(0);
    expect(short.duration).toBe(VIDEO_RECORDING_MIN_DURATION);
    expect(bad.poster).toBeNull();
    expect(
      (
        restoreElements(
          [clip({ poster: `data:image/png;base64,AAAA` })],
          null,
        )[0] as ExcalidrawVideoElement
      ).poster,
    ).toBeNull();
  });

  it("copies the video file along with the element", () => {
    const json = JSON.parse(
      serializeAsClipboardJSON({ elements: [clip()], files }),
    );
    expect(json.files["video-1"]).toMatchObject({ mimeType: "video/mp4" });
  });

  it("lays out the play button, duration pill and mute badge", () => {
    const layout = getVideoElementLayout(clip());
    expect(layout.play.cx).toBe(240);
    expect(layout.play.cy).toBe(135);
    expect(layout.pill).not.toBeNull();
    expect(layout.mute).not.toBeNull();
    expect(getVideoElementLayout(clip({ hasAudio: true })).mute).toBeNull();
    // tiny clips keep only the play button
    expect(
      getVideoElementLayout(clip({ width: 40, height: 30 })).pill,
    ).toBeNull();
  });
});

describe("video files leaving the owner (ADR 0035 §8)", () => {
  it("strips video files but keeps the elements and other files", () => {
    const image = API.createElement({
      type: "image",
      fileId: "image-1" as FileId,
    });
    const all: BinaryFiles = {
      ...files,
      "image-1": {
        id: "image-1" as FileId,
        mimeType: "image/png",
        dataURL: "data:image/png;base64,AAAA" as DataURL,
        created: 1,
      },
    };
    const elements = [clip(), image];
    expect([...getVideoFileIds(elements)]).toEqual(["video-1"]);
    const result = stripVideoFiles(elements, all);
    expect(result.stripped).toBe(true);
    expect(Object.keys(result.files)).toEqual(["image-1"]);
    // nothing to strip: the same object comes back
    expect(stripVideoFiles([image], all)).toEqual({
      files: all,
      stripped: false,
    });
  });

  it("exports the poster to SVG without the recording", async () => {
    const svg = await exportToSvg(
      [clip()],
      { exportBackground: false, viewBackgroundColor: "#ffffff" },
      files,
      { skipInliningFonts: true },
    );
    expect(svg.outerHTML).toContain(POSTER);
    expect(svg.outerHTML).not.toContain("data:video");
    const texts = [...svg.querySelectorAll("text")].map(
      (node) => node.textContent,
    );
    expect(texts).toContain("0:07");
  });

  it("leaves the recording out of an SVG's embedded scene", async () => {
    const svg = await exportToSvg(
      [clip()],
      {
        exportBackground: false,
        viewBackgroundColor: "#ffffff",
        exportEmbedScene: true,
      },
      files,
      { skipInliningFonts: true },
    );
    const { decodeSvgBase64Payload } = await import("../scene/export");
    const payload = decodeSvgBase64Payload({ svg: svg.outerHTML });
    const scene = JSON.parse(payload);
    expect(scene.elements[0]).toMatchObject({ type: "video", poster: POSTER });
    expect(scene.files ?? {}).not.toHaveProperty("video-1");
  });
});

describe("VideoPlayer (ADR 0035 §6)", () => {
  const { createObjectURL, revokeObjectURL } = URL;
  let created = 0;
  const revoked: string[] = [];

  beforeAll(() => {
    URL.createObjectURL = () => `blob:${++created}`;
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
    };
  });

  afterAll(() => {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  });

  it("toggles one clip at a time and keeps at most two URLs", () => {
    const onChange = vi.fn();
    const player = new VideoPlayer({ onChange });
    const a = clip({ id: "a" as any, fileId: "f-a" as FileId });
    const b = clip({ id: "b" as any, fileId: "f-b" as FileId });
    const c = clip({ id: "c" as any, fileId: "f-c" as FileId });

    expect(player.toggle(a, undefined)).toBe(false);
    expect(player.toggle(a, videoFile("f-a"))).toBe(true);
    expect(player.getState()?.elementId).toBe("a");
    expect(player.toggle(a, videoFile("f-a"))).toBe(true);
    expect(player.getState()).toBeNull();

    player.toggle(a, videoFile("f-a"));
    player.toggle(b, videoFile("f-b"));
    const cURL = (player.toggle(c, videoFile("f-c")), player.getState()!.url);
    expect(revoked).toHaveLength(1);
    expect(revoked).not.toContain(cURL);

    player.sync({ ...c, isDeleted: true });
    expect(player.getState()).toBeNull();
    player.destroy();
    expect(revoked).toHaveLength(3);
  });
});

describe("video element in the editor", () => {
  const originalPlay = HTMLMediaElement.prototype.play;
  const originalPause = HTMLMediaElement.prototype.pause;
  const { createObjectURL, revokeObjectURL } = URL;

  beforeAll(() => {
    HTMLMediaElement.prototype.play = async () => {};
    HTMLMediaElement.prototype.pause = () => {};
    URL.createObjectURL = () => "blob:video";
    URL.revokeObjectURL = () => {};
  });

  afterAll(() => {
    HTMLMediaElement.prototype.play = originalPlay;
    HTMLMediaElement.prototype.pause = originalPause;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  });

  beforeEach(() => {
    mouse.reset();
  });

  const renderEditor = async (
    videoOptions: React.ComponentProps<typeof Excalidraw>["videoOptions"] = {
      enabled: true,
    },
  ) => {
    await render(
      <Excalidraw handleKeyboardGlobally={true} videoOptions={videoOptions} />,
    );
  };

  const recording = {
    blob: new Blob(["frames"], { type: "video/mp4" }),
    mimeType: "video/mp4" as const,
    duration: 4_000,
    naturalWidth: 1280,
    naturalHeight: 720,
    hasAudio: false,
    poster: POSTER,
  };

  it("offers corner handles only and no rotation", async () => {
    await renderEditor();
    const element = clip();
    API.setElements([element]);
    const handles = getTransformHandles(
      element,
      h.state.zoom,
      arrayToMap(h.elements),
      "mouse",
    );
    const present = Object.entries(handles)
      .filter(([, handle]) => handle)
      .map(([direction]) => direction)
      .sort();
    expect(present).toEqual(["ne", "nw", "se", "sw"]);
  });

  it("keeps the recording's aspect ratio when resized", async () => {
    await renderEditor();
    const element = clip();
    API.setElements([element]);
    UI.resize(element, "se", [96, 0]);
    expect(h.elements[0].width).toBeCloseTo(576);
    expect(h.elements[0].height).toBeCloseTo(324);
    // shift normally unlocks the ratio; never for a video
    UI.resize(h.elements[0], "se", [0, 100], { shift: true });
    expect(h.elements[0].width / h.elements[0].height).toBeCloseTo(16 / 9);
  });

  it("keeps the ratio and angle in a multi-selection resize", async () => {
    await renderEditor();
    const video = clip();
    const rect = API.createElement({
      type: "rectangle",
      x: 600,
      y: 0,
      width: 100,
      height: 300,
    });
    API.setElements([video, rect]);
    UI.resize([video, rect], "se", [140, 0], { shift: true });
    const [nextVideo] = h.elements;
    expect(nextVideo.width / nextVideo.height).toBeCloseTo(16 / 9);
    expect(nextVideo.angle).toBe(0);
  });

  it("inserts a recording at the viewport centre, selected and undoable", async () => {
    await renderEditor();
    const id = await act(() => h.app.insertVideoRecording(recording));
    const [element] = h.elements as ExcalidrawVideoElement[];
    expect(element).toMatchObject({
      id,
      type: "video",
      width: 480,
      height: 270,
      duration: 4_000,
      poster: POSTER,
      status: "pending",
    });
    expect(h.state.selectedElementIds).toEqual({ [id]: true });
    expect(h.app.files[element.fileId!]).toMatchObject({
      mimeType: "video/mp4",
    });
    Keyboard.undo();
    expect(h.elements[0].isDeleted).toBe(true);
  });

  it("refuses recordings while videoOptions block them", async () => {
    await renderEditor({ enabled: true, disabledReason: "Not in rooms." });
    await expect(h.app.insertVideoRecording(recording)).rejects.toThrow(
      "Not in rooms.",
    );
    expect(h.elements).toEqual([]);
  });

  it("refuses recordings unless the host enables them", async () => {
    await renderEditor({});
    await expect(h.app.insertVideoRecording(recording)).rejects.toThrow();
    expect(h.elements).toEqual([]);
  });

  it("refuses recordings of an unknown type", async () => {
    await renderEditor();
    await expect(
      h.app.insertVideoRecording({
        ...recording,
        mimeType: "video/quicktime" as any,
      }),
    ).rejects.toThrow();
    expect(h.elements).toEqual([]);
  });

  it("drops pasted clips while blocked, keeping the rest", async () => {
    await renderEditor({ enabled: true, disabledReason: "Not in rooms." });
    const rect = API.createElement({ type: "rectangle" });
    act(() => {
      h.app.addElementsFromPasteOrLibrary({
        elements: [clip(), rect],
        files,
        position: "center",
      });
    });
    expect(h.elements.map((element) => element.type)).toEqual(["rectangle"]);
    expect(h.state.toast?.message).toBe("Not in rooms.");
  });

  it("plays from the play button and closes with Enter", async () => {
    await renderEditor();
    const element = clip({ status: "saved" });
    API.setElements([element]);
    h.app.addFiles([videoFile()]);
    mouse.clickAt(element.x + 240, element.y + 135);
    expect(editorJotaiStore.get(videoPlaybackAtom)).toEqual({
      elementId: element.id,
      url: "blob:video",
    });
    await waitFor(() =>
      expect(
        document.querySelector("video.excalidraw-video-playback"),
      ).not.toBeNull(),
    );

    API.setSelectedElements([element]);
    Keyboard.keyPress(KEYS.ENTER);
    expect(editorJotaiStore.get(videoPlaybackAtom)).toBeNull();
  });

  it("explains a clip whose file isn't here", async () => {
    await renderEditor();
    const element = clip({ fileId: "missing" as FileId });
    API.setElements([element]);
    mouse.clickAt(element.x + 240, element.y + 135);
    expect(editorJotaiStore.get(videoPlaybackAtom)).toBeNull();
    expect(h.state.toast?.message).toMatch(/isn't available here/);
  });

  it("stops when the playing clip is deleted", async () => {
    await renderEditor();
    const element = clip();
    API.setElements([element]);
    h.app.addFiles([videoFile()]);
    mouse.clickAt(element.x + 240, element.y + 135);
    expect(editorJotaiStore.get(videoPlaybackAtom)).not.toBeNull();
    act(() => {
      API.setElements([{ ...h.elements[0], isDeleted: true }]);
    });
    expect(editorJotaiStore.get(videoPlaybackAtom)).toBeNull();
  });
});

describe("host items in the More tools menu", () => {
  it("renders an ExtraToolsMenuItem and closes the menu on select", async () => {
    const onSelect = vi.fn();
    await render(
      <Excalidraw>
        <ExtraToolsMenuItem onSelect={onSelect} data-testid="toolbar-camera">
          Camera
        </ExtraToolsMenuItem>
      </Excalidraw>,
    );
    expect(screen.queryByTestId("toolbar-camera")).toBeNull();
    fireEvent.click(
      document.querySelector(".App-toolbar__extra-tools-trigger")!,
    );
    fireEvent.click(await screen.findByTestId("toolbar-camera"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.queryByTestId("toolbar-camera")).toBeNull(),
    );
  });
});
