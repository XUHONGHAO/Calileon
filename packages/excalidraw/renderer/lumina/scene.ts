/**
 * 从画布元素 + appState 抽取出光照渲染所需的中间表示（LuminaScene）。
 *
 * 这是「元素数据模型」与「光照渲染后端」之间的唯一桥梁（见技术设计文档
 * C1-lumina-technical-design.md §3）。M1 用 Canvas2D 软件光线投射消费它，
 * M2 换 WebGL 后端时复用同一套 LuminaScene，构建器无需改动。
 *
 * occluder（挡光体）用元素的**真实几何线段**（含旋转、曲线、椭圆、菱形、
 * 线/箭头折线），由 Excalidraw 的 `getElementLineSegments` 抽取——斜线、
 * 旋转矩形、椭圆的阴影都会贴合真实形状，而非外接矩形。这是激光解谜
 * （光打斜面/镜面反射）能玩的几何前提。
 */

import { getElementAbsoluteCoords } from "@excalidraw/element";
import { getElementLineSegments } from "@excalidraw/element";
import {
  DEFAULT_LUMINA_IOR,
  DEFAULT_LUMINA_LIGHT_COLOR,
  DEFAULT_LUMINA_LIGHT_INTENSITY,
  DEFAULT_LUMINA_SPOT_ANGLE,
  getLuminaLightData,
  getLuminaMaterial,
  getLuminaMaterialData,
  isLuminaLightSource,
  normalizeLuminaIor,
} from "@excalidraw/element/lumina";

import type {
  LuminaLightType,
  LuminaMaterial,
} from "@excalidraw/element/lumina";
import type {
  ElementsMap,
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import {
  getLuminaElementSignature,
  getLuminaElementsSignature,
} from "./signature";

/** 一条挡光线段的两端点（场景坐标）。 */
export type LuminaEdge = readonly [[number, number], [number, number]];

/**
 * 一个挡光体：一组真实几何线段 + 材质。坐标为场景坐标（未经 scroll/zoom）。
 * 阴影由每条线段沿光线方向投射的四边形并集构成。
 */
export interface LuminaOccluder {
  id: string;
  /** 元素的真实几何边（含旋转/曲线细分）。 */
  edges: LuminaEdge[];
  material: LuminaMaterial;
  opacity: number;
  /** 玻璃折射率（material === "glass" 时有效，缺省 1.5）。M2 shader 消费。 */
  ior: number;
}

/** 一个光源。坐标为场景坐标。 */
export interface LuminaLight {
  id: string;
  type: LuminaLightType;
  /** 光源中心（场景坐标）。sun 类型下仅作参考，实际用 direction。 */
  x: number;
  y: number;
  color: string;
  intensity: number;
  /** 衰减半径（场景坐标像素）。sun 类型下不衰减，此值忽略。 */
  radius: number;
  castShadows: boolean;
  /**
   * 光传播方向，单位弧度。sun：平行光朝向；spot：锥轴朝向（锥心指向）。
   * point 类型下为 undefined。
   */
  direction?: number;
  /**
   * 聚光锥的**半角**，单位弧度（spot 专用）。轴向 direction，锥内全亮、
   * 锥缘按角度软衰减。point/sun 类型下为 undefined。
   */
  angle?: number;
}

/** 一帧光照渲染所需的完整场景描述。 */
export interface LuminaScene {
  occluders: LuminaOccluder[];
  lights: LuminaLight[];
  /** 环境光亮度 0..1，1 = 不变暗。 */
  ambient: number;
  caustics: boolean;
}

/** 从光源宿主元素的尺寸推导一个合理的默认衰减半径。 */
const deriveRadius = (
  element: ExcalidrawElement,
  explicit: number | undefined,
): number => {
  if (explicit != null && explicit > 0) {
    return explicit;
  }
  // 缺省半径取宿主对角线的若干倍，保证光能照到周围一片区域。
  const diagonal = Math.hypot(element.width, element.height);
  return Math.max(diagonal * 6, 600);
};

/**
 * 从光源宿主元素的尺寸推导 spot 的锥半角（弧度）。
 *
 * 锥轴沿宿主元素的高度方向（direction = angle + π/2）射出，开口横跨宽度方向，
 * 因此把宿主外接盒当作光束在「一个 height 距离处」张开到 width 的喇叭：
 * 半角 = atan2(width/2, height)。拉宽 → 开角变大（更胖），拉高 → 开角变小
 * （更窄），符合「捏住手柄拉伸调光束形状」的直觉。
 *
 * 显式设置的 angle 优先；height 退化为 0 时回落到默认锥角，避免 atan2 给出 π/2。
 */
const deriveSpotAngle = (
  element: ExcalidrawElement,
  explicit: number | undefined,
): number => {
  if (explicit != null && explicit > 0) {
    return explicit;
  }
  const w = Math.abs(element.width);
  const h = Math.abs(element.height);
  if (h <= 0 || w <= 0) {
    return DEFAULT_LUMINA_SPOT_ANGLE;
  }
  // 夹到 (0, π/2)：避免锥退化成一条线或张成半平面。
  return Math.max(0.01, Math.min(Math.PI / 2 - 0.01, Math.atan2(w / 2, h)));
};

interface LuminaElementSceneEntry {
  light?: LuminaLight;
  occluder?: LuminaOccluder;
}

interface LuminaElementSceneCacheEntry {
  signature: string;
  entry: LuminaElementSceneEntry;
}

let elementSceneCache = new WeakMap<
  NonDeletedExcalidrawElement,
  LuminaElementSceneCacheEntry
>();

const buildLuminaElementSceneEntry = (
  element: NonDeletedExcalidrawElement,
  elementsMap: ElementsMap,
): LuminaElementSceneEntry => {
  if (isLuminaLightSource(element)) {
    const data = getLuminaLightData(element)!;
    const [, , , , cx, cy] = getElementAbsoluteCoords(element, elementsMap);
    return {
      light: {
        id: element.id,
        type: data.light,
        x: cx,
        y: cy,
        color: data.color,
        intensity: data.intensity,
        radius: deriveRadius(element, data.radius),
        castShadows: data.castShadows,
        direction:
          data.light === "sun" || data.light === "spot"
            ? element.angle + Math.PI / 2
            : undefined,
        angle:
          data.light === "spot"
            ? deriveSpotAngle(element, data.angle)
            : undefined,
      },
    };
  }

  const material = getLuminaMaterial(element);
  const materialData = getLuminaMaterialData(element);
  if (material === "emissive") {
    const [, , , , cx, cy] = getElementAbsoluteCoords(element, elementsMap);
    return {
      light: {
        id: element.id,
        type: "point",
        x: cx,
        y: cy,
        color:
          materialData?.emissiveColor ??
          element.strokeColor ??
          DEFAULT_LUMINA_LIGHT_COLOR,
        intensity:
          materialData?.emissiveIntensity ?? DEFAULT_LUMINA_LIGHT_INTENSITY,
        radius: deriveRadius(element, undefined),
        castShadows: false,
        direction: undefined,
      },
    };
  }

  const segments = getElementLineSegments(element, elementsMap);
  if (segments.length === 0) {
    return {};
  }
  const edges: LuminaEdge[] = segments.map((segment) => [
    [segment[0][0], segment[0][1]],
    [segment[1][0], segment[1][1]],
  ]);
  return {
    occluder: {
      id: element.id,
      edges,
      material,
      opacity: element.opacity,
      ior: normalizeLuminaIor(materialData?.ior ?? DEFAULT_LUMINA_IOR),
    },
  };
};

const getLuminaElementSceneEntry = (
  element: NonDeletedExcalidrawElement,
  elementsMap: ElementsMap,
): LuminaElementSceneEntry => {
  const signature = getLuminaElementSignature(element);
  const cached = elementSceneCache.get(element);
  if (cached?.signature === signature) {
    return cached.entry;
  }
  const entry = buildLuminaElementSceneEntry(element, elementsMap);
  elementSceneCache.set(element, { signature, entry });
  return entry;
};

/**
 * 从可见元素与 appState 构建 LuminaScene。
 *
 * @param elements 可见元素（已过滤删除/不可见）。
 * @param elementsMap 用于解析绝对坐标。
 * @param opts 全局光照参数。
 */
const buildLuminaSceneReference = (
  elements: readonly NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
  opts: { ambient: number; caustics: boolean },
): LuminaScene => {
  const occluders: LuminaOccluder[] = [];
  const lights: LuminaLight[] = [];

  for (const element of elements) {
    // 一个元素可同时带 luminaLight 与 luminaMaterial（双键，0015 D0），
    // 因此光源与材质分别独立判定，不用 else 互斥。
    if (isLuminaLightSource(element)) {
      const data = getLuminaLightData(element)!;
      const [, , , , cx, cy] = getElementAbsoluteCoords(element, elementsMap);
      lights.push({
        id: element.id,
        type: data.light,
        x: cx,
        y: cy,
        color: data.color,
        intensity: data.intensity,
        radius: deriveRadius(element, data.radius),
        castShadows: data.castShadows,
        // direction（sun 平行光朝向 / spot 锥轴朝向）**由宿主元素自身的旋转角
        // 决定**——直接抓元素的旋转手柄摆动即可旋转光束/太阳，复用现有旋转 +
        // 导出 + 协作机制，无需自定义交互。映射 direction = angle + π/2：
        // 手柄标记「灯/太阳的位置」，光朝手柄的**背向**射出（默认 angle=0、手柄
        // 朝上 → 太阳当顶、影子朝下，符合直觉）。point 无方向。
        direction:
          data.light === "sun" || data.light === "spot"
            ? element.angle + Math.PI / 2
            : undefined,
        // angle：spot 的锥半角；point/sun 无锥。
        angle:
          data.light === "spot"
            ? deriveSpotAngle(element, data.angle)
            : undefined,
      });
      // 显式光源宿主本身不作为挡光体，避免自挡光。
      continue;
    }

    const material = getLuminaMaterial(element);
    const materialData = getLuminaMaterialData(element);

    // emissive 材质不作为挡光体，而是作为一盏面光源注入 lights（0015 D2）。
    // shader/​fallback 因此无需对 emissive 特判，统一当普通光源处理。
    if (material === "emissive") {
      const [, , , , cx, cy] = getElementAbsoluteCoords(element, elementsMap);
      lights.push({
        id: element.id,
        type: "point",
        x: cx,
        y: cy,
        color:
          materialData?.emissiveColor ??
          element.strokeColor ??
          DEFAULT_LUMINA_LIGHT_COLOR,
        intensity:
          materialData?.emissiveIntensity ?? DEFAULT_LUMINA_LIGHT_INTENSITY,
        radius: deriveRadius(element, undefined),
        castShadows: false,
        direction: undefined,
      });
      continue;
    }

    // 用真实几何线段作为挡光体，而非外接矩形。
    const segments = getElementLineSegments(element, elementsMap);
    if (segments.length === 0) {
      continue;
    }
    const edges: LuminaEdge[] = segments.map((seg) => [
      [seg[0][0], seg[0][1]],
      [seg[1][0], seg[1][1]],
    ]);
    occluders.push({
      id: element.id,
      edges,
      material,
      opacity: element.opacity,
      ior: normalizeLuminaIor(materialData?.ior ?? DEFAULT_LUMINA_IOR),
    });
  }

  return {
    occluders,
    lights,
    ambient: opts.ambient,
    caustics: opts.caustics,
  };
};

const buildLuminaSceneFromElementCache = (
  elements: readonly NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
  opts: { ambient: number; caustics: boolean },
): LuminaScene => {
  const occluders: LuminaOccluder[] = [];
  const lights: LuminaLight[] = [];
  for (const element of elements) {
    const entry = getLuminaElementSceneEntry(element, elementsMap);
    if (entry.light) {
      lights.push(entry.light);
    }
    if (entry.occluder) {
      occluders.push(entry.occluder);
    }
  }
  return {
    occluders,
    lights,
    ambient: opts.ambient,
    caustics: opts.caustics,
  };
};

export const __sceneTesting = {
  buildLuminaSceneReference,
};

const MAX_SCENE_CACHE_ENTRIES = 8;
const sceneCache = new Map<string, LuminaScene>();
let sceneCacheHits = 0;
let sceneCacheMisses = 0;

export interface LuminaSceneCacheStats {
  entries: number;
  hits: number;
  misses: number;
}

export const getLuminaSceneCacheStats = (): LuminaSceneCacheStats => ({
  entries: sceneCache.size,
  hits: sceneCacheHits,
  misses: sceneCacheMisses,
});

export const clearLuminaSceneCache = () => {
  sceneCache.clear();
  elementSceneCache = new WeakMap();
  sceneCacheHits = 0;
  sceneCacheMisses = 0;
};

export const buildLuminaScene = (
  elements: readonly NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
  opts: { ambient: number; caustics: boolean },
): LuminaScene => {
  const signature = `${opts.ambient}\u001f${
    opts.caustics ? 1 : 0
  }\u001f${getLuminaElementsSignature(elements)}`;
  const cached = sceneCache.get(signature);
  if (cached) {
    sceneCacheHits += 1;
    sceneCache.delete(signature);
    sceneCache.set(signature, cached);
    return cached;
  }

  sceneCacheMisses += 1;
  const scene = buildLuminaSceneFromElementCache(elements, elementsMap, opts);
  sceneCache.set(signature, scene);
  if (sceneCache.size > MAX_SCENE_CACHE_ENTRIES) {
    const oldestKey = sceneCache.keys().next().value;
    if (oldestKey !== undefined) {
      sceneCache.delete(oldestKey);
    }
  }
  return scene;
};
