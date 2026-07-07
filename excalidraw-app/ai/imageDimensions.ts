import type { AIImageGenerationMode, AIImageNativeModel } from "./types";

export type AIImageAspectRatio = "auto" | string;
export type AIImageResolution = "auto" | string;

export type AIImageDimensionSource = {
  width?: number;
  height?: number;
};

export type AIImageSizeResolution = {
  value: AIImageResolution;
  label: string;
};

export type AIImageAspectRatioOption = {
  value: AIImageAspectRatio;
  label: string;
};

type NativeModelSizeMap = Record<string, Record<string, string>>;

export const DEFAULT_AI_IMAGE_NATIVE_MODEL: AIImageNativeModel = "other";
export const DEFAULT_TEXT_TO_IMAGE_ASPECT_RATIO = "16:9";
export const DEFAULT_TEXT_TO_IMAGE_RESOLUTION = "1k";

export const AI_IMAGE_NATIVE_MODEL_OPTIONS: Array<{
  value: AIImageNativeModel;
  label: string;
}> = [
  { value: "nano-banana", label: "Nano Banana" },
  { value: "nano-banana-pro", label: "Nano Banana Pro" },
  { value: "nano-banana-2", label: "Nano Banana 2" },
  { value: "gpt-image-2", label: "gpt-image-2" },
  { value: "other", label: "Other" },
];

const NANO_BANANA_SIZES: NativeModelSizeMap = {
  "1:1": { "1k": "1024x1024" },
  "2:3": { "1k": "832x1248" },
  "3:2": { "1k": "1248x832" },
  "3:4": { "1k": "864x1184" },
  "4:3": { "1k": "1184x864" },
  "4:5": { "1k": "896x1152" },
  "5:4": { "1k": "1152x896" },
  "9:16": { "1k": "768x1344" },
  "16:9": { "1k": "1344x768" },
  "21:9": { "1k": "1536x672" },
};

const NANO_BANANA_PRO_SIZES: NativeModelSizeMap = {
  "1:1": { "1k": "1024x1024", "2k": "2048x2048", "4k": "4096x4096" },
  "2:3": { "1k": "848x1264", "2k": "1696x2528", "4k": "3392x5056" },
  "3:2": { "1k": "1264x848", "2k": "2528x1696", "4k": "5056x3392" },
  "3:4": { "1k": "896x1200", "2k": "1792x2400", "4k": "3584x4800" },
  "4:3": { "1k": "1200x896", "2k": "2400x1792", "4k": "4800x3584" },
  "4:5": { "1k": "928x1152", "2k": "1856x2304", "4k": "3712x4608" },
  "5:4": { "1k": "1152x928", "2k": "2304x1856", "4k": "4608x3712" },
  "9:16": { "1k": "768x1376", "2k": "1536x2752", "4k": "3072x5504" },
  "16:9": { "1k": "1376x768", "2k": "2752x1536", "4k": "5504x3072" },
  "21:9": { "1k": "1584x672", "2k": "3168x1344", "4k": "6336x2688" },
};

const NANO_BANANA_2_SIZES: NativeModelSizeMap = {
  "1:1": {
    "512": "512x512",
    "1k": "1024x1024",
    "2k": "2048x2048",
    "4k": "4096x4096",
  },
  "1:4": {
    "512": "256x1024",
    "1k": "512x2048",
    "2k": "1024x4096",
    "4k": "2048x8192",
  },
  "1:8": {
    "512": "192x1536",
    "1k": "384x3072",
    "2k": "768x6144",
    "4k": "1536x12288",
  },
  "2:3": {
    "512": "424x632",
    "1k": "848x1264",
    "2k": "1696x2528",
    "4k": "3392x5056",
  },
  "3:2": {
    "512": "632x424",
    "1k": "1264x848",
    "2k": "2528x1696",
    "4k": "5056x3392",
  },
  "3:4": {
    "512": "448x600",
    "1k": "896x1200",
    "2k": "1792x2400",
    "4k": "3584x4800",
  },
  "4:1": {
    "512": "1024x256",
    "1k": "2048x512",
    "2k": "4096x1024",
    "4k": "8192x2048",
  },
  "4:3": {
    "512": "600x448",
    "1k": "1200x896",
    "2k": "2400x1792",
    "4k": "4800x3584",
  },
  "4:5": {
    "512": "464x576",
    "1k": "928x1152",
    "2k": "1856x2304",
    "4k": "3712x4608",
  },
  "5:4": {
    "512": "576x464",
    "1k": "1152x928",
    "2k": "2304x1856",
    "4k": "4608x3712",
  },
  "8:1": {
    "512": "1536x192",
    "1k": "3072x384",
    "2k": "6144x768",
    "4k": "12288x1536",
  },
  "9:16": {
    "512": "384x688",
    "1k": "768x1376",
    "2k": "1536x2752",
    "4k": "3072x5504",
  },
  "16:9": {
    "512": "688x384",
    "1k": "1376x768",
    "2k": "2752x1536",
    "4k": "5504x3072",
  },
  "21:9": {
    "512": "792x168",
    "1k": "1584x672",
    "2k": "3168x1344",
    "4k": "6336x2688",
  },
};

const OTHER_MODEL_SIZES: NativeModelSizeMap = {
  "16:9": { "1k": "1280x720", "2k": "2560x1440", "4k": "3840x2160" },
  "4:3": { "1k": "1280x960", "2k": "2560x1920", "4k": "3840x2880" },
  "3:2": { "1k": "1536x1024", "2k": "3072x2048", "4k": "3840x2560" },
};

// duoyuanx.com gpt-image-2 基础比例与尺寸档位（单档，网关按比例意图回退到最接近的官方尺寸）
const GPT_IMAGE_2_SIZES: NativeModelSizeMap = {
  "1:1": { "1k": "1024x1024" },
  "4:3": { "1k": "1536x1152" },
  "3:2": { "1k": "1536x1024" },
  "2:3": { "1k": "1024x1536" },
  "16:9": { "1k": "1920x1080" },
  "9:16": { "1k": "1080x1920" },
};

const NATIVE_MODEL_SIZE_MAPS: Record<AIImageNativeModel, NativeModelSizeMap> = {
  "nano-banana": NANO_BANANA_SIZES,
  "nano-banana-pro": NANO_BANANA_PRO_SIZES,
  "nano-banana-2": NANO_BANANA_2_SIZES,
  "gpt-image-2": GPT_IMAGE_2_SIZES,
  other: OTHER_MODEL_SIZES,
};

export const isAIImageNativeModel = (
  value: string,
): value is AIImageNativeModel => {
  return AI_IMAGE_NATIVE_MODEL_OPTIONS.some((option) => option.value === value);
};

export const normalizeAIImageNativeModel = (
  value: unknown,
): AIImageNativeModel => {
  return typeof value === "string" && isAIImageNativeModel(value)
    ? value
    : DEFAULT_AI_IMAGE_NATIVE_MODEL;
};

export const getAIImageAspectRatioOptions = (
  nativeModel: AIImageNativeModel | undefined,
): AIImageAspectRatioOption[] => {
  return [
    { value: "auto", label: "AUTO" },
    ...Object.keys(getNativeModelSizeMap(nativeModel)).map((aspectRatio) => ({
      value: aspectRatio,
      label: aspectRatio,
    })),
  ];
};

export const getAIImageResolutionOptions = (
  nativeModel: AIImageNativeModel | undefined,
  aspectRatio: AIImageAspectRatio | undefined,
): AIImageSizeResolution[] => {
  const sizeMap = getNativeModelSizeMap(nativeModel);
  const effectiveAspectRatio =
    aspectRatio && aspectRatio !== "auto"
      ? aspectRatio
      : DEFAULT_TEXT_TO_IMAGE_ASPECT_RATIO;
  const resolutions =
    sizeMap[effectiveAspectRatio] ||
    sizeMap[DEFAULT_TEXT_TO_IMAGE_ASPECT_RATIO];

  return [
    { value: "auto", label: "AUTO" },
    ...Object.keys(resolutions || {}).map((resolution) => ({
      value: resolution,
      label: getAIImageResolutionLabel(resolution),
    })),
  ];
};

export const resolveAIImageSize = ({
  aspectRatio,
  mode,
  nativeModel,
  resolution,
  sources,
}: {
  aspectRatio?: AIImageAspectRatio;
  mode: AIImageGenerationMode;
  nativeModel?: AIImageNativeModel;
  resolution?: AIImageResolution;
  sources?: AIImageDimensionSource[];
}) => {
  const normalizedAspectRatio = aspectRatio || "auto";
  const normalizedResolution = resolution || "auto";

  if (
    mode !== "text-to-image" &&
    normalizedAspectRatio === "auto" &&
    normalizedResolution === "auto"
  ) {
    const largestSourceSize = getLargestSourceSize(sources);

    if (largestSourceSize) {
      return largestSourceSize;
    }
  }

  const sizeMap = getNativeModelSizeMap(nativeModel);
  const effectiveAspectRatio =
    normalizedAspectRatio === "auto"
      ? DEFAULT_TEXT_TO_IMAGE_ASPECT_RATIO
      : normalizedAspectRatio;
  const resolutions =
    sizeMap[effectiveAspectRatio] ||
    sizeMap[DEFAULT_TEXT_TO_IMAGE_ASPECT_RATIO];
  const effectiveResolution =
    normalizedResolution === "auto"
      ? DEFAULT_TEXT_TO_IMAGE_RESOLUTION
      : normalizedResolution;

  return (
    resolutions?.[effectiveResolution] ||
    resolutions?.[DEFAULT_TEXT_TO_IMAGE_RESOLUTION] ||
    Object.values(resolutions || {})[0] ||
    OTHER_MODEL_SIZES[DEFAULT_TEXT_TO_IMAGE_ASPECT_RATIO][
      DEFAULT_TEXT_TO_IMAGE_RESOLUTION
    ]
  );
};

const getNativeModelSizeMap = (nativeModel: AIImageNativeModel | undefined) => {
  return NATIVE_MODEL_SIZE_MAPS[nativeModel || DEFAULT_AI_IMAGE_NATIVE_MODEL];
};

const getLargestSourceSize = (
  sources: AIImageDimensionSource[] | undefined,
) => {
  const largestSource = sources?.reduce<AIImageDimensionSource | null>(
    (largest, source) => {
      const width = normalizeDimension(source.width);
      const height = normalizeDimension(source.height);

      if (!width || !height) {
        return largest;
      }

      if (!largest) {
        return { width, height };
      }

      const largestArea =
        normalizeDimension(largest.width) * normalizeDimension(largest.height);

      return width * height > largestArea ? { width, height } : largest;
    },
    null,
  );

  if (!largestSource?.width || !largestSource.height) {
    return null;
  }

  return `${largestSource.width}x${largestSource.height}`;
};

const normalizeDimension = (value: number | undefined) => {
  return Number.isFinite(value) && value && value > 0
    ? Math.max(1, Math.round(value))
    : 0;
};

const getAIImageResolutionLabel = (resolution: string) => {
  return resolution.replace(/k$/i, "K");
};
