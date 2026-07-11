export type LuminaPerformanceLayer = "lighting" | "game";

export interface LuminaPerformanceSummary {
  count: number;
  median: number;
  p95: number;
  max: number;
}

export interface LuminaPerformanceSnapshot {
  lighting: LuminaPerformanceSummary;
  game: LuminaPerformanceSummary;
}

const MAX_SAMPLES_PER_LAYER = 600;
const SHOULD_COLLECT = !import.meta.env.PROD;
const samples: Record<LuminaPerformanceLayer, number[]> = {
  lighting: [],
  game: [],
};
let unpublishedSampleCount = 0;

const percentile = (values: readonly number[], ratio: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * ratio) - 1),
  );
  return sorted[index];
};

const summarize = (values: readonly number[]): LuminaPerformanceSummary => ({
  count: values.length,
  median: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: values.length > 0 ? Math.max(...values) : 0,
});

export const recordLuminaPerformanceSample = (
  layer: LuminaPerformanceLayer,
  duration: number,
) => {
  if (!SHOULD_COLLECT || !Number.isFinite(duration)) {
    return;
  }
  const layerSamples = samples[layer];
  layerSamples.push(Math.max(0, duration));
  if (layerSamples.length > MAX_SAMPLES_PER_LAYER) {
    layerSamples.splice(0, layerSamples.length - MAX_SAMPLES_PER_LAYER);
  }
  if (typeof document !== "undefined") {
    document.documentElement.dataset.luminaPerformanceSamples = `${
      samples.lighting.length + samples.game.length
    }`;
  }
  unpublishedSampleCount += 1;
  if (unpublishedSampleCount >= 30 && typeof document !== "undefined") {
    unpublishedSampleCount = 0;
    document.documentElement.dataset.luminaPerformance = JSON.stringify(
      getLuminaPerformanceSnapshot(),
    );
    document.documentElement.dataset.luminaPerformanceSamples = `${
      samples.lighting.length + samples.game.length
    }`;
  }
};

export const getLuminaPerformanceSnapshot = (): LuminaPerformanceSnapshot => ({
  lighting: summarize(samples.lighting),
  game: summarize(samples.game),
});

export const resetLuminaPerformanceSamples = () => {
  samples.lighting.length = 0;
  samples.game.length = 0;
  unpublishedSampleCount = 0;
  if (typeof document !== "undefined") {
    document.documentElement.dataset.luminaPerformance = JSON.stringify(
      getLuminaPerformanceSnapshot(),
    );
    document.documentElement.dataset.luminaPerformanceSamples = `${
      samples.lighting.length + samples.game.length
    }`;
  }
};

declare global {
  interface Window {
    __luminaPerformance?: {
      snapshot: typeof getLuminaPerformanceSnapshot;
      reset: typeof resetLuminaPerformanceSamples;
    };
  }
}

export const installLuminaPerformanceMonitor = () => {
  if (typeof window !== "undefined" && SHOULD_COLLECT) {
    window.__luminaPerformance = {
      snapshot: getLuminaPerformanceSnapshot,
      reset: resetLuminaPerformanceSamples,
    };
    document.documentElement.dataset.luminaPerformance = JSON.stringify(
      getLuminaPerformanceSnapshot(),
    );
    document.documentElement.dataset.luminaPerformanceSamples = `${
      samples.lighting.length + samples.game.length
    }`;
  }
};

installLuminaPerformanceMonitor();
