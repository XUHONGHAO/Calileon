import { describe, expect, it } from "vitest";

import { analyse } from "./analysis";
import { createMapper } from "./mapping";

const features = {
  rms: 0.4,
  low: 0.5,
  mid: 0.2,
  high: 0.3,
  onset: true,
  pitch: 440,
};
const area = { x: 0, y: 0, width: 500, height: 300 };
describe("synesthesia analysis", () => {
  it("leaves silence empty", () => {
    const { features: result } = analyse(
      new Float32Array(2048),
      new Uint8Array(1024),
      48000,
      2048,
      0,
    );
    expect(result.rms).toBe(0);
    expect(result.pitch).toBeNull();
    expect(result.onset).toBe(false);
  });
  it("measures a sine and separates low energy", () => {
    const wave = Float32Array.from(
      { length: 2048 },
      (_, i) => Math.sin((i * Math.PI * 2 * 440) / 48000) * 0.5,
    );
    const spectrum = new Uint8Array(1024);
    spectrum[4] = 255;
    const { features: result } = analyse(wave, spectrum, 48000, 2048, 0);
    expect(result.rms).toBeCloseTo(Math.sqrt(0.125), 2);
    expect(result.low).toBeGreaterThan(0);
    expect(result.high).toBe(0);
    expect(result.pitch).not.toBeNull();
  });
  it("applies onset refractory period and handles empty input", () => {
    const wave = new Float32Array(2048).fill(0.5);
    const spectrum = new Uint8Array(1024).fill(255);
    expect(analyse(wave, spectrum, 48000, 2048, 200).features.onset).toBe(true);
    expect(
      analyse(wave, spectrum, 48000, 2048, 200, { energy: 0, onsetAt: 100 })
        .features.onset,
    ).toBe(false);
    expect(
      analyse(new Float32Array(), new Uint8Array(), 44100, 2048, 0).features
        .rms,
    ).toBe(0);
  });
});
describe("synesthesia mapping", () => {
  it.each(["lines", "blocks", "stars"] as const)(
    "is deterministic and bounded: %s",
    (style) => {
      const a = createMapper(42, area, style, false);
      const b = createMapper(42, area, style, false);
      let total = 0;
      for (let time = 0; time < 300000; time += 150) {
        const result = a(features, time, 300000);
        expect(result).toEqual(b(features, time, 300000));
        total += result.length;
        for (const element of result) {
          expect(element.x).toBeGreaterThanOrEqual(0);
          expect(element.y).toBeGreaterThanOrEqual(0);
          expect((element.x ?? 0) + (element.width ?? 0)).toBeLessThanOrEqual(
            500,
          );
          expect((element.y ?? 0) + (element.height ?? 0)).toBeLessThanOrEqual(
            300,
          );
        }
      }
      expect(total).toBe(600);
      expect(a(features, 300000, 300000)).toEqual([]);
    },
  );
  it("does not draw silence", () => {
    expect(
      createMapper(1, area, "lines", false)({ ...features, rms: 0 }, 0, 300000),
    ).toEqual([]);
  });
});
