import type { DataURL } from "@excalidraw/excalidraw/types";

import { createPlaceholderCover, resolveVideoCover } from "./videoCanvas";

// jsdom does not decode images or play <video>, so onload/onseeked/onerror never
// fire on their own and the cover helpers would hang. Stub just enough of both so
// the thumbnail path resolves and the first-frame path rejects (-> placeholder).
const stubImageOnload = () => {
  class StubImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 1280;
    naturalHeight = 720;
    width = 1280;
    height = 720;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }

  vi.stubGlobal("Image", StubImage as unknown as typeof Image);
};

const stubVideoCaptureFailure = () => {
  const realCreateElement = document.createElement.bind(document);

  vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
    if (tagName === "video") {
      const video = {
        muted: false,
        crossOrigin: "",
        preload: "",
        onloadeddata: null as (() => void) | null,
        onseeked: null as (() => void) | null,
        onerror: null as (() => void) | null,
        currentTime: 0,
        removeAttribute: () => {},
        load: () => {},
        set src(_value: string) {
          queueMicrotask(() => this.onerror?.());
        },
      };

      return video as unknown as HTMLElement;
    }

    return realCreateElement(tagName);
  });
};

describe("video cover resolution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses a provided thumbnail data URL as the cover", async () => {
    stubImageOnload();

    const thumbnailDataURL =
      "data:image/png;base64,iVBORw0KGgoAAAANS" as DataURL;
    const cover = await resolveVideoCover({
      thumbnailDataURL,
      videoURL: "https://cdn.example.com/out.mp4",
    });

    expect(cover.dataURL).toBe(thumbnailDataURL);
    expect(cover.mimeType).toBe("image/png");
    expect(cover.storageType).toBe("data-url");
  });

  it("falls back to a placeholder cover when no thumbnail and capture fails", async () => {
    stubVideoCaptureFailure();

    const cover = await resolveVideoCover({
      videoURL: "https://cdn.example.com/out.mp4",
    });

    expect(cover.storageType).toBe("placeholder");
    expect(cover.dataURL.startsWith("data:image/")).toBe(true);
    expect(cover.width).toBeGreaterThan(0);
    expect(cover.height).toBeGreaterThan(0);
  });

  it("creates a placeholder cover with positive dimensions", () => {
    const cover = createPlaceholderCover();

    expect(cover.storageType).toBe("placeholder");
    expect(cover.dataURL.startsWith("data:image/")).toBe(true);
    expect(cover.width).toBeGreaterThan(0);
    expect(cover.height).toBeGreaterThan(0);
  });
});
