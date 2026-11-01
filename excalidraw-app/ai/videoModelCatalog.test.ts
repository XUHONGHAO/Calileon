import {
  AI_VIDEO_MODEL_CATALOG,
  getAIVideoCatalogModels,
  getAIVideoModelSpec,
  getAIVideoSpecModes,
  isAIVideoGenerationMode,
} from "./videoModelCatalog";

describe("AI video model catalog", () => {
  it("has unique model IDs and sane limits", () => {
    const ids = AI_VIDEO_MODEL_CATALOG.map((spec) => spec.model);

    expect(new Set(ids).size).toBe(ids.length);

    for (const spec of AI_VIDEO_MODEL_CATALOG) {
      const { min, max, default: fallback } = spec.durationSeconds;

      expect(min).toBeGreaterThan(0);
      expect(min).toBeLessThanOrEqual(fallback);
      expect(fallback).toBeLessThanOrEqual(max);
      expect(spec.resolutions.length).toBeGreaterThan(0);
      expect(spec.aspectRatios).toContain("16:9");
      expect(spec.billing === "per-token").toBe(!!spec.listPrices);
    }
  });

  it("encodes the documented per-channel differences", () => {
    expect(getAIVideoModelSpec("SD2.0满血稳定933")).toMatchObject({
      protocol: "rolldek-sd",
      wire: "sd-933",
      firstLastFrame: true,
    });
    // ch1 documents no first/last frame fields.
    expect(getAIVideoModelSpec("sd-2.0-ch1")?.firstLastFrame).toBe(false);
    // ch3 takes image references only, and six aspect ratios.
    expect(getAIVideoModelSpec("sd-2.5-ch3")).toMatchObject({
      references: { images: 9, videos: 0, audios: 0 },
    });
    expect(getAIVideoModelSpec("sd-2.5-ch3")?.aspectRatios).not.toContain(
      "3:2",
    );
    // ch5 starts at 5 s and defaults to 30 s server-side.
    expect(getAIVideoModelSpec("sd-2.5-ch5")?.durationSeconds.min).toBe(5);
    expect(
      getAIVideoModelSpec("doubao-seedance-2-5-260628")?.resolutions,
    ).toEqual(["720p", "1080p"]);
    expect(
      getAIVideoModelSpec("doubao-seedance-2-0-fast-260128")?.resolutions,
    ).toEqual(["720p"]);
  });

  it("leaves undocumented models out", () => {
    expect(getAIVideoModelSpec("sd-2.5-ch6")).toBeUndefined();
    expect(getAIVideoModelSpec("")).toBeUndefined();
    expect(getAIVideoModelSpec(" sd-2.5-ch5 ")?.model).toBe("sd-2.5-ch5");
  });

  it("lists models per protocol and modes per model", () => {
    expect(getAIVideoCatalogModels("rolldek-sd")).toHaveLength(7);
    expect(getAIVideoCatalogModels("volc-tasks")).toHaveLength(4);
    expect(getAIVideoSpecModes(getAIVideoModelSpec("sd-2.0-ch1")!)).toEqual([
      "text-to-video",
      "reference-to-video",
    ]);
    expect(
      getAIVideoSpecModes(getAIVideoModelSpec("doubao-seedance-2-5-260628")!),
    ).toEqual(["text-to-video", "reference-to-video", "first-last-frame"]);
  });

  it("recognizes old and new generation modes", () => {
    expect(isAIVideoGenerationMode("image-to-video")).toBe(true);
    expect(isAIVideoGenerationMode("first-last-frame")).toBe(true);
    expect(isAIVideoGenerationMode("text-to-image")).toBe(false);
  });
});
