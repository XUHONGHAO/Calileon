import { getVideoDimensions, isLikelyVideoURL } from "./videoCanvas";

// jsdom does not load media, so <video> metadata events never fire on their own.
// Stub document.createElement("video") so onloadedmetadata / onerror can be driven
// deterministically per test.
type VideoStub = {
  preload: string;
  muted: boolean;
  onloadedmetadata: (() => void) | null;
  onerror: (() => void) | null;
  videoWidth: number;
  videoHeight: number;
  removeAttribute: () => void;
  load: () => void;
  src?: string;
};

const stubVideo = (configure: (video: VideoStub) => void) => {
  const realCreateElement = document.createElement.bind(document);

  vi.spyOn(document, "createElement").mockImplementation((tagName: string) => {
    if (tagName === "video") {
      const video: VideoStub = {
        preload: "",
        muted: false,
        onloadedmetadata: null,
        onerror: null,
        videoWidth: 0,
        videoHeight: 0,
        removeAttribute: () => {},
        load: () => {},
        set src(_value: string) {
          queueMicrotask(() => configure(video));
        },
      };

      return video as unknown as HTMLElement;
    }

    return realCreateElement(tagName);
  });
};

describe("isLikelyVideoURL", () => {
  it("accepts http(s) URLs ending in a known video extension", () => {
    expect(isLikelyVideoURL("https://cdn.example.com/out.mp4")).toBe(true);
    expect(isLikelyVideoURL("https://cdn.example.com/clip.webm?sig=abc")).toBe(
      true,
    );
    expect(isLikelyVideoURL("http://cdn.example.com/a/b/c.mov#t=1")).toBe(true);
  });

  it("accepts extension-less signed URLs with a /video/ path hint", () => {
    expect(
      isLikelyVideoURL("https://storage.deepwl.cn/video/abcdef?token=xyz"),
    ).toBe(true);
    expect(isLikelyVideoURL("https://cdn.example.com/videos/123")).toBe(true);
  });

  it("rejects non-video URLs, non-http protocols, and junk", () => {
    expect(isLikelyVideoURL("https://cdn.example.com/image.png")).toBe(false);
    expect(isLikelyVideoURL("https://youtube.com/watch?v=abc")).toBe(false);
    expect(isLikelyVideoURL("data:video/mp4;base64,AAAA")).toBe(false);
    expect(isLikelyVideoURL("not a url")).toBe(false);
    expect(isLikelyVideoURL("")).toBe(false);
    expect(isLikelyVideoURL(null)).toBe(false);
    expect(isLikelyVideoURL(undefined)).toBe(false);
  });
});

describe("getVideoDimensions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves the intrinsic dimensions once metadata loads", async () => {
    stubVideo((video) => {
      video.videoWidth = 1280;
      video.videoHeight = 720;
      video.onloadedmetadata?.();
    });

    const dimensions = await getVideoDimensions(
      "https://cdn.example.com/out.mp4",
    );

    expect(dimensions).toEqual({ width: 1280, height: 720 });
  });

  it("resolves null when the video fails to load", async () => {
    stubVideo((video) => {
      video.onerror?.();
    });

    const dimensions = await getVideoDimensions(
      "https://cdn.example.com/out.mp4",
    );

    expect(dimensions).toBeNull();
  });

  it("resolves null when metadata reports zero dimensions", async () => {
    stubVideo((video) => {
      video.videoWidth = 0;
      video.videoHeight = 0;
      video.onloadedmetadata?.();
    });

    const dimensions = await getVideoDimensions(
      "https://cdn.example.com/out.mp4",
    );

    expect(dimensions).toBeNull();
  });
});
