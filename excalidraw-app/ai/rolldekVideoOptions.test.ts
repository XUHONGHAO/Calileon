import {
  buildRollDekReferenceUploads,
  clampRollDekVideoParams,
  getRollDekReferenceIssue,
  getRollDekVideoOptions,
  resolveRollDekVideoMode,
  sumRollDekReferenceVideoSeconds,
} from "./rolldekVideoOptions";

import type { RollDekMediaReference } from "./rolldekVideoOptions";
import type { AIImageGenerationParams, AIImageSource } from "./types";

const params = (
  patch: Partial<AIImageGenerationParams>,
): AIImageGenerationParams => ({ size: "", n: 1, ...patch });

const image = (name: string): AIImageSource =>
  ({
    elementId: name,
    file: new File(["x"], `${name}.png`, { type: "image/png" }),
    dataURL: "data:image/png;base64,eA==",
  } as AIImageSource);

const media = (
  kind: RollDekMediaReference["kind"],
  durationSeconds?: number,
): RollDekMediaReference => ({
  id: `${kind}-${durationSeconds}`,
  kind,
  file: new File(["x"], `${kind}.bin`, {
    type: kind === "video" ? "video/mp4" : "audio/mpeg",
  }),
  durationSeconds,
});

describe("getRollDekVideoOptions", () => {
  it("follows the catalog", () => {
    const ch3 = getRollDekVideoOptions("sd-2.5-ch3", "rolldek-sd");

    expect(ch3.modes).toEqual([
      "text-to-video",
      "reference-to-video",
      "first-last-frame",
    ]);
    expect(ch3.aspectRatios).not.toContain("3:2");
    expect(ch3.references).toEqual({ images: 9, videos: 0, audios: 0 });

    expect(getRollDekVideoOptions("sd-2.0-ch1", "rolldek-sd").modes).toEqual([
      "text-to-video",
      "reference-to-video",
    ]);
    expect(
      getRollDekVideoOptions("doubao-seedance-2-5-260628", "volc-tasks"),
    ).toMatchObject({
      resolutions: ["720p", "1080p"],
      duration: { min: 4, max: 15 },
      firstLastFrameExcludesVideo: true,
    });
  });

  it("uses broad defaults without limits for unknown models", () => {
    const options = getRollDekVideoOptions("sd-2.5-ch6", "rolldek-sd");

    expect(options.modes).toHaveLength(3);
    expect(options.resolutions).toEqual(["720p"]);
    expect(options.references).toBeUndefined();
  });
});

describe("resolveRollDekVideoMode", () => {
  const options = getRollDekVideoOptions("sd-2.0-ch1", "rolldek-sd");

  it("keeps a supported choice and follows the tray otherwise", () => {
    expect(resolveRollDekVideoMode("text-to-video", options, true)).toBe(
      "text-to-video",
    );
    expect(resolveRollDekVideoMode(null, options, true)).toBe(
      "reference-to-video",
    );
    expect(resolveRollDekVideoMode(null, options, false)).toBe("text-to-video");
    // ch1 has no first/last frame.
    expect(resolveRollDekVideoMode("first-last-frame", options, true)).toBe(
      "reference-to-video",
    );
  });
});

describe("clampRollDekVideoParams", () => {
  const ch5 = getRollDekVideoOptions("sd-2.5-ch5", "rolldek-sd");

  it("clamps ratio, resolution and duration to the model", () => {
    expect(
      clampRollDekVideoParams(
        params({ aspectRatio: "auto", resolution: "1080P", duration: 2 }),
        ch5,
      ),
    ).toMatchObject({ aspectRatio: "16:9", resolution: "720P", duration: 5 });
    expect(
      clampRollDekVideoParams(params({ duration: 99 }), ch5).duration,
    ).toBe(30);
  });

  it("returns the same object when nothing changes", () => {
    const current = params({
      aspectRatio: "9:16",
      resolution: "720P",
      duration: 8,
    });

    expect(clampRollDekVideoParams(current, ch5)).toBe(current);
  });
});

describe("buildRollDekReferenceUploads", () => {
  const images = [image("a"), image("b"), image("c")];
  const items = [media("video", 3), media("audio", 4)];

  it("sends images then media in reference mode, matching #n order", () => {
    expect(
      buildRollDekReferenceUploads("reference-to-video", images, items).map(
        (upload) => upload.kind,
      ),
    ).toEqual(["image", "image", "image", "video", "audio"]);
  });

  it("sends only the first two images as frames", () => {
    const uploads = buildRollDekReferenceUploads(
      "first-last-frame",
      images,
      items,
    );

    expect(uploads.map((upload) => upload.blob)).toEqual([
      images[0].file,
      images[1].file,
    ]);
  });

  it("sends nothing for text-to-video", () => {
    expect(
      buildRollDekReferenceUploads("text-to-video", images, items),
    ).toEqual([]);
  });
});

describe("getRollDekReferenceIssue", () => {
  const ch4 = getRollDekVideoOptions("sd-2.5-ch4", "rolldek-sd");
  const ch3 = getRollDekVideoOptions("sd-2.5-ch3", "rolldek-sd");

  it("needs references for the reference and frame modes", () => {
    expect(getRollDekReferenceIssue("text-to-video", ch4, 0, [])).toBeNull();
    expect(getRollDekReferenceIssue("reference-to-video", ch4, 0, [])).toEqual({
      kind: "reference-needs-one",
    });
    expect(
      getRollDekReferenceIssue("reference-to-video", ch4, 0, [media("audio")]),
    ).toBeNull();
    expect(getRollDekReferenceIssue("first-last-frame", ch4, 1, [])).toEqual({
      kind: "first-last-needs-two",
    });
    expect(getRollDekReferenceIssue("first-last-frame", ch4, 2, [])).toBeNull();
  });

  it("enforces per-kind and total limits", () => {
    expect(
      getRollDekReferenceIssue("reference-to-video", ch3, 1, [media("video")]),
    ).toMatchObject({ kind: "too-many" });
    expect(
      getRollDekReferenceIssue("reference-to-video", ch4, 31, []),
    ).toMatchObject({ kind: "too-many", limits: { total: 50 } });
    // ch4's total equals the sum of its per-kind caps, so test it alone.
    const capped = {
      ...ch4,
      references: { images: 5, videos: 5, audios: 5, total: 3 },
    };
    expect(
      getRollDekReferenceIssue("reference-to-video", capped, 2, [
        media("video"),
        media("audio"),
      ]),
    ).toMatchObject({ kind: "too-many" });
  });
});

describe("sumRollDekReferenceVideoSeconds", () => {
  it("adds known video durations only", () => {
    expect(
      sumRollDekReferenceVideoSeconds([
        media("video", 3.5),
        media("video"),
        media("audio", 10),
      ]),
    ).toBe(3.5);
  });
});
