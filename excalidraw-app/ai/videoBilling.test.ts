import {
  computeVideoTokenCost,
  estimateVideoCost,
  estimateVideoTokens,
} from "./videoBilling";

describe("AI video billing estimate", () => {
  it("matches the official Seedance 2.5 sample", () => {
    // 720p 16:9, 5 s = 108,000 tokens = ¥7.56 at 70 per million.
    expect(estimateVideoTokens({ outputSeconds: 5, resolution: "720p" })).toBe(
      108_000,
    );
    expect(
      estimateVideoCost({
        billing: { mode: "per-token", multiplier: 1 },
        model: "doubao-seedance-2-5-260628",
        outputSeconds: 5,
        resolution: "720p",
      }),
    ).toEqual({ tokens: 108_000, cost: 7.56, mayHitMinimum: false });
  });

  it("is close to the measured 4 s task and its bill", () => {
    const estimate = estimateVideoCost({
      billing: { mode: "per-token", multiplier: 0.75 },
      model: "doubao-seedance-2-5-260628",
      outputSeconds: 4,
      resolution: "720P",
    });

    // Measured: 83,505 tokens, net cost 4.384.
    expect(estimate?.tokens).toBe(86_400);
    expect(Math.abs(estimate!.tokens - 83_505) / 83_505).toBeLessThan(0.05);
    expect(
      computeVideoTokenCost({
        billing: { mode: "per-token", multiplier: 0.75 },
        model: "doubao-seedance-2-5-260628",
        totalTokens: 83_505,
        resolution: "720p",
      }),
    ).toBeCloseTo(4.384, 3);
  });

  it("uses the 1080p tier price and the reference-video price", () => {
    const billing = { mode: "per-token" as const, multiplier: 1 };
    const hd = estimateVideoCost({
      billing,
      model: "doubao-seedance-2-5-260628",
      outputSeconds: 5,
      resolution: "1080p",
    });

    expect(hd?.tokens).toBe(243_000);
    expect(hd?.cost).toBeCloseTo(243_000 * 77e-6, 6);

    const withVideo = estimateVideoCost({
      billing,
      model: "doubao-seedance-2-5-260628",
      outputSeconds: 5,
      resolution: "720p",
      inputVideoSeconds: 3,
    });

    expect(withVideo?.tokens).toBe(172_800);
    expect(withVideo?.cost).toBeCloseTo(172_800 * 42e-6, 6);
    expect(withVideo?.mayHitMinimum).toBe(true);
  });

  it("prefers card prices over catalog list prices", () => {
    expect(
      estimateVideoCost({
        billing: {
          mode: "per-token",
          multiplier: 0.5,
          prices: { "720p": { base: 10 } },
        },
        model: "doubao-seedance-2-5-260628",
        outputSeconds: 5,
        resolution: "720p",
      })?.cost,
    ).toBeCloseTo(0.54, 6);
  });

  it("gives tokens without a cost when no price is known", () => {
    expect(
      estimateVideoCost({
        billing: { mode: "per-token", multiplier: 1 },
        model: "unknown-model",
        outputSeconds: 5,
        resolution: "720p",
      }),
    ).toEqual({ tokens: 108_000, mayHitMinimum: false });
    // The catalog has no 1080p price for fast.
    expect(
      estimateVideoCost({
        billing: { mode: "per-token", multiplier: 1 },
        model: "doubao-seedance-2-0-fast-260128",
        outputSeconds: 5,
        resolution: "1080p",
      })?.cost,
    ).toBeUndefined();
  });

  it("returns nothing unless the card is billed per token", () => {
    const request = {
      model: "doubao-seedance-2-5-260628",
      outputSeconds: 5,
      resolution: "720p",
    };

    expect(estimateVideoCost({ ...request, billing: undefined })).toBeNull();
    expect(
      estimateVideoCost({ ...request, billing: { mode: "per-request" } }),
    ).toBeNull();
    expect(
      estimateVideoCost({
        ...request,
        billing: { mode: "per-token", multiplier: 1 },
        resolution: "auto",
      }),
    ).toBeNull();
    expect(
      computeVideoTokenCost({
        billing: { mode: "per-request" },
        model: request.model,
        totalTokens: 1000,
        resolution: "720p",
      }),
    ).toBeUndefined();
  });
});
