import {
  getAIImageAspectRatioOptions,
  getAIImageQualityOptions,
  getAIImageResolutionOptions,
  resolveAIImageQuality,
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

  it("exposes the full gpt-image-2 aspect ratios and resolves its sizes", () => {
    expect(getAIImageAspectRatioOptions("gpt-image-2")).toEqual([
      { value: "auto", label: "AUTO" },
      { value: "1:1", label: "1:1" },
      { value: "4:3", label: "4:3" },
      { value: "3:2", label: "3:2" },
      { value: "2:3", label: "2:3" },
      { value: "16:9", label: "16:9" },
      { value: "9:16", label: "9:16" },
    ]);
    expect(
      resolveAIImageSize({
        aspectRatio: "9:16",
        mode: "text-to-image",
        nativeModel: "gpt-image-2",
        resolution: "1k",
      }),
    ).toBe("1080x1920");
  });

  it("exposes the full gpt-image-2.5 aspect ratios and resolves its sizes", () => {
    expect(getAIImageAspectRatioOptions("gpt-image-2.5")).toEqual([
      { value: "auto", label: "AUTO" },
      { value: "3:1", label: "3:1" },
      { value: "21:9", label: "21:9" },
      { value: "16:9", label: "16:9" },
      { value: "3:2", label: "3:2" },
      { value: "4:3", label: "4:3" },
      { value: "1:1", label: "1:1" },
      { value: "3:4", label: "3:4" },
      { value: "2:3", label: "2:3" },
      { value: "9:16", label: "9:16" },
      { value: "1:3", label: "1:3" },
    ]);
    expect(getAIImageResolutionOptions("gpt-image-2.5", "21:9")).toEqual([
      { value: "auto", label: "AUTO" },
      { value: "1k", label: "1K" },
      { value: "2k", label: "2K" },
      { value: "4k", label: "4K" },
    ]);
    expect(
      resolveAIImageSize({
        aspectRatio: "3:1",
        mode: "text-to-image",
        nativeModel: "gpt-image-2.5",
        resolution: "1k",
      }),
    ).toBe("1536x512");
    expect(
      resolveAIImageSize({
        aspectRatio: "21:9",
        mode: "text-to-image",
        nativeModel: "gpt-image-2.5",
        resolution: "4k",
      }),
    ).toBe("3840x1648");
    expect(
      resolveAIImageSize({
        aspectRatio: "1:3",
        mode: "text-to-image",
        nativeModel: "gpt-image-2.5",
        resolution: "2k",
      }),
    ).toBe("1024x3072");
    expect(
      resolveAIImageSize({
        aspectRatio: "3:2",
        mode: "text-to-image",
        nativeModel: "gpt-image-2.5",
        resolution: "4k",
      }),
    ).toBe("3520x2352");
  });

  it("exposes the extended gpt-image-2.5 quality ladder defaulting to auto", () => {
    expect(getAIImageQualityOptions("gpt-image-2.5")).toEqual([
      { value: "auto", label: "AUTO" },
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "XHigh" },
      { value: "max", label: "Max" },
    ]);
  });

  it("keeps the generic quality ladder for other native models", () => {
    expect(getAIImageQualityOptions("gpt-image-2").map((o) => o.value)).toEqual(
      ["auto", "standard", "hd", "low", "medium", "high"],
    );
    expect(getAIImageQualityOptions("other").map((o) => o.value)).toEqual([
      "auto",
      "standard",
      "hd",
      "low",
      "medium",
      "high",
    ]);
    expect(getAIImageQualityOptions(undefined).map((o) => o.value)).toEqual([
      "auto",
      "standard",
      "hd",
      "low",
      "medium",
      "high",
    ]);
  });

  it("resolves quality against the model ladder, defaulting to auto", () => {
    expect(resolveAIImageQuality("gpt-image-2.5", undefined)).toBe("auto");
    expect(resolveAIImageQuality("gpt-image-2.5", "max")).toBe("max");
    expect(resolveAIImageQuality("gpt-image-2.5", "xhigh")).toBe("xhigh");
    // `hd`/`standard` belong to the generic ladder only.
    expect(resolveAIImageQuality("gpt-image-2.5", "hd")).toBe("auto");
    expect(resolveAIImageQuality("other", "hd")).toBe("hd");
    expect(resolveAIImageQuality("other", "max")).toBe("auto");
  });
});
