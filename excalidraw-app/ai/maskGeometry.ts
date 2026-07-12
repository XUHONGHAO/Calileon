import type {
  ExcalidrawElement,
  ExcalidrawImageElement,
  FileId,
} from "@excalidraw/element/types";
import type { Radians } from "@excalidraw/math";

export type AIMaskSourceGeometryV1 = {
  version: 1;
  imageId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: Radians;
};

export type AIMaskSourceGeometryV2 = {
  version: 2;
  imageId: string;
  fileId: FileId | null;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: Radians;
  scale: [number, number];
  crop: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
};

export type AIMaskSourceGeometry =
  | AIMaskSourceGeometryV1
  | AIMaskSourceGeometryV2;

export const createMaskSourceGeometryV2 = (
  image: Pick<
    ExcalidrawImageElement,
    | "id"
    | "fileId"
    | "x"
    | "y"
    | "width"
    | "height"
    | "angle"
    | "scale"
    | "crop"
  >,
): AIMaskSourceGeometryV2 => ({
  version: 2,
  imageId: image.id,
  fileId: image.fileId,
  x: image.x,
  y: image.y,
  width: image.width,
  height: image.height,
  angle: image.angle,
  scale: [...image.scale],
  crop: image.crop
    ? {
        x: image.crop.x / image.crop.naturalWidth,
        y: image.crop.y / image.crop.naturalHeight,
        width: image.crop.width / image.crop.naturalWidth,
        height: image.crop.height / image.crop.naturalHeight,
      }
    : { x: 0, y: 0, width: 1, height: 1 },
});

export const scenePointToLegacyDisplayPoint = (
  point: readonly [number, number],
  geometry: AIMaskSourceGeometryV1,
) => {
  const unrotatedPoint = rotatePoint(
    point,
    getGeometryCenter(geometry),
    -geometry.angle,
  );

  return [
    (unrotatedPoint[0] - geometry.x) / getSafeDimension(geometry.width),
    (unrotatedPoint[1] - geometry.y) / getSafeDimension(geometry.height),
  ] as const;
};

export const legacyDisplayPointToScenePoint = (
  point: readonly [number, number],
  geometry: AIMaskSourceGeometryV1,
) => {
  const unrotatedPoint = [
    geometry.x + point[0] * geometry.width,
    geometry.y + point[1] * geometry.height,
  ] as const;

  return rotatePoint(
    unrotatedPoint,
    getGeometryCenter(geometry),
    geometry.angle,
  );
};

export const scenePointToNormalizedNaturalPoint = (
  point: readonly [number, number],
  geometry: AIMaskSourceGeometryV2,
) => {
  const unrotatedPoint = rotatePoint(
    point,
    getGeometryCenter(geometry),
    -geometry.angle,
  );
  let displayX =
    (unrotatedPoint[0] - geometry.x) / getSafeDimension(geometry.width);
  let displayY =
    (unrotatedPoint[1] - geometry.y) / getSafeDimension(geometry.height);

  if (geometry.scale[0] < 0) {
    displayX = 1 - displayX;
  }
  if (geometry.scale[1] < 0) {
    displayY = 1 - displayY;
  }

  return [
    geometry.crop.x + displayX * geometry.crop.width,
    geometry.crop.y + displayY * geometry.crop.height,
  ] as const;
};

export const normalizedNaturalPointToScenePoint = (
  point: readonly [number, number],
  geometry: AIMaskSourceGeometryV2,
) => {
  let displayX =
    (point[0] - geometry.crop.x) / getSafeDimension(geometry.crop.width);
  let displayY =
    (point[1] - geometry.crop.y) / getSafeDimension(geometry.crop.height);

  if (geometry.scale[0] < 0) {
    displayX = 1 - displayX;
  }
  if (geometry.scale[1] < 0) {
    displayY = 1 - displayY;
  }

  const unrotatedPoint = [
    geometry.x + displayX * geometry.width,
    geometry.y + displayY * geometry.height,
  ] as const;

  return rotatePoint(
    unrotatedPoint,
    getGeometryCenter(geometry),
    geometry.angle,
  );
};

export const getMaskGeometryStrokeScale = (
  source: AIMaskSourceGeometry,
  target: AIMaskSourceGeometryV2,
) => {
  if (source.version === 1) {
    const scaleX = Math.abs(target.width) / getSafeDimension(source.width);
    const scaleY = Math.abs(target.height) / getSafeDimension(source.height);
    return Math.max(scaleX, scaleY);
  }

  const sourceDisplayPerNaturalX =
    Math.abs(source.width) / getSafeDimension(source.crop.width);
  const sourceDisplayPerNaturalY =
    Math.abs(source.height) / getSafeDimension(source.crop.height);
  const targetDisplayPerNaturalX =
    Math.abs(target.width) / getSafeDimension(target.crop.width);
  const targetDisplayPerNaturalY =
    Math.abs(target.height) / getSafeDimension(target.crop.height);

  return Math.max(
    targetDisplayPerNaturalX / sourceDisplayPerNaturalX,
    targetDisplayPerNaturalY / sourceDisplayPerNaturalY,
  );
};

export const isValidMaskSourceGeometry = (
  value: unknown,
  imageId: string,
): value is AIMaskSourceGeometry => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const geometry = value as Partial<AIMaskSourceGeometryV2> &
    Partial<AIMaskSourceGeometryV1>;

  if (
    geometry.imageId !== imageId ||
    (geometry.version !== 1 && geometry.version !== 2) ||
    !isFiniteGeometry(geometry)
  ) {
    return false;
  }

  if (geometry.version === 1) {
    return true;
  }

  return (
    Array.isArray(geometry.scale) &&
    geometry.scale.length === 2 &&
    geometry.scale.every(Number.isFinite) &&
    !!geometry.crop &&
    Number.isFinite(geometry.crop.x) &&
    Number.isFinite(geometry.crop.y) &&
    Number.isFinite(geometry.crop.width) &&
    Number.isFinite(geometry.crop.height) &&
    geometry.crop.width > 0 &&
    geometry.crop.height > 0
  );
};

const isFiniteGeometry = (
  geometry: Partial<
    Pick<ExcalidrawElement, "x" | "y" | "width" | "height" | "angle">
  >,
) =>
  Number.isFinite(geometry.x) &&
  Number.isFinite(geometry.y) &&
  Number.isFinite(geometry.width) &&
  Number.isFinite(geometry.height) &&
  Number.isFinite(geometry.angle);

const getGeometryCenter = (
  geometry: Pick<AIMaskSourceGeometry, "x" | "y" | "width" | "height">,
) =>
  [geometry.x + geometry.width / 2, geometry.y + geometry.height / 2] as const;

const getSafeDimension = (dimension: number) =>
  Math.max(Number.EPSILON, Math.abs(dimension));

const rotatePoint = (
  point: readonly [number, number],
  center: readonly [number, number],
  angle: number,
) => {
  if (!angle) {
    return point;
  }

  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const x = point[0] - center[0];
  const y = point[1] - center[1];

  return [
    x * cos - y * sin + center[0],
    x * sin + y * cos + center[1],
  ] as const;
};
