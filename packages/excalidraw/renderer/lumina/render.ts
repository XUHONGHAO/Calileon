/**
 * Lumina 光照渲染入口：把「构建场景 → 合成光照」两步串起来。
 *
 * 屏幕层（LightingCanvas）与导出层（exportToCanvas）都调用 renderLuminaScene，
 * 保证所见即所得（技术设计文档 §3.2 / §3.3）。
 */

import type {
  ElementsMap,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import { buildLuminaScene } from "./scene";
import { compositeLighting, sceneHasAdvancedMaterial } from "./composite";

import type { LuminaViewport } from "./composite";

export interface RenderLuminaOptions {
  ambient: number;
  caustics: boolean;
  /**
   * 光照图渲染分辨率上限（相对 CSS 像素）。屏幕层传 1（低频信号下采样，省 GPU），
   * 导出层不传（满分辨率，保阴影锐利）。见 CompositeLightingOptions.maxRenderScale。
   */
  maxRenderScale?: number;
}

/**
 * renderLuminaScene 的返回。
 *
 * M2 修订三起 Canvas2D 是唯一后端，glass/mirror 都原生渲染（见 composite.ts），
 * 不再有「WebGL 不可用 → 降级」的分叉，故 `usedFallback` 恒为 false，仅为兼容
 * 调用方签名保留。`hasAdvancedMaterial` 仍暴露，供未来需要时用。
 */
export interface RenderLuminaResult {
  /** 已废弃：不再有 WebGL fallback 分叉，恒为 false。 */
  usedFallback: boolean;
  /** 场景是否含 glass/mirror。 */
  hasAdvancedMaterial: boolean;
}

/**
 * 渲染一帧光照到目标 Canvas2D context。
 *
 * 调用方负责：仅在 `appState.luminaEnabled` 为真时调用；传入与画布一致的
 * viewport（scroll/zoom/scale/尺寸）。
 */
export const renderLuminaScene = (
  ctx: CanvasRenderingContext2D,
  elements: readonly NonDeletedExcalidrawElement[],
  elementsMap: ElementsMap,
  viewport: LuminaViewport,
  opts: RenderLuminaOptions,
): RenderLuminaResult => {
  const scene = buildLuminaScene(elements, elementsMap, {
    ambient: opts.ambient,
    caustics: opts.caustics,
  });
  compositeLighting(ctx, scene, viewport, {
    maxRenderScale: opts.maxRenderScale,
  });

  // M2 修订三：Canvas2D 是唯一后端，glass/mirror 都原生渲染，不再探测 WebGL，
  // 也不再有「降级」概念（usedFallback 恒 false）。
  return {
    usedFallback: false,
    hasAdvancedMaterial: sceneHasAdvancedMaterial(scene),
  };
};
