export type MaskViewportGeometry = {
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  angle: number;
  corners: readonly (readonly [number, number])[];
};

export const createMaskViewportGeometry = ({
  centerX,
  centerY,
  width,
  height,
  angle,
}: Omit<MaskViewportGeometry, "corners">): MaskViewportGeometry => {
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const corners = [
    [-halfWidth, -halfHeight],
    [halfWidth, -halfHeight],
    [halfWidth, halfHeight],
    [-halfWidth, halfHeight],
  ].map(([x, y]) => rotateOffset(x, y, centerX, centerY, angle));

  return { centerX, centerY, width, height, angle, corners };
};

export const expandMaskViewportGeometry = (
  geometry: MaskViewportGeometry,
  padding: number,
) =>
  createMaskViewportGeometry({
    centerX: geometry.centerX,
    centerY: geometry.centerY,
    width: geometry.width + padding * 2,
    height: geometry.height + padding * 2,
    angle: geometry.angle,
  });

export const isPointInMaskViewportGeometry = (
  geometry: MaskViewportGeometry,
  point: readonly [number, number],
) => {
  const dx = point[0] - geometry.centerX;
  const dy = point[1] - geometry.centerY;
  const cos = Math.cos(-geometry.angle);
  const sin = Math.sin(-geometry.angle);
  const localX = dx * cos - dy * sin;
  const localY = dx * sin + dy * cos;

  return (
    Math.abs(localX) <= geometry.width / 2 &&
    Math.abs(localY) <= geometry.height / 2
  );
};

export const getMaskViewportBoxStyle = (geometry: MaskViewportGeometry) => ({
  left: geometry.centerX - geometry.width / 2,
  top: geometry.centerY - geometry.height / 2,
  width: geometry.width,
  height: geometry.height,
  transform: `rotate(${geometry.angle}rad)`,
});

const rotateOffset = (
  x: number,
  y: number,
  centerX: number,
  centerY: number,
  angle: number,
) => {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [centerX + x * cos - y * sin, centerY + x * sin + y * cos] as const;
};
