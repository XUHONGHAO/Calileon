import { GatewayError } from "./errors.js";

type Bucket = { tokens: number; updatedAt: number };

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  consume(
    key: string,
    options: { capacity: number; refillPerMinute: number; now?: number },
  ) {
    const now = options.now ?? Date.now();
    const existing = this.buckets.get(key) || {
      tokens: options.capacity,
      updatedAt: now,
    };
    const elapsedMinutes = Math.max(0, now - existing.updatedAt) / 60_000;
    const tokens = Math.min(
      options.capacity,
      existing.tokens + elapsedMinutes * options.refillPerMinute,
    );
    if (tokens < 1) {
      this.buckets.set(key, { tokens, updatedAt: now });
      throw new GatewayError("AI_GATEWAY_RATE_LIMITED", 429, {
        retryable: true,
      });
    }
    this.buckets.set(key, { tokens: tokens - 1, updatedAt: now });
  }

  prune(now = Date.now()) {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt > 60 * 60_000) {
        this.buckets.delete(key);
      }
    }
  }
}
