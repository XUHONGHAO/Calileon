import {
  getAIImageAspectRatioOptions,
  getAIImageResolutionOptions,
  resolveAIImageSize,
} from "./imageDimensions";

describe("AI image dimensions", () => {
  it("resolves Nano Banana sizes from aspect ratio and resolution", () => {
    expect(
      resolveAIImageSize({
        aspectRatio: "21:9",
        mode: "text-to-image",
        nativeModel: "nano-banana",
        resolution: "1k",
      }),
    ).toBe("1536x672");
  });

  it("resolves Nano Banana Pro 4k sizes", () => {
    expect(
      resolveAIImageSize({
        aspectRatio: "16:9",
        mode: "text-to-image",
        nativeModel: "nano-banana-pro",
        resolution: "4k",
      }),
    ).toBe("5504x3072");
  });

  it("resolves Nano Banana 2 512 sizes", () => {
    expect(
      resolveAIImageSize({
        aspectRatio: "1:8",
        mode: "text-to-image",
        nativeModel: "nano-banana-2",
        resolution: "512",
      }),
    ).toBe("192x1536");
  });

  it("defaults text-to-image auto dimensions to 16:9 at 1k", () => {
    expect(
      resolveAIImageSize({
        aspectRatio: "auto",
        mode: "text-to-image",
        nativeModel: "nano-banana-pro",
        resolution: "auto",
      }),
    ).toBe("1376x768");
  });

  it("uses the largest reference image when image-to-image is fully auto", () => {
    expect(
      resolveAIImageSize({
        aspectRatio: "auto",
        mode: "image-to-image",
        nativeModel: "nano-banana-pro",
        resolution: "auto",
        sources: [
          { width: 800, height: 600 },
          { width: 1400, height: 900 },
          { width: 1024, height: 1024 },
        ],
      }),
    ).toBe("1400x900");
  });

  it("exposes restricted generic options for unadapted native models", () => {
    expect(getAIImageAspectRatioOptions("other")).toEqual([
      { value: "auto", label: "AUTO" },
      { value: "16:9", label: "16:9" },
      { value: "4:3", label: "4:3" },
      { value: "3:2", label: "3:2" },
    ]);
    expect(getAIImageResolutionOptions("other", "16:9")).toEqual([
      { value: "auto", label: "AUTO" },
      { value: "1k", label: "1K" },
      { value: "2k", label: "2K" },
      { value: "4k", label: "4K" },
    ]);
  });
});
