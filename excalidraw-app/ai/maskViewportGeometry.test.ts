import {
  createMaskViewportGeometry,
  getMaskViewportBoxStyle,
  isPointInMaskViewportGeometry,
} from "./maskViewportGeometry";

describe("mask viewport geometry", () => {
  it("uses the rotated rectangle instead of its axis-aligned bounds", () => {
    const geometry = createMaskViewportGeometry({
      centerX: 100,
      centerY: 100,
      width: 120,
      height: 60,
      angle: Math.PI / 4,
    });

    expect(isPointInMaskViewportGeometry(geometry, [100, 100])).toBe(true);
    expect(isPointInMaskViewportGeometry(geometry, [155, 145])).toBe(false);
    expect(geometry.corners).toHaveLength(4);
    expect(getMaskViewportBoxStyle(geometry)).toMatchObject({
      left: 40,
      top: 70,
      width: 120,
      height: 60,
      transform: `rotate(${Math.PI / 4}rad)`,
    });
  });
});
