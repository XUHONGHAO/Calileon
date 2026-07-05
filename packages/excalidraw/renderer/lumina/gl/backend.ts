/**
 * C1 Lumina M2 渲染后端探测与分流（0015 D5/D6）。
 *
 * 持有全局唯一的 LuminaGLRenderer 单例（0015 D6：单长驻 context，屏幕层与
 * 导出层共享），并对外暴露「拿 renderer / 是否可用 / 释放」三个入口。
 * compositeLighting 用它决定走 WebGL2 还是回落 M1 Canvas2D fallback。
 *
 * 探测策略：惰性初始化——首次 getGLRenderer() 时 tryCreate 一次。失败（老浏览器
 * / jsdom 无 WebGL / 创建失败）后缓存「不可用」，不反复重试徒增开销；context lost
 * 也标记不可用。resetGLRenderer 供 HMR / 全部实例卸载时释放并允许下次重建。
 */

import { LuminaGLRenderer } from "./LuminaGLRenderer";

/** 单例。undefined=未初始化，null=已探测且不可用，实例=可用。 */
let renderer: LuminaGLRenderer | null | undefined;

/**
 * 取 WebGL2 renderer 单例。首次调用惰性创建；不可用（探测失败 / context lost）
 * 时返回 null，调用方据此回落 Canvas2D fallback。
 */
export const getGLRenderer = (): LuminaGLRenderer | null => {
  if (renderer === undefined) {
    renderer = LuminaGLRenderer.tryCreate();
  }
  // context lost 后单例作废，下次调用重新探测（可能已 restored）。
  if (renderer && renderer.isLost()) {
    renderer.dispose();
    renderer = LuminaGLRenderer.tryCreate();
  }
  return renderer;
};

/** WebGL2 后端当前是否可用（不触发创建，仅读已探测结果）。 */
export const isLuminaGLAvailable = (): boolean => {
  return getGLRenderer() !== null;
};

/** 释放 GL 资源并重置探测状态（HMR / 全部实例卸载）。 */
export const resetGLRenderer = (): void => {
  if (renderer) {
    renderer.dispose();
  }
  renderer = undefined;
};
