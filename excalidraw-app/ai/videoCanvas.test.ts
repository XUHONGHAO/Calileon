import { embeddableURLValidator } from "@excalidraw/element/embeddable";

import type {
  ExcalidrawEmbeddableElement,
  NonDeleted,
} from "@excalidraw/element/types";

import {
  buildAIVideoAssetLink,
  getAIVideoAssetIdFromEmbeddable,
  getAIVideoURLFromEmbeddable,
  getVideoDimensions,
  isValidAIVideoEmbeddable,
  isSafeAIVideoURL,
} from "./videoCanvas";

import type { AIVideoGenerationMetadata } from "./types";

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

describe("AI video embeddable validation", () => {
  const opaqueSignedURL =
    "https://cdn.example.com/abc123?X-Amz-Signature=keep-me&token=full";
  const metadata: AIVideoGenerationMetadata = {
    version: 1,
    kind: "video",
    mode: "text-to-video",
    model: "test-video-model",
    prompt: "A paper plane taking flight",
    params: { size: "", n: 1 },
    videoURL: opaqueSignedURL,
    mimeType: "video/mp4",
    createdAt: "2026-07-11T00:00:00.000Z",
  };
  const aiVideoElement = {
    type: "embeddable" as const,
    link: opaqueSignedURL,
    customData: { aiVideoGeneration: metadata },
  };

  it("accepts safe opaque signed http(s) URLs without changing their query", () => {
    expect(isSafeAIVideoURL(opaqueSignedURL)).toBe(true);
    expect(getAIVideoURLFromEmbeddable(aiVideoElement)).toBe(opaqueSignedURL);
  });

  it("accepts v2 stable asset links without persisting a playback URL", () => {
    const assetId = "asset-stable-1";
    const element = {
      type: "embeddable" as const,
      link: buildAIVideoAssetLink(assetId),
      customData: {
        aiVideoGeneration: {
          version: 2,
          kind: "video",
          mode: "text-to-video",
          model: "test-video-model",
          prompt: "A paper plane taking flight",
          params: { size: "", n: 1 },
          assetId,
          mimeType: "video/mp4",
          createdAt: "2026-07-12T00:00:00.000Z",
        },
      },
    };

    expect(getAIVideoAssetIdFromEmbeddable(element)).toBe(assetId);
    expect(getAIVideoURLFromEmbeddable(element)).toBeNull();
    expect(isValidAIVideoEmbeddable(element)).toBe(true);
    expect(JSON.stringify(element)).not.toContain("https://");
    expect(
      getAIVideoAssetIdFromEmbeddable({
        ...element,
        link: buildAIVideoAssetLink("different-asset"),
      }),
    ).toBeNull();
  });

  it("requires matching valid metadata instead of trusting a video-like path", () => {
    const ordinaryVideoPage = "https://example.com/video/page";

    expect(isSafeAIVideoURL(ordinaryVideoPage)).toBe(true);
    expect(
      getAIVideoURLFromEmbeddable({
        ...aiVideoElement,
        link: "https://cdn.example.com/a-different-link",
      }),
    ).toBeNull();
  });

  it("rejects invalid metadata and unsafe URL protocols", () => {
    expect(isSafeAIVideoURL("data:video/mp4;base64,AAAA")).toBe(false);
    expect(isSafeAIVideoURL("ftp://cdn.example.com/out.mp4")).toBe(false);
    expect(isSafeAIVideoURL("not a url")).toBe(false);
    expect(
      getAIVideoURLFromEmbeddable({
        type: "embeddable",
        link: "https://cdn.example.com/out",
        customData: {
          aiVideoGeneration: {
            ...metadata,
            videoURL: "data:video/mp4;base64,AAAA",
          },
        },
      }),
    ).toBeNull();
    expect(
      getAIVideoURLFromEmbeddable({
        ...aiVideoElement,
        customData: {
          aiVideoGeneration: { ...metadata, params: [] },
        },
      }),
    ).toBeNull();
    expect(
      getAIVideoURLFromEmbeddable({
        ...aiVideoElement,
        customData: {
          aiVideoGeneration: {
            ...metadata,
            params: { size: "", n: 1 },
            mimeType: "text/html",
          },
        },
      }),
    ).toBeNull();
  });

  it("falls back to the core whitelist for Bilibili and ordinary pasted pages", () => {
    const appValidator = (
      link: string,
      element?: NonDeleted<ExcalidrawEmbeddableElement>,
    ) =>
      element && getAIVideoURLFromEmbeddable(element) === link
        ? true
        : undefined;

    expect(
      embeddableURLValidator(opaqueSignedURL, appValidator, aiVideoElement),
    ).toBe(true);
    expect(embeddableURLValidator(opaqueSignedURL, appValidator)).toBe(false);
    expect(
      embeddableURLValidator(opaqueSignedURL, appValidator, {
        ...aiVideoElement,
        customData: undefined,
      }),
    ).toBe(false);

    expect(
      embeddableURLValidator(
        "https://player.bilibili.com/player.html?bvid=BV1xx",
        appValidator,
      ),
    ).toBe(true);
    expect(
      embeddableURLValidator(
        "https://player.bilibili.com/not-a-player",
        appValidator,
      ),
    ).toBe(false);
    expect(
      embeddableURLValidator(
        "https://www.bilibili.com/video/BV1xx",
        appValidator,
      ),
    ).toBe(false);
    expect(
      embeddableURLValidator("https://example.com/video/page", appValidator),
    ).toBe(false);
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
