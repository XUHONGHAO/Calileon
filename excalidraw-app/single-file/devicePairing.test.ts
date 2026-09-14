import { normalizeDevicePollIntervalSeconds } from "./devicePairing";

describe("single-file device pairing", () => {
  it("clamps server-provided poll intervals to a bounded range", () => {
    expect(normalizeDevicePollIntervalSeconds(0)).toBe(1);
    expect(normalizeDevicePollIntervalSeconds(5)).toBe(5);
    expect(normalizeDevicePollIntervalSeconds(120)).toBe(60);
    expect(normalizeDevicePollIntervalSeconds("5")).toBe(5);
    expect(normalizeDevicePollIntervalSeconds(Number.NaN)).toBe(5);
  });
});
