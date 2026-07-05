/**
 * C1 "点一盏灯"（Lumina）光照玩法的数据模型。
 *
 * 设计要点（见技术设计文档 C1-lumina-technical-design.md §2）：
 * - 材质与光源全部走 `element.customData`，不引入新的元素 `type`，
 *   这样可以白嫖现有的 restore / 协作同步 / 选中拖拽机制，且对未开启
 *   光照的普通用户零影响。
 * - 材质挂在 `customData.luminaMaterial`，光源挂在 `customData.luminaLight`，
 *   两个 key 分开，互不干扰：一个元素可以同时既是挡光体又是光源。
 */

/** 材质类型。决定一个元素在光照下如何与光交互。 */
export type LuminaMaterial =
  | "solid" // 实心：投出清晰硬阴影（默认，等同未设置）
  | "translucent" // 半透明：软影 + 透过一点光
  | "glass" // 玻璃：折射 + 背后聚出亮斑（焦散，M2）
  | "mirror" // 镜面：原样反射（M2/M3 解谜核心）
  | "emissive"; // 自发光：自身成为一盏面光源

/** 默认材质：未显式设置材质的元素都按实心挡光体处理。 */
export const DEFAULT_LUMINA_MATERIAL: LuminaMaterial = "solid";

/** 默认玻璃折射率（M2 起生效）。 */
export const DEFAULT_LUMINA_IOR = 1.5;

/** 挂在 `element.customData.luminaMaterial` 上的材质数据。 */
export interface LuminaMaterialData {
  material: LuminaMaterial;
  /** 玻璃折射率，默认 1.5（M2 起生效）。 */
  ior?: number;
  /** 自发光颜色，缺省取元素 strokeColor（M2 起生效）。 */
  emissiveColor?: string;
  /** 自发光强度（M2 起生效）。 */
  emissiveIntensity?: number;
}

/** 光源类型。 */
export type LuminaLightType =
  | "point" // 点光源：向四周发光，随距离衰减
  | "spot" // 聚光灯：锥形光束
  | "sun"; // 平行光（太阳）：方向一致，无衰减

/** 默认光源类型。 */
export const DEFAULT_LUMINA_LIGHT_TYPE: LuminaLightType = "point";

/** 默认聚光锥角（spot），单位弧度：整锥 45°。 */
export const DEFAULT_LUMINA_SPOT_ANGLE = Math.PI / 4;

/** 默认光传播方向（spot/sun），单位弧度：0 = 沿 +x。 */
export const DEFAULT_LUMINA_DIRECTION = 0;

/** 默认光色。 */
export const DEFAULT_LUMINA_LIGHT_COLOR = "#ffffff";

/** 默认光强。 */
export const DEFAULT_LUMINA_LIGHT_INTENSITY = 1;

/** 挂在 `element.customData.luminaLight` 上的光源数据。 */
export interface LuminaLightData {
  light: LuminaLightType;
  /** 光色，默认 #ffffff。 */
  color: string;
  /** 强度 0..n，默认 1。 */
  intensity: number;
  /** 衰减半径（point/spot），缺省按宿主元素尺寸推导。 */
  radius?: number;
  /** 聚光锥角（spot），单位弧度。 */
  angle?: number;
  /** 平行光方向（sun），单位弧度。 */
  direction?: number;
  /** 是否投射阴影，默认 true。 */
  castShadows: boolean;
}

/**
 * 元素 `customData` 中与 lumina 相关的字段。
 * 用于在不改动元素基础类型的前提下，给 customData 一个有类型的视图。
 */
export interface LuminaCustomData {
  luminaMaterial?: LuminaMaterialData;
  luminaLight?: LuminaLightData;
}

/**
 * 游戏层模式（M3）。M1/M2 不实现具体逻辑，此处先占位，
 * 让 appState.luminaGameMode 有一个稳定的类型，避免 M3 时改 appState 形状。
 */
export type LuminaGameMode =
  | { kind: "laser" } // 激光解谜
  | { kind: "shadow-reveal" } // 阴影揭秘
  | { kind: "dark-room" }; // 黑屋探宝
