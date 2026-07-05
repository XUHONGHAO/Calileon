/**
 * C1 Lumina M2 WebGL2 shader 源码（GLSL ES 3.00）。
 *
 * 以 TS 字符串常量导出，避免引入 .glsl 加载器 / 打包插件——`@excalidraw/excalidraw`
 * 是发 npm 的库，shader 走字符串最省依赖（0015 D1 包体积红线的延伸）。
 *
 * 渲染模型（0015 D2/D3）：
 *  - 顶点：一个覆盖全屏的四边形（两个三角形），无需顶点缓冲，用 gl_VertexID 生成。
 *  - 片元：逐像素、逐光源做**解析 ray-segment 遮挡测试**（D3）。D2 的「ray-march
 *    步进」在硬阴影场景下由解析求交精确取代——求交是精确且比定步进更省的实现，
 *    故 M2 不设 march 步数 uniform（该旋钮被解析求交吸收，见开发日志）。
 *  - 材质在片元内分支：
 *      solid       命中即全遮挡（硬阴影）。
 *      translucent 命中按 opacity 部分透光（软化）。
 *      glass       命中高透光 + 可选焦散提亮（M2 近似：不做真实折射偏折，
 *                  真实偏折留 M3 激光）。
 *      mirror      直接光按遮挡处理；额外用「虚像法」注入一次反射贡献
 *                  （把光源对镜面所在直线做镜像，得到虚光源 L'，P 经镜面段
 *                  收到 L' 的光）——这是 M3 激光链式反射的算法地基。
 *      emissive    不到 shader：buildLuminaScene 已把它转成光源。
 *
 * 坐标：设备像素 = (场景坐标 + scroll) * zoom * scale。gl_FragCoord 原点在左下，
 * 而合成到 2D canvas（drawImage）时按左上，故片元里对 y 翻转后再换算场景坐标。
 */

/** 全屏四边形顶点着色器：用 gl_VertexID 生成，无需 attribute。 */
export const VERTEX_SHADER_SOURCE = `#version 300 es
precision highp float;

// 6 个顶点覆盖 [-1,1]^2 的两个三角形。
const vec2 POS[6] = vec2[6](
  vec2(-1.0, -1.0), vec2( 1.0, -1.0), vec2(-1.0,  1.0),
  vec2(-1.0,  1.0), vec2( 1.0, -1.0), vec2( 1.0,  1.0)
);

void main() {
  gl_Position = vec4(POS[gl_VertexID], 0.0, 1.0);
}
`;

/** 光照累积片元着色器。 */
export const FRAGMENT_SHADER_SOURCE = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

out vec4 fragColor;

uniform vec2  uResolution;   // 设备像素尺寸
uniform float uZoom;         // 场景→CSS 缩放
uniform float uScale;        // devicePixelRatio
uniform vec2  uScroll;       // scrollX, scrollY（场景单位）
uniform float uAmbient;      // 环境光 0..1
uniform bool  uCaustics;     // 是否开焦散

uniform sampler2D uEdges;    // RGBA32F 边数据纹理
uniform int uEdgeCount;      // 有效边数
uniform int uEdgeTexWidth;   // 纹理宽度（texel）
uniform bool uHasMirror;     // 场景是否含 mirror 材质；否则整段镜面 pass 跳过
uniform bool uReflectionOnly; // 仅渲染镜面反射叠加层（base 由 Canvas2D 后端产出）

#define MAX_LIGHTS 16
#define MAX_EDGE_ITER 1024   // 片元内边遍历硬上限（防极端场景卡死）

uniform int   uLightCount;
uniform vec2  uLightPos[MAX_LIGHTS];
uniform vec3  uLightColor[MAX_LIGHTS];
uniform float uLightIntensity[MAX_LIGHTS];
uniform float uLightRadius[MAX_LIGHTS];
uniform int   uLightType[MAX_LIGHTS];   // 0=point 1=spot 2=sun
uniform float uLightDir[MAX_LIGHTS];    // sun 传播方向（弧度）

// 材质枚举，与 packOccluders.ts 的 LUMINA_MATERIAL_CODE 对齐。
const float MAT_SOLID       = 0.0;
const float MAT_TRANSLUCENT = 1.0;
const float MAT_GLASS       = 2.0;
const float MAT_MIRROR      = 3.0;

// sun 的阴影投射假想远距离（场景单位）。
const float SUN_FAR = 100000.0;

struct Edge {
  vec2  a;
  vec2  b;
  float material;
  float opacity;
  float ior;
};

Edge fetchEdge(int i) {
  int t0 = i * 2;
  int t1 = t0 + 1;
  ivec2 c0 = ivec2(t0 % uEdgeTexWidth, t0 / uEdgeTexWidth);
  ivec2 c1 = ivec2(t1 % uEdgeTexWidth, t1 / uEdgeTexWidth);
  vec4 pts  = texelFetch(uEdges, c0, 0);
  vec4 meta = texelFetch(uEdges, c1, 0);
  Edge e;
  e.a = pts.xy;
  e.b = pts.zw;
  e.material = meta.x;
  e.opacity  = meta.y;
  e.ior      = meta.z;
  return e;
}

// 射线段(p→q) 与 边(a→b) 求交，返回沿 p→q 的参数 t（命中且 t∈(eps,1-eps) 时有效，
// 否则返回 -1）。用于遮挡：命中点必须严格落在 p 与 q 之间。
float raySegT(vec2 p, vec2 q, vec2 a, vec2 b) {
  vec2 r = q - p;
  vec2 s = b - a;
  float rxs = r.x * s.y - r.y * s.x;
  if (abs(rxs) < 1e-7) {
    return -1.0; // 平行/共线，忽略
  }
  vec2 pa = a - p;
  float t = (pa.x * s.y - pa.y * s.x) / rxs; // 沿 p→q
  float u = (pa.x * r.y - pa.y * r.x) / rxs; // 沿 a→b
  float eps = 1e-4;
  if (t > eps && t < 1.0 - eps && u >= 0.0 && u <= 1.0) {
    return t;
  }
  return -1.0;
}

// 计算 P 到某光源的**透光系数** transmission（0=全黑，1=无遮挡）。
// 遍历所有边做遮挡测试；mirror 在直接光里当实心处理。
float transmissionTo(vec2 P, vec2 Lp) {
  float trans = 1.0;
  int count = min(uEdgeCount, MAX_EDGE_ITER);
  for (int i = 0; i < MAX_EDGE_ITER; i++) {
    if (i >= count) { break; }
    Edge e = fetchEdge(i);
    float t = raySegT(P, Lp, e.a, e.b);
    if (t < 0.0) { continue; }
    if (e.material == MAT_TRANSLUCENT) {
      trans *= (1.0 - e.opacity * 0.75);
    } else if (e.material == MAT_GLASS) {
      // 玻璃：大部分透光；焦散开时命中不衰减（背后更亮），关时轻微衰减。
      trans *= uCaustics ? 1.0 : (1.0 - e.opacity * 0.15);
    } else {
      // solid / mirror：硬遮挡。
      trans *= (1.0 - e.opacity);
    }
    if (trans <= 0.001) { return 0.0; }
  }
  return trans;
}

// 距离衰减：point/spot 用半径内的平滑衰减；sun 恒为 1。
float attenuation(int type, float dist, float radius) {
  if (type == 2) {
    return 1.0; // sun：平行光不衰减
  }
  float x = clamp(1.0 - dist / max(radius, 1.0), 0.0, 1.0);
  return x * x;
}

// 单个光源对 P 的直接光贡献（含遮挡与衰减）。
vec3 directLight(int i, vec2 P) {
  int type = uLightType[i];
  vec3 col = uLightColor[i] * uLightIntensity[i];

  if (type == 2) {
    // sun：光沿 uLightDir 传播，遮挡射线朝 -传播方向射向远处。
    float ang = uLightDir[i];
    vec2 prop = vec2(cos(ang), sin(ang));
    vec2 Lp = P - prop * SUN_FAR;
    float trans = transmissionTo(P, Lp);
    return col * trans;
  }

  vec2 Lp = uLightPos[i];
  float dist = distance(P, Lp);
  float att = attenuation(type, dist, uLightRadius[i]);
  if (att <= 0.0) { return vec3(0.0); }
  float trans = transmissionTo(P, Lp);
  return col * att * trans;
}

// 镜面反射贡献（虚像法，0015 D2 mirror）：把光源对每条镜面边所在直线镜像，
// 得到虚光源 L'；若 P→L' 的连线穿过该镜面段，则 P 收到一次反射光。
// M2 只算一次弹射、且不追反射后路径上的二次遮挡（保守近似，为 M3 打地基）。
vec3 mirrorLight(int li, vec2 P) {
  int type = uLightType[li];
  if (type == 2) {
    return vec3(0.0); // sun 的镜像留待 M3，M2 只处理点/聚光的镜面高光
  }
  vec2 L = uLightPos[li];
  vec3 col = uLightColor[li] * uLightIntensity[li];
  vec3 acc = vec3(0.0);

  int count = min(uEdgeCount, MAX_EDGE_ITER);
  for (int i = 0; i < MAX_EDGE_ITER; i++) {
    if (i >= count) { break; }
    Edge e = fetchEdge(i);
    if (e.material != MAT_MIRROR) { continue; }

    vec2 d = e.b - e.a;
    float len2 = dot(d, d);
    if (len2 < 1e-6) { continue; }
    // 光源对镜面所在直线的镜像点 L'。
    vec2 ap = L - e.a;
    float proj = dot(ap, d) / len2;
    vec2 foot = e.a + d * proj;          // L 在直线上的垂足
    vec2 Lp = 2.0 * foot - L;            // 镜像虚光源

    // P→L' 是否穿过镜面段（命中即 P 能「看见」虚光源）。
    float t = raySegT(P, Lp, e.a, e.b);
    if (t < 0.0) { continue; }
    vec2 hit = P + (Lp - P) * t;         // 反射点（落在镜面段上）

    // 反射光走过的总距离 = P→反射点 + 反射点→真光源。
    float dist = distance(P, hit) + distance(hit, L);
    float att = attenuation(type, dist, uLightRadius[li]);
    if (att <= 0.0) { continue; }

    // 反射率 0.9（略有损耗）。M2 不再对「反射点→真光源」这段做二次遮挡测试：
    // 那是一个 O(edges) 的内层循环，把镜面 pass 推成 O(pixels×edges²) 的成本
    // 爆炸源（用户报告的镜面卡顿主因）。反射高光不追反射后路径的自遮挡是可接受
    // 的近似（真实链式反射遮挡留 M3 的 laser 光路求解）。
    acc += col * att * 0.9;
  }
  return acc;
}

void main() {
  // gl_FragCoord 原点左下；合成按左上，翻转 y 后换算场景坐标。
  vec2 frag = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
  vec2 P = frag / max(uZoom * uScale, 1e-4) - uScroll;

  // ── 反射叠加模式（当前 GL 后端的唯一用途，见 composite.ts 后端路由）──────
  // base 光照（ambient + 直接光 + 阴影）由丝滑的 Canvas2D 后端产出；GL 只算
  // 镜面反射高光，输出「黑底 + 反射色」，由 composite.ts 以 'lighter' 加到
  // Canvas2D 光照图上。跳过 ambient/直接光/阴影 → 逐像素成本只剩镜面 pass，
  // 从根上消除「逐像素全场景光照」的两大病灶：GPU 飙升 + 硬阴影纯 ambient 暗楔。
  if (uReflectionOnly) {
    vec3 refl = vec3(0.0);
    int rlc = min(uLightCount, MAX_LIGHTS);
    for (int i = 0; i < MAX_LIGHTS; i++) {
      if (i >= rlc) { break; }
      refl += mirrorLight(i, P);
    }
    // 黑底 + 加性反射色。'lighter' 合成下黑底是单位元（不改变 base）。
    fragColor = vec4(refl, 1.0);
    return;
  }

  // ── 完整 GL 光照路径（保留：未来可选「纯 GL」模式，当前不走）─────────────
  // 环境光底：unlit 处 = ambient（<1 则整体压暗），光源在其上叠加提亮。
  vec3 lightAccum = vec3(uAmbient);

  int lc = min(uLightCount, MAX_LIGHTS);
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= lc) { break; }
    lightAccum += directLight(i, P);
    // 镜面反射 pass 是第二遍逐边循环，成本翻倍。场景无 mirror 挡光体时
    // （常见情况）整段跳过，只在真有镜面时才付这笔算力。
    if (uHasMirror) {
      lightAccum += mirrorLight(i, P);
    }
  }

  // 输出为**不透明的「光照乘子」图**：屏幕层（LightingCanvas，CSS
  // mix-blend-mode:multiply）与导出层（ctx.globalCompositeOperation="multiply"）
  // 都以 multiply 合成到已画好的元素上——暗处压到 ambient，亮处保留原色，
  // 彩色光在此自然对元素着色。fallback（composite.ts）产出同一张 multiply 图，
  // 两后端视觉一致。multiply 不清空目标，天然修好 M1 导出会 clearRect 抹掉
  // 元素的隐患。
  fragColor = vec4(min(lightAccum, vec3(1.0)), 1.0);
}
`;
