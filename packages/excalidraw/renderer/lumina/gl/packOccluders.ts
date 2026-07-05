/**
 * 把挡光体的边列表打包进一张 RGBA32F 数据纹理的 CPU 侧缓冲（0015 D3）。
 *
 * 这是一个**纯函数**：只做 Float32Array 布局，不碰 WebGL，因此可在 jsdom 下
 * 单测纹理布局是否正确，不依赖 GPU。`LuminaGLRenderer` 拿到这份 buffer 后
 * 直接 `texImage2D` 上传，shader 端按同一布局用整数索引遍历取边。
 *
 * 布局（每条边占 2 个 texel，RGBA32F 每 texel 4 分量）：
 *   texel 0: [x1, y1, x2, y2]              两端点场景坐标
 *   texel 1: [materialCode, opacity, ior, _] 材质枚举 / 不透明度(0..1) / 折射率
 *
 * 纹理宽度固定为偶数（`OCCLUDER_TEX_WIDTH` texel），保证同一条边的 2 个 texel
 * 永远落在同一行（2*i 为偶数，2*i 与 2*i+1 必同行），shader 取边无需跨行判断。
 */

import type { LuminaMaterial } from "@excalidraw/element/lumina";
import type { LuminaOccluder } from "../scene";

/** 每条边占用的 texel 数（见文件头布局）。 */
export const TEXELS_PER_EDGE = 2;

/** 数据纹理宽度（texel 数），必须为偶数以避免单条边跨行。 */
export const OCCLUDER_TEX_WIDTH = 512;

/**
 * 材质 → shader 端整数枚举。shader 里以 float 比较分支。
 * 与 `packages/element/src/lumina/types.ts` 的 LuminaMaterial 一一对应。
 * emissive 在 buildLuminaScene 阶段已转成光源、不会作为 occluder 到此，
 * 但仍保留编码以防调用方直传。
 */
export const LUMINA_MATERIAL_CODE: Record<LuminaMaterial, number> = {
  solid: 0,
  translucent: 1,
  glass: 2,
  mirror: 3,
  emissive: 4,
};

export interface PackedOccluders {
  /** RGBA32F 数据，长度 = width * height * 4。 */
  data: Float32Array;
  /** 纹理宽度（texel）。 */
  width: number;
  /** 纹理高度（texel）。 */
  height: number;
  /** 打包进纹理的边总数。shader 以此为遍历上限（uniform）。 */
  edgeCount: number;
  /**
   * 内容签名：仅当边几何/材质变化时才变。renderer 用它决定是否重传纹理——
   * 拖光源属性不动挡光体，签名不变，跳过昂贵的 texImage2D。
   */
  signature: number;
  /** 是否含镜面挡光体。无镜面时 shader 跳过整个反射 pass（省一半开销）。 */
  hasMirror: boolean;
}

/** 一条打包用的边（含所属挡光体的材质/opacity/ior）。 */
interface FlatEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  materialCode: number;
  opacity: number;
  ior: number;
}

/**
 * 把 occluders 摊平成一维边列表。
 *
 * mirror 材质保留（M2 反射需要），emissive 已在上游转光源不会到此。
 * opacity 归一到 0..1（元素 opacity 是 0..100）。
 */
const flattenEdges = (occluders: readonly LuminaOccluder[]): FlatEdge[] => {
  const flat: FlatEdge[] = [];
  for (const occ of occluders) {
    const materialCode = LUMINA_MATERIAL_CODE[occ.material] ?? 0;
    const opacity = Math.max(0, Math.min(1, occ.opacity / 100));
    const ior = occ.ior > 0 ? occ.ior : 1.5;
    for (const edge of occ.edges) {
      flat.push({
        x1: edge[0][0],
        y1: edge[0][1],
        x2: edge[1][0],
        y2: edge[1][1],
        materialCode,
        opacity,
        ior,
      });
    }
  }
  return flat;
};

/**
 * 把边列表打包成数据纹理缓冲。
 *
 * 边数为 0 时返回一个 1x1 的空纹理（edgeCount=0），避免上传零尺寸纹理；
 * shader 见 edgeCount=0 直接跳过遮挡测试。
 *
 * @param maxEdges 可选硬上限，超出的边被丢弃（防止极端场景撑爆纹理）。
 */
export const packOccluders = (
  occluders: readonly LuminaOccluder[],
  maxEdges = 4096,
): PackedOccluders => {
  const flat = flattenEdges(occluders);
  const edgeCount = Math.min(flat.length, maxEdges);

  // 内容签名：对参与打包的边做一个便宜的 FNV-ish 累积哈希（含坐标/材质/opacity/
  // ior），只要挡光体几何或材质没变，签名就不变，renderer 据此跳过纹理重传。
  let signature = 0x811c9dc5;
  let hasMirror = false;
  const mix = (v: number) => {
    // 把浮点量化到整数再混入，避免 -0/NaN 等边角；乘 FNV prime 后取 32 位。
    signature ^= (v * 1000) | 0;
    signature = Math.imul(signature, 0x01000193);
  };
  for (let i = 0; i < edgeCount; i++) {
    const e = flat[i];
    mix(e.x1);
    mix(e.y1);
    mix(e.x2);
    mix(e.y2);
    mix(e.materialCode);
    mix(e.opacity);
    mix(e.ior);
    if (e.materialCode === LUMINA_MATERIAL_CODE.mirror) {
      hasMirror = true;
    }
  }
  signature = (signature >>> 0) ^ edgeCount;

  if (edgeCount === 0) {
    return {
      data: new Float32Array(4),
      width: 1,
      height: 1,
      edgeCount: 0,
      signature,
      hasMirror: false,
    };
  }

  const width = OCCLUDER_TEX_WIDTH;
  const texelsNeeded = edgeCount * TEXELS_PER_EDGE;
  const height = Math.ceil(texelsNeeded / width);
  const data = new Float32Array(width * height * 4);

  for (let i = 0; i < edgeCount; i++) {
    const e = flat[i];
    const base = i * TEXELS_PER_EDGE * 4; // 该边第 0 个 texel 的分量起点
    // texel 0: 两端点
    data[base + 0] = e.x1;
    data[base + 1] = e.y1;
    data[base + 2] = e.x2;
    data[base + 3] = e.y2;
    // texel 1: 材质 / opacity / ior
    data[base + 4] = e.materialCode;
    data[base + 5] = e.opacity;
    data[base + 6] = e.ior;
    data[base + 7] = 0;
  }

  return { data, width, height, edgeCount, signature, hasMirror };
};
