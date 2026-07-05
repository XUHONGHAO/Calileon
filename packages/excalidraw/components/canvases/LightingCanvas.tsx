import { useEffect, useRef } from "react";

import { renderLuminaScene } from "../../renderer/lumina";

import type {
  ElementsMap,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";
import type { AppState } from "../../types";

interface LightingCanvasProps {
  appState: AppState;
  elementsMap: ElementsMap;
  visibleElements: readonly NonDeletedExcalidrawElement[];
  scale: number;
  /**
   * 当本帧走了 Canvas2D fallback 且场景含 glass/mirror（会降级为硬阴影）时，
   * 回调一次，供 App 弹一次性轻提示「高级材质需 WebGL」（0015 评审项 3）。
   */
  onAdvancedMaterialFallback?: () => void;
}

/**
 * C1 Lumina 光照层。插在 StaticCanvas 之上、NewElementCanvas 之下，
 * 读可见元素 + appState 把光照合成到自己的 canvas（技术设计文档 §3.2）。
 *
 * 仅在 `appState.luminaEnabled` 为真时由 App 渲染；为假时整个组件不挂载，
 * 对现有体验零影响。
 */
const LightingCanvas = (props: LightingCanvasProps) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    // 每次 props 变化（拖光源/拖滑杆时每帧多次 setState）都调度到下一个 RAF，
    // 并合并同一帧内的多次调度为一次渲染——光照 pass 是全屏逐像素，若跟着每次
    // setState 同步跑会打满主线程与 GPU（拖半径滑杆时的卡顿与显卡飙升主因）。
    let rafId = 0;

    const render = () => {
      // 合成模型（见 composite.ts）：compositeLighting 以 multiply 把不透明光照图
      // 乘到目标且**不 clear**。屏幕层每帧先填白（白 = multiply 单位元），乘完
      // 得到不透明光照图；再靠下方的 CSS mix-blend-mode:multiply 与 StaticCanvas
      // 的元素相乘。ambient=1 且无光源时光照图全白 → 屏幕零变化（默认安静）。
      const deviceWidth = props.appState.width * props.scale;
      const deviceHeight = props.appState.height * props.scale;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, deviceWidth, deviceHeight);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, deviceWidth, deviceHeight);

      const result = renderLuminaScene(
        ctx,
        props.visibleElements,
        props.elementsMap,
        {
          scrollX: props.appState.scrollX,
          scrollY: props.appState.scrollY,
          zoom: props.appState.zoom.value,
          width: props.appState.width,
          height: props.appState.height,
          scale: props.scale,
        },
        {
          ambient: props.appState.luminaAmbient,
          caustics: props.appState.luminaCaustics,
          // 屏幕层把光照图渲染分辨率封顶到 1x CSS 像素：光照/阴影是低频信号，
          // 下采样后 CSS 拉伸铺满视觉几乎无差，却把逐像素 shader 填充量从 dpr²
          // 砍到 1（高 dpr 屏缩放/平移时显卡飙升的主因）。导出层不传此项，走满分辨率。
          maxRenderScale: 1,
        },
      );

      if (result.usedFallback && result.hasAdvancedMaterial) {
        props.onAdvancedMaterialFallback?.();
      }
    };

    // 合并同一帧内的多次 props 更新为一次渲染。若已有一帧待渲染则不重复调度。
    rafId = window.requestAnimationFrame(() => {
      rafId = 0;
      render();
    });
    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  });

  return (
    <canvas
      className="excalidraw__canvas"
      style={{
        width: props.appState.width,
        height: props.appState.height,
        // 光照层是一张不透明「光照乘子」图，靠 multiply 与下方 StaticCanvas
        // 的元素相乘（暗处压暗、亮处保留、彩光着色）。不设则会盖住元素。
        mixBlendMode: "multiply",
        // 光照层只做视觉合成，不接收指针事件，全部穿透给下方画布。
        pointerEvents: "none",
      }}
      width={props.appState.width * props.scale}
      height={props.appState.height * props.scale}
      ref={canvasRef}
    />
  );
};

export default LightingCanvas;
