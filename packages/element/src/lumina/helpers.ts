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
  DEFAULT_LUMINA_IOR,
  DEFAULT_LUMINA_MATERIAL,
} from "./types";

import type {
  LuminaCustomData,
  LuminaGameData,
  LuminaGameRole,
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

const LUMINA_GAME_ROLES: ReadonlySet<LuminaGameRole> = new Set([
  "target",
  "emitter",
  "shadowTarget",
  "treasure",
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

export const normalizeLuminaIor = (value: unknown): number => {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.min(2.5, value))
    : DEFAULT_LUMINA_IOR;
};

/** 黑屋探宝的最低照明评分阈值。 */
export const normalizeLuminaDarkRoomThreshold = (value: unknown): number => {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0.35;
};

/** 读取元素的原始 M3 游戏数据（若有且合法）。 */
export const getLuminaGameData = (
  element: ExcalidrawElement | null | undefined,
): LuminaGameData | null => {
  const data = getLuminaCustomData(element)?.luminaGame;
  if (data && LUMINA_GAME_ROLES.has(data.role)) {
    return data;
  }
  return null;
};

export const hasLuminaGameData = (
  element: ExcalidrawElement | null | undefined,
): boolean => {
  return getLuminaGameData(element) !== null;
};

export const isLuminaGameRole = (
  element: ExcalidrawElement | null | undefined,
  role: LuminaGameRole,
): boolean => {
  return getLuminaGameData(element)?.role === role;
};

/**
 * 把任意来源的材质数据补齐成带默认值的完整对象，用于写入 customData。
 * 不修改入参。
 */
export const normalizeLuminaMaterialData = (
  data: Partial<LuminaMaterialData> & { material: LuminaMaterial },
): LuminaMaterialData => {
  return {
    ...data,
    material: data.material,
    ior: data.material === "glass" ? normalizeLuminaIor(data.ior) : data.ior,
  };
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

/**
 * 把任意来源的游戏数据补齐成可写入 customData 的对象。
 * role 由调用方显式提供；其余字段按 JSON-safe 原样保留。
 */
export const normalizeLuminaGameData = (
  data: Partial<LuminaGameData> & { role: LuminaGameRole },
): LuminaGameData => {
  return {
    role: data.role,
    puzzleId: typeof data.puzzleId === "string" ? data.puzzleId : undefined,
    required: typeof data.required === "boolean" ? data.required : undefined,
    tolerance:
      typeof data.tolerance === "number" && Number.isFinite(data.tolerance)
        ? data.tolerance
        : undefined,
    label: typeof data.label === "string" ? data.label : undefined,
    meta:
      data.meta && typeof data.meta === "object" && !Array.isArray(data.meta)
        ? data.meta
        : undefined,
  };
};
