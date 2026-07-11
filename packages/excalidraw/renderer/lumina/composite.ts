/**
 * C1 Lumina 光照合成入口（0015 D4/D5）。
 *
 * 这是技术设计文档 §3.1 定义的「唯一合成入口」：屏幕层（LightingCanvas）
 * 与导出层（exportToCanvas）都调用 `compositeLighting`，保证所见即所得。
 * 对外签名恒为 `(ctx: CanvasRenderingContext2D, scene, viewport) => void`
 * （0014 D4 / 0015 D4 红线，M1→M2 不变）。
 *
 * ── 合成模型（单一 Canvas2D 后端，M2 修订三）──────────────────────
 * 产出一张**不透明的「光照乘子」图**（light-map）：
 *   base = ambient（0..1 灰底，<1 则整体压暗），每个光源在其上叠加提亮，
 *   命中挡光体的方向不叠加（留在 ambient）→ 阴影。
 * `compositeLighting` 以 `globalCompositeOperation = "multiply"` 把这张图
 * **乘**到目标上，且**从不 clear 目标**：
 *   - 导出层：目标已画好元素 → 元素 × 光照图（暗处压暗、亮处保留、彩光着色）。
 *     这天然修好了 M1 会 `clearRect` 抹掉导出元素的隐患。
 *   - 屏幕层：LightingCanvas 每帧先填白（白=multiply 单位元）再调本函数，
 *     得到不透明光照图；再靠 CSS `mix-blend-mode: multiply` 与下方 StaticCanvas
 *     的元素相乘。见 LightingCanvas.tsx。
 *
 * ── 后端（M2 修订三，2026-07-05）────────────────────────────────
 * **单一 Canvas2D 后端**，无 WebGL 分流。ambient / 直接光（point/spot/sun）/
 * 软阴影 / 镜面反射（虚像法）全部在 `compositeLightingCanvas2D` 里做，成本随
 * 「边数 × 光源数」而非视口像素数增长，故缩放/平移不飙 GPU。glass 透光软阴影、
 * mirror 本体硬阴影 + 虚像反射高光。为何弃用 WebGL 逐像素 ray-march 见
 * `compositeLighting` 处的演进史注释与 0015 决策附录。真实折射偏折、平行光镜像、
 * glass 二维折射与 point/spot/sun 一次镜面反射也在同一 CPU 几何路径完成。
 * WebGL 代码（gl/）暂留仓库但已从渲染路径摘除。
 *
 * 函数本身不读 DOM、不依赖 React，纯输入→画布输出，便于在导出/测试中复用。
 */

import { DEFAULT_LUMINA_SPOT_ANGLE } from "@excalidraw/element/lumina";

import { buildGlassCausticContributions } from "./glassOptics";
import {
  buildReflectedLightContributions,
  clipSegmentToCone,
  selectMirrorEdges,
} from "./mirrorOptics";

import type {
  LuminaEdge,
  LuminaLight,
  LuminaOccluder,
  LuminaScene,
} from "./scene";

export interface LuminaViewport {
  scrollX: number;
  scrollY: number;
  zoom: number;
  /** CSS 像素下的视口宽高。 */
  width: number;
  height: number;
  /** devicePixelRatio 等缩放。 */
  scale: number;
}

/** 把 0..100 的元素 opacity 归一到 0..1。 */
const normalizeOpacity = (opacity: number): number => {
  return Math.max(0, Math.min(1, opacity / 100));
};

/**
 * 计算单条挡光线段在某光源下投出的阴影四边形（场景坐标）。
 *
 * 做法：线段两端点是阴影的近端两角；把这两点各自沿「光源 → 点」方向投射到
 * 远处（projectionLength），得到远端两角。四点按 近A→近B→远B→远A 顺序
 * 构成一个不自交的四边形（阴影梯形/体）。
 *
 * 逐边投射天然贴合真实几何：斜线投出斜阴影、旋转矩形的每条边各投一片、
 * 椭圆按细分线段投出弧形阴影带。多条边的阴影四边形叠加（destination-out）
 * 即为整个元素的阴影，无需求并集或凸包。
 */
const computeEdgeShadowQuad = (
  light: LuminaLight,
  edge: readonly [readonly [number, number], readonly [number, number]],
  projectionLength: number,
): Array<[number, number]> => {
  const project = (px: number, py: number): [number, number] => {
    const dx = px - light.x;
    const dy = py - light.y;
    const len = Math.hypot(dx, dy) || 1;
    return [
      px + (dx / len) * projectionLength,
      py + (dy / len) * projectionLength,
    ];
  };

  const [ax, ay] = edge[0];
  const [bx, by] = edge[1];
  const farA = project(ax, ay);
  const farB = project(bx, by);

  // 近A → 近B → 远B → 远A，顺序保证四边形不自交。
  return [[ax, ay], [bx, by], farB, farA];
};

/**
 * 平行光（sun）下单条挡光线段投出的阴影四边形。
 *
 * 与点光源不同：平行光的所有光线**方向一致**（= direction），不是从某个点
 * 发散。因此两端点沿**同一个方向向量**平移 projectionLength 得到远端两角，
 * 投出的阴影是一条等宽的平行带——这正是「太阳照全图、影子全朝一个方向」的
 * 物理表现。
 */
const computeSunShadowQuad = (
  direction: number,
  edge: readonly [readonly [number, number], readonly [number, number]],
  projectionLength: number,
): Array<[number, number]> => {
  const dx = Math.cos(direction) * projectionLength;
  const dy = Math.sin(direction) * projectionLength;
  const [ax, ay] = edge[0];
  const [bx, by] = edge[1];
  // 近A → 近B → 远B → 远A（远端 = 近端沿光线方向平移）。
  return [
    [ax, ay],
    [bx, by],
    [bx + dx, by + dy],
    [ax + dx, ay + dy],
  ];
};

/** Andrew's monotone chain 凸包。 */
const convexHull = (pts: Array<[number, number]>): Array<[number, number]> => {
  const points = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (points.length <= 2) {
    return points;
  }
  const cross = (
    o: [number, number],
    a: [number, number],
    b: [number, number],
  ) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: Array<[number, number]> = [];
  for (const p of points) {
    while (
      lower.length >= 2 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0
    ) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Array<[number, number]> = [];
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    while (
      upper.length >= 2 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0
    ) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
};

/** 解析颜色为 rgb 三元组（仅支持 #rgb / #rrggbb，失败回退白色）。 */
const parseColor = (color: string): [number, number, number] => {
  // 防御：customData 来自导入/协作，color 可能不是字符串（旧数据/异常客户端），
  // 直接 .trim() 会崩。非字符串一律回退白色。
  if (typeof color !== "string") {
    return [255, 255, 255];
  }
  const hex = color.trim().replace(/^#/, "");
  if (hex.length === 3) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    if (![r, g, b].some(Number.isNaN)) {
      return [r, g, b];
    }
  } else if (hex.length === 6) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    if (![r, g, b].some(Number.isNaN)) {
      return [r, g, b];
    }
  }
  return [255, 255, 255];
};

/**
 * 不同材质对阴影强度的影响：
 *  - solid：完全挡光（硬阴影）。
 *  - translucent：半挡光。
 *  - glass：**大部分透光**——只投一层很淡的阴影（玻璃是透明的，不该像实心
 *    一样把光全挡住）。开焦散时更进一步（见 shadow 循环里对 caustics 的处理，
 *    此时 glass 完全透光）。这修好了此前「玻璃对光的反应和实心一模一样」的问题
 *    ——那时 glass 直接 fall-through 到 solid 的 return base。
 *  - mirror：镜面是**不透明**的，本体照样投完整硬阴影（你看不透镜子）；额外的
 *    「反射高光」由 addMirrorReflections 用虚像法另加，不在这里。
 *  - emissive：不会到此（buildLuminaScene 已转光源）。
 */
const shadowStrengthFor = (occluder: LuminaOccluder): number => {
  const base = normalizeOpacity(occluder.opacity);
  switch (occluder.material) {
    case "solid":
      return base;
    case "translucent":
      return base * 0.45;
    case "glass":
      // 玻璃透光：只留一层很淡的阴影（透过率 ≈ 85%）。
      return base * 0.15;
    case "mirror":
      // 镜面不透明：本体投完整硬阴影；反射另由 addMirrorReflections 处理。
      return base;
    case "emissive":
      return 0;
    default:
      return base;
  }
};

const MAX_DIRECT_SHADOW_EDGES_PER_LIGHT = 192;

interface ShadowCastingEdge {
  edge: LuminaEdge;
  alpha: number;
}

const pointToEdgeDistance = (
  x: number,
  y: number,
  edge: LuminaEdge,
): number => {
  const [a, b] = edge;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-12) {
    return Math.hypot(x - a[0], y - a[1]);
  }
  const t = Math.max(
    0,
    Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / lengthSquared),
  );
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
};

const selectDirectShadowEdges = (
  scene: LuminaScene,
  light: LuminaLight,
  maxEdges = MAX_DIRECT_SHADOW_EDGES_PER_LIGHT,
): ShadowCastingEdge[] => {
  const selected: ShadowCastingEdge[] = [];
  for (const occluder of scene.occluders) {
    const alpha = shadowStrengthFor(occluder);
    if (alpha <= 0) {
      continue;
    }
    for (const edge of occluder.edges) {
      let selectedEdge = edge;
      if (light.type !== "sun") {
        if (pointToEdgeDistance(light.x, light.y, edge) > light.radius) {
          continue;
        }
        if (light.type === "spot") {
          const clipped = clipSegmentToCone(
            edge[0][0],
            edge[0][1],
            edge[1][0],
            edge[1][1],
            light.x,
            light.y,
            light.direction ?? 0,
            light.angle ?? DEFAULT_LUMINA_SPOT_ANGLE,
          );
          if (!clipped) {
            continue;
          }
          selectedEdge = [
            [clipped[0], clipped[1]],
            [clipped[2], clipped[3]],
          ];
        }
      }
      selected.push({ edge: selectedEdge, alpha });
      if (selected.length >= maxEdges) {
        return selected;
      }
    }
  }
  return selected;
};

const selectDirectShadowOccluders = (
  scene: LuminaScene,
  light: LuminaLight,
): LuminaOccluder[] => {
  const edgeCount = scene.occluders.reduce(
    (total, occluder) => total + occluder.edges.length,
    0,
  );
  const maxEdges =
    edgeCount > 256 ? (light.type === "sun" ? 128 : 96) : undefined;
  return selectDirectShadowEdges(scene, light, maxEdges).map(
    ({ edge, alpha }, index) => ({
      id: `shadow-budget-${index}`,
      edges: [edge],
      material: "solid",
      opacity: alpha * 100,
      ior: 1.5,
    }),
  );
};

/** 轴对齐矩形（设备像素坐标）。 */
interface DeviceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 两个轴对齐矩形求交。无交集（含退化为零宽/零高）返回 null。
 *
 * 用途：镜面反射的可绘制区域 ⊆ 以虚光源 L' 为心、radius 为半径的圆盘（渐变
 * 半径外 alpha=0）。把该圆盘的包围盒与视口设备矩形求交，得到真正需要绘制的
 * 局部 box——远处/小镜面时它远小于整个视口，避免「clip 后 fillRect 整个视口」
 * 的浪费。交集为空则整条反射不可见，直接跳过（视口外剔除）。
 */
const intersectRects = (a: DeviceRect, b: DeviceRect): DeviceRect | null => {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) {
    return null;
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
};

/**
 * 创建离屏图层。优先用 OffscreenCanvas，回退到 document.createElement。
 * 测试环境（jsdom）可能两者都缺，此时返回 null（合成降级为无光照 no-op）。
 */
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

let layerPools = new WeakMap<object, Map<string, AnyCanvas>>();

const createLayer = (
  owner: object,
  key: string,
  width: number,
  height: number,
): AnyCanvas | null => {
  let pool = layerPools.get(owner);
  if (!pool) {
    pool = new Map();
    layerPools.set(owner, pool);
  }
  let canvas = pool.get(key);
  if (!canvas) {
    if (typeof OffscreenCanvas !== "undefined") {
      canvas = new OffscreenCanvas(width, height);
    } else if (typeof document !== "undefined") {
      const htmlCanvas = document.createElement("canvas");
      htmlCanvas.width = width;
      htmlCanvas.height = height;
      canvas = htmlCanvas;
    } else {
      return null;
    }
    pool.set(key, canvas);
  }
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  } else {
    const layerContext = canvas.getContext("2d") as Ctx2D | null;
    layerContext?.setTransform(1, 0, 0, 1, 0, 0);
    layerContext?.clearRect(0, 0, width, height);
  }
  return canvas;
};

export const clearLuminaLayerPool = () => {
  layerPools = new WeakMap();
};

export const getLuminaLayerPoolSize = (owner: object): number =>
  layerPools.get(owner)?.size ?? 0;

/**
 * Canvas2D 后端（M2 转正为**通用 base 后端**）：把 LuminaScene 渲染成一张
 * **不透明光照图**并以 multiply 乘到目标上。
 *
 * 算法：
 *  1. 离屏 base 层填 ambient 灰底（不透明）。
 *  2. 每个光源：在临时透明层画彩色径向光晕 → 用阴影四边形 destination-out
 *     挖掉被遮挡方向 → 以 'lighter' 叠加到 base（多光源在此相加混色）。
 *  2.5 镜面反射（虚像法）：对每条镜面边把光源镜像成虚光源 L'，在「透过镜面
 *     能看见 L'」的锥形区域画 L' 的径向光晕，'lighter' 叠加到 base。纯几何 +
 *     径向渐变，与直接光同一套硬件加速机制，不逐像素、不飙 GPU（见 addMirror
 *     一节的详细注释）。
 *  3. base 以 globalCompositeOperation='multiply' 乘到目标 ctx（不 clear）。
 *
 * 全部材质（solid/translucent/glass/mirror）都在本 Canvas2D 后端渲染，不再需要
 * WebGL——镜面反射本质是几何（虚像法），Canvas2D 的多边形裁剪 + 径向渐变即可
 * 胜任，且保持 M1 已验证的丝滑与软阴影。这修好了「镜面场景 GPU 飙升 / 硬阴影
 * 暗楔」与「玻璃对光反应和实心一样」两个问题。
 *
 * 离屏层不可用（jsdom）→ 直接 return（no-op），保证无 canvas 环境不报错、
 * 且导出/静态快照零影响。
 */
export const compositeLightingCanvas2D = (
  ctx: CanvasRenderingContext2D,
  scene: LuminaScene,
  viewport: LuminaViewport,
): void => {
  const { scale, zoom, scrollX, scrollY, width, height } = viewport;
  const deviceWidth = Math.max(1, Math.floor(width * scale));
  const deviceHeight = Math.max(1, Math.floor(height * scale));
  const t = zoom * scale; // 场景坐标 → 设备像素的缩放系数

  const base = createLayer(ctx, "base", deviceWidth, deviceHeight);
  if (!base) {
    return; // 无离屏能力（jsdom）→ no-op。
  }
  const bctx = base.getContext("2d") as Ctx2D | null;
  if (!bctx) {
    return;
  }

  // 1. ambient 灰底（不透明）。ambient=1 → 全白 → multiply 后目标不变。
  const amb = Math.max(0, Math.min(1, scene.ambient));
  const ambByte = Math.round(amb * 255);
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  bctx.fillStyle = `rgb(${ambByte}, ${ambByte}, ${ambByte})`;
  bctx.fillRect(0, 0, deviceWidth, deviceHeight);

  // 阴影投射长度：足够覆盖整个视口对角线（场景坐标）。
  const projectionLength =
    (Math.hypot(deviceWidth, deviceHeight) / Math.max(t, 0.0001)) * 2;

  for (const light of scene.lights) {
    const layer = createLayer(ctx, "light", deviceWidth, deviceHeight);
    if (!layer) {
      continue;
    }
    const lctx = layer.getContext("2d") as Ctx2D | null;
    if (!lctx) {
      continue;
    }
    lctx.setTransform(t, 0, 0, t, scrollX * t, scrollY * t);

    const [r, g, b] = parseColor(light.color);
    const peak = Math.max(0, light.intensity);
    const viewLeft = -scrollX;
    const viewTop = -scrollY;
    const viewW = deviceWidth / t;
    const viewH = deviceHeight / t;

    // ── 发光填充：按光源类型不同 ─────────────────────────────
    if (light.type === "sun") {
      // 平行光（太阳）：无距离衰减，整片视口均匀受光。用一层平铺纯色即可，
      // 不用径向渐变——这才是「太阳」，而非点光源。方向只影响阴影朝向。
      lctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${Math.min(1, peak)})`;
      lctx.fillRect(viewLeft, viewTop, viewW, viewH);
    } else {
      // point / spot：以光源为中心的径向光晕，按 radius 衰减到 0。
      const grad = lctx.createRadialGradient(
        light.x,
        light.y,
        0,
        light.x,
        light.y,
        Math.max(1, light.radius),
      );
      grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${Math.min(1, peak)})`);
      grad.addColorStop(
        0.5,
        `rgba(${r}, ${g}, ${b}, ${Math.min(1, peak * 0.4)})`,
      );
      grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);

      if (light.type === "spot") {
        // 聚光灯：径向光晕裁到一个锥形（轴向 direction、半角 angle）。锥外
        // clip 掉，锥缘用一小段角度软过渡避免硬切。锥即「apex + 两条边射线
        // 远端」构成的楔形三角（远端在 projectionLength 处，远超 radius，
        // 而渐变在 radius 处已归零，故三角的平直远边不会露馅）。
        const axis = light.direction ?? 0;
        const half = Math.max(
          0.01,
          Math.min(Math.PI - 0.01, light.angle ?? DEFAULT_LUMINA_SPOT_ANGLE),
        );
        const dLeft = axis - half;
        const dRight = axis + half;
        const fx1 = light.x + Math.cos(dLeft) * projectionLength;
        const fy1 = light.y + Math.sin(dLeft) * projectionLength;
        const fx2 = light.x + Math.cos(axis) * projectionLength;
        const fy2 = light.y + Math.sin(axis) * projectionLength;
        const fx3 = light.x + Math.cos(dRight) * projectionLength;
        const fy3 = light.y + Math.sin(dRight) * projectionLength;
        lctx.save();
        lctx.beginPath();
        lctx.moveTo(light.x, light.y);
        lctx.lineTo(fx1, fy1);
        lctx.lineTo(fx2, fy2);
        lctx.lineTo(fx3, fy3);
        lctx.closePath();
        lctx.clip();
        lctx.fillStyle = grad;
        lctx.fillRect(viewLeft, viewTop, viewW, viewH);
        lctx.restore();
      } else {
        lctx.fillStyle = grad;
        lctx.fillRect(viewLeft, viewTop, viewW, viewH);
      }
    }

    // ── 挖阴影 ──────────────────────────────────────────────
    if (light.castShadows) {
      lctx.globalCompositeOperation = "destination-out";
      for (const occluder of selectDirectShadowOccluders(scene, light)) {
        const alpha = shadowStrengthFor(occluder);
        if (alpha <= 0) {
          continue;
        }
        lctx.fillStyle = `rgba(0, 0, 0, ${alpha})`;
        for (const edge of occluder.edges) {
          // sun：平行光，所有阴影沿同一 direction 投射；point/spot：从光源
          // 径向投射。
          const quad =
            light.type === "sun"
              ? computeSunShadowQuad(
                  light.direction ?? 0,
                  edge,
                  projectionLength,
                )
              : computeEdgeShadowQuad(light, edge, projectionLength);
          lctx.beginPath();
          lctx.moveTo(quad[0][0], quad[0][1]);
          for (let i = 1; i < quad.length; i++) {
            lctx.lineTo(quad[i][0], quad[i][1]);
          }
          lctx.closePath();
          lctx.fill();
        }
      }
      lctx.globalCompositeOperation = "source-over";
    }

    // 以 'lighter' 把这盏灯叠加到 base（提亮 + 多光源相加混色）。
    bctx.setTransform(1, 0, 0, 1, 0, 0);
    bctx.globalCompositeOperation = "lighter";
    bctx.drawImage(layer as AnyCanvas, 0, 0);
    bctx.globalCompositeOperation = "source-over";
  }

  // 2.25 玻璃折射与焦散。只在 luminaCaustics=true 时启用，默认场景仍保留
  // 现有廉价玻璃透光路径。纯几何层先按 Snell 定律生成 entry→exit→outgoing
  // 折线路径，Canvas2D 这里只负责把有限射线以 lighter 累积成亮斑。
  if (scene.caustics) {
    const glassCount = scene.occluders.filter(
      (occluder) => occluder.material === "glass",
    ).length;
    const glassPressure = glassCount * Math.max(1, scene.lights.length) > 24;
    const contributions = buildGlassCausticContributions(scene, {
      maxDistance: projectionLength,
      maxGlass: glassPressure ? 5 : 8,
      maxRaysPerGlass: glassPressure ? 6 : 10,
      maxContributions: glassPressure ? 48 : 80,
    });
    if (contributions.length > 0) {
      const causticLayer = createLayer(
        ctx,
        "caustic",
        deviceWidth,
        deviceHeight,
      );
      const cctx = (causticLayer?.getContext("2d") as Ctx2D | null) ?? null;
      if (causticLayer && cctx) {
        cctx.setTransform(t, 0, 0, t, scrollX * t, scrollY * t);
        cctx.globalCompositeOperation = "lighter";
        cctx.lineCap = "round";
        cctx.lineJoin = "round";

        for (const contribution of contributions) {
          const [r, g, b] = parseColor(contribution.color);
          const alpha = Math.min(0.7, contribution.intensity);
          if (alpha <= 0) {
            continue;
          }
          const gradient = cctx.createLinearGradient(
            contribution.entry[0],
            contribution.entry[1],
            contribution.endpoint[0],
            contribution.endpoint[1],
          );
          gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha * 0.2})`);
          gradient.addColorStop(0.55, `rgba(${r}, ${g}, ${b}, ${alpha})`);
          gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);

          const tracePath = () => {
            cctx.beginPath();
            cctx.moveTo(contribution.entry[0], contribution.entry[1]);
            cctx.lineTo(contribution.exit[0], contribution.exit[1]);
            cctx.lineTo(contribution.endpoint[0], contribution.endpoint[1]);
          };

          tracePath();
          cctx.strokeStyle = gradient;
          cctx.lineWidth = 10 / Math.max(0.1, zoom);
          cctx.shadowColor = `rgba(${r}, ${g}, ${b}, ${alpha})`;
          cctx.shadowBlur = 14 * scale;
          cctx.stroke();

          tracePath();
          cctx.lineWidth = 2.5 / Math.max(0.1, zoom);
          cctx.shadowBlur = 4 * scale;
          cctx.stroke();
        }

        bctx.setTransform(1, 0, 0, 1, 0, 0);
        bctx.globalCompositeOperation = "lighter";
        bctx.drawImage(causticLayer as AnyCanvas, 0, 0);
        bctx.globalCompositeOperation = "source-over";
      }
    }
  }

  // 2.5 镜面反射。纯几何层先把 point/spot/sun 统一拆成有限宽度的反射条带：
  // - point/spot 保留虚像法衰减，但只绘制真实受光的镜面子段；
  // - sun 使用 reflectRay 得到平行反射方向，不伪造有限位置的“虚太阳”；
  // - 每条带的两侧边界光线分别追踪最近遮挡，因此 solid/mirror 会截断后方反射，
  //   translucent/glass 按材质透射率减弱；不做第二次环境光反弹。
  const mirrorEdgeCount = scene.occluders
    .filter((occluder) => occluder.material === "mirror")
    .reduce((total, occluder) => total + occluder.edges.length, 0);
  const mirrorPressure =
    mirrorEdgeCount * Math.max(1, scene.lights.length) > 48;
  const reflectedContributions = buildReflectedLightContributions(scene, {
    maxDistance: projectionLength,
    maxMirrorEdges: mirrorPressure ? 48 : 64,
    maxContributions: mirrorPressure ? 64 : 192,
    samplesPerEdge: mirrorPressure ? 3 : 6,
  });
  if (reflectedContributions.length > 0) {
    const reflectionLayer = createLayer(
      ctx,
      "reflection",
      deviceWidth,
      deviceHeight,
    );
    const rctx = (reflectionLayer?.getContext("2d") as Ctx2D | null) ?? null;
    if (reflectionLayer && rctx) {
      const viewDeviceRect: DeviceRect = {
        x: 0,
        y: 0,
        width: deviceWidth,
        height: deviceHeight,
      };
      let drewAny = false;

      for (const contribution of reflectedContributions) {
        const xs = contribution.polygon.map((point) => point[0]);
        const ys = contribution.polygon.map((point) => point[1]);
        const minX = Math.min(...xs);
        const minY = Math.min(...ys);
        const maxX = Math.max(...xs);
        const maxY = Math.max(...ys);
        const box = intersectRects(
          {
            x: (minX + scrollX) * t,
            y: (minY + scrollY) * t,
            width: Math.max(0, maxX - minX) * t,
            height: Math.max(0, maxY - minY) * t,
          },
          viewDeviceRect,
        );
        if (!box) {
          continue;
        }

        const [r, g, b] = parseColor(contribution.color);
        const alpha = Math.min(1, contribution.intensity);
        rctx.save();
        rctx.setTransform(1, 0, 0, 1, 0, 0);
        rctx.beginPath();
        rctx.rect(box.x, box.y, box.width, box.height);
        rctx.clip();

        rctx.setTransform(t, 0, 0, t, scrollX * t, scrollY * t);
        rctx.beginPath();
        rctx.moveTo(contribution.polygon[0][0], contribution.polygon[0][1]);
        for (let index = 1; index < contribution.polygon.length; index++) {
          rctx.lineTo(
            contribution.polygon[index][0],
            contribution.polygon[index][1],
          );
        }
        rctx.closePath();
        rctx.clip();
        rctx.globalCompositeOperation = "lighter";

        if (contribution.lightType === "sun") {
          rctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha * 0.34})`;
          rctx.fillRect(minX, minY, maxX - minX, maxY - minY);
        } else if (contribution.virtualSource) {
          const [virtualX, virtualY] = contribution.virtualSource;
          const gradient = rctx.createRadialGradient(
            virtualX,
            virtualY,
            0,
            virtualX,
            virtualY,
            contribution.radius,
          );
          gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${alpha})`);
          gradient.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, ${alpha * 0.4})`);
          gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
          rctx.fillStyle = gradient;
          rctx.fillRect(minX, minY, maxX - minX, maxY - minY);
        }
        rctx.restore();
        drewAny = true;
      }

      if (drewAny) {
        bctx.setTransform(1, 0, 0, 1, 0, 0);
        bctx.globalCompositeOperation = "lighter";
        bctx.drawImage(reflectionLayer as AnyCanvas, 0, 0);
        bctx.globalCompositeOperation = "source-over";
      }
    }
  }

  // 3. 光照图以 multiply 乘到目标（不 clear，保留目标已有元素）。
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "multiply";
  ctx.drawImage(base as AnyCanvas, 0, 0);
  ctx.restore();
};

/** compositeLighting 的可选项。 */
export interface CompositeLightingOptions {
  /**
   * 光照图的**渲染分辨率上限**（相对 CSS 像素的倍率）。光照/阴影是低频信号，
   * 屏幕层按 1x CSS 像素渲染再 CSS 拉伸铺满即可，视觉几乎无差，却把逐像素
   * shader 的填充量从 `dpr²` 砍到 `cap²`——这是缩放/平移时显卡占用飙升的主因
   * （高 dpr 屏尤甚）。缺省 undefined = 不封顶（导出走满分辨率，保阴影锐利）。
   */
  maxRenderScale?: number;
}

/**
 * 光照合成唯一入口（对外签名冻结：前三参不变，opts 可选）。
 *
 * ── 后端架构（M2 修订三，2026-07-05）───────────────────────────
 * 单一 Canvas2D 后端，无 WebGL。演进史（供后人别再走回头路）：
 *   1. 早期 M2 让含 glass/mirror 的场景整帧走 WebGL 逐像素 ray-march；
 *   2. 改成「普通场景 Canvas2D、镜面场景 WebGL」二选一路由——镜面仍飙 GPU；
 *   3. 改成「Canvas2D 出 base + WebGL 只出反射叠加层」——镜面**仍**飙 GPU。
 * 根因始终是：**只要镜面反射用逐像素 ray-march，就必然 per-pixel×per-edge×
 * per-light，随视口像素数爆炸**。换 GL/换分辨率/砍内层循环都只是拖延。
 *
 * 关键洞察（回答「镜面就只能忍受高 GPU 吗」——不）：镜面反射是**纯几何**
 * （虚像法：光源对镜面直线镜像得虚光源 L'，反射光等价于 L' 的直射，且反射
 * 保距 → 用「以 L' 为中心的径向衰减」表达亮度是物理精确的）。几何正是
 * Canvas2D 最擅长、且硬件加速的东西——和 M1 直接光同一套 radial-gradient +
 * 多边形裁剪机制，成本只随「镜面边 × 光源」数增长，与视口像素数无关。
 *
 * 因此 M2 定案：**ambient / 直接光 / 阴影 / 镜面反射全部走 Canvas2D**
 * （见 compositeLightingCanvas2D，反射由其中的 addMirrorReflections 段完成）。
 * 任何材质、任何场景都不飙 GPU、不留硬阴影暗楔。glass 走透光软阴影
 * （shadowStrengthFor），真实二维折射由 glassOptics 完成，环境镜面反射由
 * mirrorOptics 完成。WebGL 后端代码暂留仓库但已从渲染路径摘除（见 0015
 * 附录修订记录）；laser 继续使用有限 CPU 射线，不复活全屏 WebGL。
 */
export const compositeLighting = (
  ctx: CanvasRenderingContext2D,
  scene: LuminaScene,
  viewport: LuminaViewport,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  opts?: CompositeLightingOptions,
): void => {
  // 单一后端：ambient + 直接光 + 软阴影 + 镜面反射（虚像法）全在这里，纯
  // Canvas2D、不碰 GPU。maxRenderScale 对 Canvas2D 无意义（它本就按设备像素
  // 渲染、成本随边数而非像素数增长），保留在签名里只为对外冻结不变。
  compositeLightingCanvas2D(ctx, scene, viewport);
};

/**
 * 场景是否包含只有 WebGL 后端才能正确渲染的高级材质（glass/mirror）。
 * LightingCanvas 用它 + `isLuminaGLAvailable()` 决定是否弹一次性轻提示
 * 「高级材质需 WebGL」（0015 评审项 3）。
 */
export const sceneHasAdvancedMaterial = (scene: LuminaScene): boolean => {
  return scene.occluders.some(
    (o) => o.material === "glass" || o.material === "mirror",
  );
};

// 仅用于测试：导出内部纯几何函数。
export const __testing = {
  clipSegmentToCone,
  computeEdgeShadowQuad,
  computeSunShadowQuad,
  convexHull,
  intersectRects,
  parseColor,
  selectDirectShadowEdges,
  selectMirrorEdges,
  shadowStrengthFor,
};
