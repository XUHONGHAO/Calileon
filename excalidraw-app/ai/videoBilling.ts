import { getAIVideoModelSpec } from "./videoModelCatalog";

import type {
  AIModelBilling,
  AIModelTokenPrices,
  AIVideoResolutionTier,
} from "./types";

/**
 * Cost estimate for per-token video models (ADR 0039 §8), following the
 * Volcengine formula:
 *
 *   tokens ≈ (input video s + output s) × width × height × fps / 1024
 *   cost   ≈ tokens × price per million × group multiplier / 1e6
 *
 * Checked against the official sample (2.5, 720p 16:9, 5 s = ¥7.56 = 108,000
 * tokens) and one measured task (4 s → 83,505 tokens, ~4% under the formula).
 * Requests with a reference video may hit Volcengine's minimum-token floor,
 * which this estimate cannot know; callers flag that case to the user.
 */

const ESTIMATE_FPS = 24;

// Measured: 720p 16:9 output is 1280×720. Other ratios are unmeasured and use
// the same pixel count as 16:9 at that tier (ADR 0039 "待实测" #5).
const TIER_PIXELS: Record<AIVideoResolutionTier, number> = {
  "480p": 854 * 480,
  "720p": 1280 * 720,
  "1080p": 1920 * 1080,
};

export const normalizeVideoResolutionTier = (
  value: string | undefined,
): AIVideoResolutionTier | undefined => {
  const tier = value?.trim().toLowerCase();

  return tier === "480p" || tier === "720p" || tier === "1080p"
    ? tier
    : undefined;
};

export const estimateVideoTokens = ({
  outputSeconds,
  resolution,
  inputVideoSeconds = 0,
}: {
  outputSeconds: number;
  resolution: AIVideoResolutionTier;
  inputVideoSeconds?: number;
}): number => {
  const seconds =
    Math.max(0, outputSeconds || 0) + Math.max(0, inputVideoSeconds || 0);

  return Math.round((seconds * TIER_PIXELS[resolution] * ESTIMATE_FPS) / 1024);
};

const resolvePricePerMillion = (
  prices: AIModelTokenPrices | undefined,
  resolution: AIVideoResolutionTier,
  hasReferenceVideo: boolean,
): number | undefined => {
  const tier = prices?.[resolution];

  if (!tier) {
    return undefined;
  }

  return hasReferenceVideo ? tier.withVideo ?? tier.base : tier.base;
};

export type AIVideoCostEstimate = {
  tokens: number;
  /** Absent when no price is known for this resolution tier. */
  cost?: number;
  /** Reference video present: Volcengine may bill a minimum token amount. */
  mayHitMinimum: boolean;
};

/**
 * Returns `null` unless the card is billed per token: per-request and
 * unconfigured cards get no estimate, by the user's decision (2026-10-28).
 */
export const estimateVideoCost = ({
  billing,
  model,
  outputSeconds,
  resolution,
  inputVideoSeconds = 0,
  hasReferenceVideo = inputVideoSeconds > 0,
}: {
  billing: AIModelBilling | undefined;
  model: string;
  outputSeconds: number;
  resolution: string | undefined;
  inputVideoSeconds?: number;
  hasReferenceVideo?: boolean;
}): AIVideoCostEstimate | null => {
  const tier = normalizeVideoResolutionTier(resolution);

  if (billing?.mode !== "per-token" || !tier) {
    return null;
  }

  const tokens = estimateVideoTokens({
    outputSeconds,
    resolution: tier,
    inputVideoSeconds,
  });
  const price = resolvePricePerMillion(
    billing.prices ?? getAIVideoModelSpec(model)?.listPrices,
    tier,
    hasReferenceVideo,
  );

  return {
    tokens,
    ...(price != null
      ? { cost: (tokens * price * billing.multiplier) / 1_000_000 }
      : {}),
    mayHitMinimum: hasReferenceVideo,
  };
};

/** Actual cost from a finished task's `usage.total_tokens`. */
export const computeVideoTokenCost = ({
  billing,
  model,
  totalTokens,
  resolution,
  hasReferenceVideo = false,
}: {
  billing: AIModelBilling | undefined;
  model: string;
  totalTokens: number;
  resolution: string | undefined;
  hasReferenceVideo?: boolean;
}): number | undefined => {
  const tier = normalizeVideoResolutionTier(resolution);

  if (billing?.mode !== "per-token" || !tier || !(totalTokens > 0)) {
    return undefined;
  }

  const price = resolvePricePerMillion(
    billing.prices ?? getAIVideoModelSpec(model)?.listPrices,
    tier,
    hasReferenceVideo,
  );

  return price != null
    ? (totalTokens * price * billing.multiplier) / 1_000_000
    : undefined;
};
