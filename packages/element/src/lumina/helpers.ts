/**
 * 读取/判定元素 lumina 数据的纯函数 helper。
 *
 * 所有 helper 都对 `element.customData` 做防御性读取——customData 是
 * `Record<string, any>`，可能来自旧版本或其他客户端，字段可能缺失或类型不符，
 * 因此每个 getter 都返回安全默认值，绝不抛错。
 */

import {
  DEFAULT_LUMINA_LIGHT_COLOR,
  DEFAULT_LUMINA_LIGHT_INTENSITY,
  DEFAULT_LUMINA_LIGHT_TYPE,
  DEFAULT_LUMINA_MATERIAL,
} from "./types";

import type {
  LuminaCustomData,
  LuminaLightData,
  LuminaLightType,
  LuminaMaterial,
  LuminaMaterialData,
} from "./types";
import type { ExcalidrawElement } from "../types";

const LUMINA_MATERIALS: ReadonlySet<LuminaMaterial> = new Set([
  "solid",
  "translucent",
  "glass",
  "mirror",
  "emissive",
]);

const LUMINA_LIGHT_TYPES: ReadonlySet<LuminaLightType> = new Set([
  "point",
  "spot",
  "sun",
]);

const getLuminaCustomData = (
  element: ExcalidrawElement | null | undefined,
): LuminaCustomData | undefined => {
  return element?.customData as LuminaCustomData | undefined;
};

/** 读取元素的原始材质数据（若有且合法）。 */
export const getLuminaMaterialData = (
  element: ExcalidrawElement | null | undefined,
): LuminaMaterialData | null => {
  const data = getLuminaCustomData(element)?.luminaMaterial;
  if (data && LUMINA_MATERIALS.has(data.material)) {
    return data;
  }
  return null;
};

/** 读取元素的材质类型，缺省/非法时返回默认 "solid"。 */
export const getLuminaMaterial = (
  element: ExcalidrawElement | null | undefined,
): LuminaMaterial => {
  return getLuminaMaterialData(element)?.material ?? DEFAULT_LUMINA_MATERIAL;
};

/** 读取元素的原始光源数据（若该元素是合法光源）。 */
export const getLuminaLightData = (
  element: ExcalidrawElement | null | undefined,
): LuminaLightData | null => {
  const data = getLuminaCustomData(element)?.luminaLight;
  if (data && LUMINA_LIGHT_TYPES.has(data.light)) {
    return data;
  }
  return null;
};

/** 元素是否为光源。 */
export const isLuminaLightSource = (
  element: ExcalidrawElement | null | undefined,
): boolean => {
  return getLuminaLightData(element) !== null;
};

/** 元素是否带有显式（非默认实心）材质。 */
export const hasLuminaMaterial = (
  element: ExcalidrawElement | null | undefined,
): boolean => {
  return getLuminaMaterialData(element) !== null;
};

/**
 * 把任意来源的材质数据补齐成带默认值的完整对象，用于写入 customData。
 * 不修改入参。
 */
export const normalizeLuminaMaterialData = (
  data: Partial<LuminaMaterialData> & { material: LuminaMaterial },
): LuminaMaterialData => {
  return { ...data, material: data.material };
};

/**
 * 把任意来源的光源数据补齐成带默认值的完整对象，用于写入 customData。
 * 不修改入参。
 */
export const normalizeLuminaLightData = (
  data: Partial<LuminaLightData> = {},
): LuminaLightData => {
  return {
    light: data.light ?? DEFAULT_LUMINA_LIGHT_TYPE,
    color: data.color ?? DEFAULT_LUMINA_LIGHT_COLOR,
    intensity: data.intensity ?? DEFAULT_LUMINA_LIGHT_INTENSITY,
    radius: data.radius,
    angle: data.angle,
    direction: data.direction,
    castShadows: data.castShadows ?? true,
  };
};
