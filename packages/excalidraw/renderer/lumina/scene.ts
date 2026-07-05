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
  DEFAULT_LUMINA_DIRECTION,
  DEFAULT_LUMINA_IOR,
  DEFAULT_LUMINA_LIGHT_COLOR,
  DEFAULT_LUMINA_LIGHT_INTENSITY,
  DEFAULT_LUMINA_SPOT_ANGLE,
  getLuminaLightData,
  getLuminaMaterial,
  getLuminaMaterialData,
  isLuminaLightSource,
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

/** 一条挡光线段的两端点（场景坐标）。 */
export type LuminaEdge = readonly [
  [number, number],
  [number, number],
];

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
 * 从可见元素与 appState 构建 LuminaScene。
 *
 * @param elements 可见元素（已过滤删除/不可见）。
 * @param elementsMap 用于解析绝对坐标。
 * @param opts 全局光照参数。
 */
export const buildLuminaScene = (
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
            ? data.angle ?? DEFAULT_LUMINA_SPOT_ANGLE
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
        intensity: materialData?.emissiveIntensity ?? DEFAULT_LUMINA_LIGHT_INTENSITY,
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
      ior: materialData?.ior ?? DEFAULT_LUMINA_IOR,
    });
  }

  return {
    occluders,
    lights,
    ambient: opts.ambient,
    caustics: opts.caustics,
  };
};
