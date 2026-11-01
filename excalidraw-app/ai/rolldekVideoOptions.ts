import { toImageReferenceUploads } from "./rolldekVideoRun";
import { getAIVideoModelSpec, getAIVideoSpecModes } from "./videoModelCatalog";

import type { VideoReferenceUploadInput } from "./videoReferenceUploads";
import type {
  AIImageGenerationParams,
  AIImageSource,
  AIVideoProtocol,
  AIVideoResolutionTier,
} from "./types";
import type { AIVideoReferenceLimits } from "./videoModelCatalog";

/**
 * What the workbench offers for a RollDek video card (ADR 0039 §2–3): modes,
 * ratios, resolutions and duration from the catalog, with broad defaults for
 * model IDs the catalog does not know. The adapter validates again on submit.
 */

export type RollDekVideoMode =
  | "text-to-video"
  | "reference-to-video"
  | "first-last-frame";

export type RollDekVideoOptions = {
  modes: RollDekVideoMode[];
  aspectRatios: string[];
  resolutions: AIVideoResolutionTier[];
  duration: { min: number; max: number; default: number };
  /** Absent for uncatalogued models: no client-side reference limits. */
  references?: AIVideoReferenceLimits;
  firstLastFrameExcludesVideo: boolean;
};

const FALLBACK_ASPECT_RATIOS = [
  "21:9",
  "16:9",
  "3:2",
  "4:3",
  "1:1",
  "3:4",
  "2:3",
  "9:16",
];

export const getRollDekVideoOptions = (
  model: string,
  protocol: Exclude<AIVideoProtocol, "openai-videos">,
): RollDekVideoOptions => {
  const spec = getAIVideoModelSpec(model);

  if (spec) {
    return {
      modes: getAIVideoSpecModes(spec).filter(
        (mode): mode is RollDekVideoMode => mode !== "image-to-video",
      ),
      aspectRatios: spec.aspectRatios,
      resolutions: spec.resolutions,
      duration: spec.durationSeconds,
      references: spec.references,
      firstLastFrameExcludesVideo: !!spec.firstLastFrameExcludesVideo,
    };
  }

  return {
    modes: ["text-to-video", "reference-to-video", "first-last-frame"],
    aspectRatios: FALLBACK_ASPECT_RATIOS,
    // sd-* channels are documented as 720p only.
    resolutions: protocol === "volc-tasks" ? ["720p", "1080p"] : ["720p"],
    duration: { min: 4, max: 30, default: 5 },
    firstLastFrameExcludesVideo: protocol === "volc-tasks",
  };
};

/**
 * The user's pick while the model offers it; otherwise reference mode when
 * the tray has images (as image-to-video does for other cards), else text.
 */
export const resolveRollDekVideoMode = (
  selected: RollDekVideoMode | null,
  options: RollDekVideoOptions,
  hasReferences: boolean,
): RollDekVideoMode => {
  if (selected && options.modes.includes(selected)) {
    return selected;
  }

  return hasReferences && options.modes.includes("reference-to-video")
    ? "reference-to-video"
    : "text-to-video";
};

/**
 * Returns `params` itself when nothing needs clamping. Resolution keeps the
 * workbench's upper-case form ("720P"); the adapter lower-cases it.
 */
export const clampRollDekVideoParams = (
  params: AIImageGenerationParams,
  options: RollDekVideoOptions,
): AIImageGenerationParams => {
  const aspectRatio =
    params.aspectRatio && options.aspectRatios.includes(params.aspectRatio)
      ? params.aspectRatio
      : options.aspectRatios.includes("16:9")
      ? "16:9"
      : options.aspectRatios[0];
  const currentResolution = params.resolution?.trim().toLowerCase();
  const resolution = (
    options.resolutions.find((tier) => tier === currentResolution) ||
    options.resolutions[0]
  ).toUpperCase();
  const { min, max } = options.duration;
  const duration =
    typeof params.duration === "number" && Number.isFinite(params.duration)
      ? Math.min(max, Math.max(min, Math.round(params.duration)))
      : options.duration.default;

  if (
    aspectRatio === params.aspectRatio &&
    resolution === params.resolution &&
    duration === params.duration
  ) {
    return params;
  }

  return { ...params, aspectRatio, resolution, duration };
};

/** A video or audio file picked for reference mode. Session-only. */
export type RollDekMediaReference = {
  id: string;
  kind: "video" | "audio";
  file: File;
  durationSeconds?: number;
};

/**
 * Upload order is prompt order: tray images first, then media. `#n` counts
 * across both, so `#3` after two images is the first media item.
 */
export const buildRollDekReferenceUploads = (
  mode: RollDekVideoMode,
  images: readonly AIImageSource[],
  media: readonly RollDekMediaReference[],
): VideoReferenceUploadInput[] => {
  if (mode === "text-to-video") {
    return [];
  }
  if (mode === "first-last-frame") {
    return toImageReferenceUploads(images.slice(0, 2));
  }

  return [
    ...toImageReferenceUploads(images),
    ...media.map((item) => ({
      kind: item.kind,
      blob: item.file,
      mimeType: item.file.type,
      ...(item.durationSeconds != null
        ? { durationSeconds: item.durationSeconds }
        : {}),
    })),
  ];
};

export type RollDekReferenceIssue =
  | { kind: "first-last-needs-two" }
  | { kind: "reference-needs-one" }
  | {
      kind: "too-many";
      limits: AIVideoReferenceLimits;
    };

/** Blocks the generate button; the adapter would reject the request anyway. */
export const getRollDekReferenceIssue = (
  mode: RollDekVideoMode,
  options: RollDekVideoOptions,
  imageCount: number,
  media: readonly RollDekMediaReference[],
): RollDekReferenceIssue | null => {
  if (mode === "text-to-video") {
    return null;
  }
  if (mode === "first-last-frame") {
    return imageCount >= 2 ? null : { kind: "first-last-needs-two" };
  }

  const videos = media.filter((item) => item.kind === "video").length;
  const audios = media.length - videos;

  if (imageCount + media.length === 0) {
    return { kind: "reference-needs-one" };
  }

  const limits = options.references;

  if (
    limits &&
    (imageCount > limits.images ||
      videos > limits.videos ||
      audios > limits.audios ||
      (limits.total != null && imageCount + media.length > limits.total))
  ) {
    return { kind: "too-many", limits };
  }

  return null;
};

/** Total seconds of reference video, for the token estimate. */
export const sumRollDekReferenceVideoSeconds = (
  media: readonly RollDekMediaReference[],
) =>
  media
    .filter((item) => item.kind === "video")
    .reduce((total, item) => total + (item.durationSeconds || 0), 0);

const MEDIA_PROBE_TIMEOUT_MS = 5000;

/** Reads a media file's duration; `undefined` when the browser cannot. */
export const probeMediaDurationSeconds = (
  file: File,
  kind: RollDekMediaReference["kind"],
): Promise<number | undefined> =>
  new Promise((resolve) => {
    if (
      typeof document === "undefined" ||
      typeof URL.createObjectURL !== "function"
    ) {
      resolve(undefined);
      return;
    }

    const element = document.createElement(kind);
    const url = URL.createObjectURL(file);
    let settled = false;

    const finish = (value: number | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeoutId);
      element.onloadedmetadata = null;
      element.onerror = null;
      element.removeAttribute("src");
      URL.revokeObjectURL(url);
      resolve(value);
    };

    const timeoutId = window.setTimeout(
      () => finish(undefined),
      MEDIA_PROBE_TIMEOUT_MS,
    );

    element.preload = "metadata";
    element.onloadedmetadata = () =>
      finish(
        Number.isFinite(element.duration) && element.duration > 0
          ? element.duration
          : undefined,
      );
    element.onerror = () => finish(undefined);
    element.src = url;
  });
