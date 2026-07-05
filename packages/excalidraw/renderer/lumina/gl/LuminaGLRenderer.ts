/**
 * C1 Lumina M2 WebGL2 renderer（0015 D1/D6）。
 *
 * 职责：持有一个**长驻**离屏 WebGL2 canvas + program + 边数据纹理，把一帧
 * LuminaScene 渲染成一张「光照乘子」图，供调用方 `drawImage` 合到 2D 目标上。
 *
 * 生命周期（0015 D6）：全局单例（见 backend.ts 的 getGLRenderer），跨帧、跨
 * 屏幕层/导出层复用同一 context 与 program——program 编译只发生一次，纹理按需
 * 重传。监听 webglcontextlost，丢失后标记不可用，由 backend 回落 Canvas2D。
 *
 * 裸 WebGL2、无第三方库（0015 D1 包体积红线）。所有 GL 样板收口在本类，
 * 调用方（composite.ts）只看到 `render(scene, viewport) → canvas | null`。
 */

import { packOccluders } from "./packOccluders";
import { FRAGMENT_SHADER_SOURCE, VERTEX_SHADER_SOURCE } from "./shaders";

import type { LuminaScene } from "../scene";
import type { LuminaViewport } from "../composite";

/** 与 shader 内 MAX_LIGHTS 保持一致。 */
const MAX_LIGHTS = 16;

/** 与 packOccluders 的 maxEdges 一致（片元 MAX_EDGE_ITER=1024，取更小值防卡）。 */
const MAX_EDGES = 1024;

/** 光源类型 → shader 整数枚举。 */
const LIGHT_TYPE_CODE: Record<string, number> = {
  point: 0,
  spot: 1,
  sun: 2,
};

/** 解析 #rgb / #rrggbb 为归一化 rgb（失败回退白）。 */
const parseColorNormalized = (color: string): [number, number, number] => {
  const hex = color.trim().replace(/^#/, "");
  const to = (s: string) => parseInt(s, 16) / 255;
  if (hex.length === 3) {
    const r = to(hex[0] + hex[0]);
    const g = to(hex[1] + hex[1]);
    const b = to(hex[2] + hex[2]);
    if (![r, g, b].some(Number.isNaN)) {
      return [r, g, b];
    }
  } else if (hex.length === 6) {
    const r = to(hex.slice(0, 2));
    const g = to(hex.slice(2, 4));
    const b = to(hex.slice(4, 6));
    if (![r, g, b].some(Number.isNaN)) {
      return [r, g, b];
    }
  }
  return [1, 1, 1];
};

export class LuminaGLRenderer {
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  private gl: WebGL2RenderingContext;
  private program: WebGLProgram;
  private edgeTexture: WebGLTexture;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private lost = false;

  // 边纹理变更检测：拖光源属性不改挡光体几何，命中即跳过 texImage2D 重传。
  // -1 是永不与 uint32 哈希碰撞的初始哨兵，保证首帧必上传一次。
  private edgeSignature = -1;
  private edgeTexWidth = 1;

  private constructor(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    gl: WebGL2RenderingContext,
  ) {
    this.canvas = canvas;
    this.gl = gl;

    // RGBA32F 渲染需要 float 纹理 + 可线性/最近采样。WebGL2 核心支持 float
    // 纹理采样（texelFetch 用不到过滤），无需 extension；但保险起见探测一次。
    gl.getExtension("EXT_color_buffer_float");

    this.program = this.buildProgram();
    this.edgeTexture = this.createEdgeTexture();
    this.cacheUniforms();

    const handleLost = (e: Event) => {
      e.preventDefault();
      this.lost = true;
    };
    // OffscreenCanvas 也支持事件监听；类型上用 any 兜住两种 canvas。
    (this.canvas as unknown as EventTarget).addEventListener?.(
      "webglcontextlost",
      handleLost as EventListener,
    );
  }

  /**
   * 尝试创建 renderer。WebGL2 不可用（老浏览器 / jsdom / 创建失败）时返回 null，
   * 由 backend 回落 Canvas2D（0015 D5）。
   */
  static tryCreate(): LuminaGLRenderer | null {
    try {
      const canvas = createGLCanvas(1, 1);
      if (!canvas) {
        return null;
      }
      const gl = canvas.getContext("webgl2", {
        premultipliedAlpha: false,
        antialias: false,
        depth: false,
        stencil: false,
      }) as WebGL2RenderingContext | null;
      if (!gl) {
        return null;
      }
      return new LuminaGLRenderer(canvas, gl);
    } catch {
      return null;
    }
  }

  /** context 是否已丢失/不可用。backend 据此决定是否回落。 */
  isLost(): boolean {
    return this.lost;
  }

  private buildProgram(): WebGLProgram {
    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SOURCE);
    const program = gl.createProgram();
    if (!program) {
      throw new Error("Lumina: failed to create program");
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Lumina: program link failed: ${log}`);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return program;
  }

  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) {
      throw new Error("Lumina: failed to create shader");
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Lumina: shader compile failed: ${log}`);
    }
    return shader;
  }

  private createEdgeTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) {
      throw new Error("Lumina: failed to create edge texture");
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // texelFetch 精确取纹素，用 NEAREST，无 mipmap。
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private cacheUniforms(): void {
    const gl = this.gl;
    const names = [
      "uResolution",
      "uZoom",
      "uScale",
      "uScroll",
      "uAmbient",
      "uCaustics",
      "uEdges",
      "uEdgeCount",
      "uEdgeTexWidth",
      "uHasMirror",
      "uReflectionOnly",
      "uLightCount",
      "uLightPos",
      "uLightColor",
      "uLightIntensity",
      "uLightRadius",
      "uLightType",
      "uLightDir",
    ];
    for (const name of names) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }
  }

  private resize(deviceWidth: number, deviceHeight: number): void {
    const w = Math.max(1, Math.floor(deviceWidth));
    const h = Math.max(1, Math.floor(deviceHeight));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  }

  /**
   * 渲染一帧光照到内部 gl canvas，返回该 canvas 供调用方 drawImage。
   * context 丢失或异常时返回 null，触发 backend 回落。
   */
  render(
    scene: LuminaScene,
    viewport: LuminaViewport,
    reflectionOnly = false,
  ): HTMLCanvasElement | OffscreenCanvas | null {
    if (this.lost) {
      return null;
    }
    const gl = this.gl;
    const { scale, zoom, scrollX, scrollY, width, height } = viewport;
    const deviceWidth = width * scale;
    const deviceHeight = height * scale;

    try {
      this.resize(deviceWidth, deviceHeight);

      // 边数据纹理：仅当挡光体几何/材质变化时才重传（texImage2D 是本 pass
      // 最贵的 CPU→GPU 拷贝之一）。拖光源属性只改 uniform，不动边，命中此缓存
      // 跳过重传——这是拖半径滑杆时显卡占用飙升的主因之一。
      const packed = packOccluders(scene.occluders, MAX_EDGES);
      gl.bindTexture(gl.TEXTURE_2D, this.edgeTexture);
      if (packed.signature !== this.edgeSignature) {
        gl.texImage2D(
          gl.TEXTURE_2D,
          0,
          gl.RGBA32F,
          packed.width,
          packed.height,
          0,
          gl.RGBA,
          gl.FLOAT,
          packed.data,
        );
        this.edgeSignature = packed.signature;
        this.edgeTexWidth = packed.width;
      }

      gl.useProgram(this.program);

      const u = this.uniforms;
      gl.uniform2f(u.uResolution ?? null, deviceWidth, deviceHeight);
      gl.uniform1f(u.uZoom ?? null, zoom);
      gl.uniform1f(u.uScale ?? null, scale);
      gl.uniform2f(u.uScroll ?? null, scrollX, scrollY);
      gl.uniform1f(u.uAmbient ?? null, scene.ambient);
      gl.uniform1i(u.uCaustics ?? null, scene.caustics ? 1 : 0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.edgeTexture);
      gl.uniform1i(u.uEdges ?? null, 0);
      gl.uniform1i(u.uEdgeCount ?? null, packed.edgeCount);
      gl.uniform1i(u.uEdgeTexWidth ?? null, this.edgeTexWidth);
      // 场景无镜面时关掉 shader 里第二个全屏 per-light×per-edge 反射循环，
      // 常见场景（无 mirror）片元成本直接减半。
      gl.uniform1i(u.uHasMirror ?? null, packed.hasMirror ? 1 : 0);
      // reflectionOnly：只渲染镜面反射叠加层（base 由 Canvas2D 后端产出），
      // shader 跳过 ambient+直接光+阴影循环，透明背景只留反射高光，供上层以
      // 'lighter' 叠加。这样镜面场景的 base 光照也走丝滑的 Canvas2D，WebGL
      // 只干它独有的反射，成本骤降。
      gl.uniform1i(u.uReflectionOnly ?? null, reflectionOnly ? 1 : 0);

      // 打包光源 uniform 数组。
      const lights = scene.lights.slice(0, MAX_LIGHTS);
      const posArr = new Float32Array(MAX_LIGHTS * 2);
      const colArr = new Float32Array(MAX_LIGHTS * 3);
      const intArr = new Float32Array(MAX_LIGHTS);
      const radArr = new Float32Array(MAX_LIGHTS);
      const typeArr = new Int32Array(MAX_LIGHTS);
      const dirArr = new Float32Array(MAX_LIGHTS);
      lights.forEach((light, i) => {
        posArr[i * 2] = light.x;
        posArr[i * 2 + 1] = light.y;
        const [r, g, b] = parseColorNormalized(light.color);
        colArr[i * 3] = r;
        colArr[i * 3 + 1] = g;
        colArr[i * 3 + 2] = b;
        intArr[i] = light.intensity;
        radArr[i] = light.radius;
        typeArr[i] = LIGHT_TYPE_CODE[light.type] ?? 0;
        dirArr[i] = light.direction ?? 0;
      });
      gl.uniform1i(u.uLightCount ?? null, lights.length);
      gl.uniform2fv(u.uLightPos ?? null, posArr);
      gl.uniform3fv(u.uLightColor ?? null, colArr);
      gl.uniform1fv(u.uLightIntensity ?? null, intArr);
      gl.uniform1fv(u.uLightRadius ?? null, radArr);
      gl.uniform1iv(u.uLightType ?? null, typeArr);
      gl.uniform1fv(u.uLightDir ?? null, dirArr);

      gl.drawArrays(gl.TRIANGLES, 0, 6);

      if (gl.isContextLost()) {
        this.lost = true;
        return null;
      }
      return this.canvas;
    } catch {
      this.lost = true;
      return null;
    }
  }

  /** 释放 GL 资源。多 Excalidraw 实例卸载或 HMR 时调用（0015 D6）。 */
  dispose(): void {
    const gl = this.gl;
    try {
      gl.deleteTexture(this.edgeTexture);
      gl.deleteProgram(this.program);
    } catch {
      // 忽略：context 可能已丢失。
    }
  }
}

/** 创建离屏 gl canvas，优先 OffscreenCanvas，回退 DOM canvas；都无则 null。 */
const createGLCanvas = (
  width: number,
  height: number,
): HTMLCanvasElement | OffscreenCanvas | null => {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  return null;
};
