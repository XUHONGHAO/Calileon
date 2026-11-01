import type {
  AIModelTokenPrices,
  AIVideoGenerationMode,
  AIVideoProtocol,
  AIVideoResolutionTier,
} from "./types";

/**
 * Per-model limits for the RollDek Seedance video models (ADR 0039 §2).
 * Sources: `C:\AI\RollDek\*.md` and `https://rolldek.com/docs/*.md`
 * (2026-10-28), plus the Volcengine price list for `listPrices`.
 *
 * The workbench clamps its inputs to these limits and the adapters validate
 * again before submitting, since every accepted submit may be billed. Model
 * IDs missing here (for example `sd-2.5-ch6`, which has no doc yet) still
 * work, just without limits.
 */

/**
 * Request field names. Most sd-* channels use `duration` + `image_refs`;
 * `SD2.0满血稳定933` documents `seconds` + `images` as its preferred names.
 */
export type AIVideoWireVariant = "sd-refs" | "sd-933" | "volc";

export type AIVideoReferenceLimits = {
  images: number;
  videos: number;
  audios: number;
  /** Cap on all references together, when the doc states one. */
  total?: number;
};

export type AIVideoModelSpec = {
  model: string;
  protocol: Exclude<AIVideoProtocol, "openai-videos">;
  wire: AIVideoWireVariant;
  label: string;
  durationSeconds: { min: number; max: number; default: number };
  resolutions: AIVideoResolutionTier[];
  aspectRatios: string[];
  references: AIVideoReferenceLimits;
  /** Whether first/last-frame mode is supported (always as a pair). */
  firstLastFrame: boolean;
  /** Volcengine: first/last frame cannot be combined with a reference video. */
  firstLastFrameExcludesVideo?: boolean;
  seed: boolean;
  maxPromptLength?: number;
  billing: "per-request" | "per-token";
  /** Official per-million-token list prices (CNY = RollDek "$", 1:1). */
  listPrices?: AIModelTokenPrices;
};

const SD_ASPECT_RATIOS = [
  "21:9",
  "16:9",
  "3:2",
  "4:3",
  "1:1",
  "3:4",
  "2:3",
  "9:16",
];

const VOLC_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "21:9", "4:3", "3:4"];

// Not in the RollDek doc; mirrors the Seedance 2.0 input caps and is listed
// under "待实测" in ADR 0039.
const VOLC_REFERENCES: AIVideoReferenceLimits = {
  images: 9,
  videos: 3,
  audios: 3,
};

// The doc gives no duration range for the Volcengine format; 4–15 s is the
// conservative range ADR 0039 adopts until it is measured.
const VOLC_DURATION = { min: 4, max: 15, default: 5 };

const sdSpec = (
  spec: Omit<AIVideoModelSpec, "protocol" | "resolutions" | "billing">,
): AIVideoModelSpec => ({
  protocol: "rolldek-sd",
  resolutions: ["720p"],
  billing: "per-request",
  ...spec,
});

const volcSpec = (
  spec: Pick<AIVideoModelSpec, "model" | "label" | "listPrices"> &
    Partial<AIVideoModelSpec>,
): AIVideoModelSpec => ({
  protocol: "volc-tasks",
  wire: "volc",
  durationSeconds: VOLC_DURATION,
  resolutions: ["720p"],
  aspectRatios: VOLC_ASPECT_RATIOS,
  references: VOLC_REFERENCES,
  firstLastFrame: true,
  firstLastFrameExcludesVideo: true,
  seed: true,
  billing: "per-token",
  ...spec,
});

export const AI_VIDEO_MODEL_CATALOG: readonly AIVideoModelSpec[] = [
  sdSpec({
    model: "sd-2.0-ch1",
    wire: "sd-refs",
    label: "Seedance 2.0 · CH1",
    durationSeconds: { min: 4, max: 15, default: 5 },
    aspectRatios: SD_ASPECT_RATIOS,
    references: { images: 9, videos: 3, audios: 3 },
    firstLastFrame: false,
    seed: false,
  }),
  sdSpec({
    model: "SD2.0满血稳定933",
    wire: "sd-933",
    label: "Seedance 2.0 · 933",
    durationSeconds: { min: 4, max: 15, default: 5 },
    aspectRatios: SD_ASPECT_RATIOS,
    references: { images: 9, videos: 3, audios: 3 },
    firstLastFrame: true,
    seed: true,
  }),
  sdSpec({
    model: "sd-2.5-ch1",
    wire: "sd-refs",
    label: "Seedance 2.5 · CH1",
    durationSeconds: { min: 4, max: 30, default: 5 },
    aspectRatios: SD_ASPECT_RATIOS,
    references: { images: 30, videos: 10, audios: 10 },
    firstLastFrame: true,
    seed: false,
  }),
  sdSpec({
    model: "sd-2.5-ch2",
    wire: "sd-refs",
    label: "Seedance 2.5 · CH2",
    durationSeconds: { min: 4, max: 30, default: 5 },
    aspectRatios: SD_ASPECT_RATIOS,
    references: { images: 10, videos: 10, audios: 10 },
    firstLastFrame: true,
    seed: false,
  }),
  sdSpec({
    model: "sd-2.5-ch3",
    wire: "sd-refs",
    label: "Seedance 2.5 · CH3",
    durationSeconds: { min: 4, max: 30, default: 5 },
    aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    references: { images: 9, videos: 0, audios: 0 },
    firstLastFrame: true,
    seed: false,
  }),
  sdSpec({
    model: "sd-2.5-ch4",
    wire: "sd-refs",
    label: "Seedance 2.5 · CH4",
    durationSeconds: { min: 4, max: 30, default: 5 },
    aspectRatios: SD_ASPECT_RATIOS,
    references: { images: 30, videos: 10, audios: 10, total: 50 },
    firstLastFrame: true,
    seed: true,
    maxPromptLength: 4999,
  }),
  sdSpec({
    // Defaults to 30 s server-side, so the adapter always sends a duration.
    model: "sd-2.5-ch5",
    wire: "sd-refs",
    label: "Seedance 2.5 · CH5",
    durationSeconds: { min: 5, max: 30, default: 5 },
    aspectRatios: SD_ASPECT_RATIOS,
    references: { images: 30, videos: 10, audios: 10, total: 50 },
    firstLastFrame: true,
    seed: true,
    maxPromptLength: 4999,
  }),
  volcSpec({
    model: "doubao-seedance-2-0-260128",
    label: "Seedance 2.0",
    resolutions: ["720p", "1080p"],
    listPrices: {
      "720p": { base: 46, withVideo: 28 },
      "1080p": { base: 51, withVideo: 31 },
    },
  }),
  volcSpec({
    // RollDek says 1080p; the official price list says fast is 720p only.
    model: "doubao-seedance-2-0-fast-260128",
    label: "Seedance 2.0 Fast",
    listPrices: { "720p": { base: 37, withVideo: 22 } },
  }),
  volcSpec({
    model: "doubao-seedance-2-0-mini-260615",
    label: "Seedance 2.0 Mini",
    listPrices: { "720p": { base: 23, withVideo: 14 } },
  }),
  volcSpec({
    model: "doubao-seedance-2-5-260628",
    label: "Seedance 2.5",
    resolutions: ["720p", "1080p"],
    listPrices: {
      "720p": { base: 70, withVideo: 42 },
      "1080p": { base: 77, withVideo: 46 },
    },
  }),
];

const AI_VIDEO_GENERATION_MODES: readonly AIVideoGenerationMode[] = [
  "text-to-video",
  "image-to-video",
  "reference-to-video",
  "first-last-frame",
];

/** Guard for persisted task and canvas metadata. */
export const isAIVideoGenerationMode = (
  value: unknown,
): value is AIVideoGenerationMode =>
  AI_VIDEO_GENERATION_MODES.includes(value as AIVideoGenerationMode);

export const getAIVideoModelSpec = (
  model: string | undefined,
): AIVideoModelSpec | undefined => {
  const name = model?.trim();

  return name
    ? AI_VIDEO_MODEL_CATALOG.find((spec) => spec.model === name)
    : undefined;
};

export const getAIVideoCatalogModels = (
  protocol: AIVideoModelSpec["protocol"],
): string[] =>
  AI_VIDEO_MODEL_CATALOG.filter((spec) => spec.protocol === protocol).map(
    (spec) => spec.model,
  );

/** Generation modes a catalog model supports, in workbench display order. */
export const getAIVideoSpecModes = (
  spec: AIVideoModelSpec,
): AIVideoGenerationMode[] => {
  const { images, videos, audios } = spec.references;

  return [
    "text-to-video",
    ...(images + videos + audios > 0 ? ["reference-to-video" as const] : []),
    ...(spec.firstLastFrame ? ["first-last-frame" as const] : []),
  ];
};
