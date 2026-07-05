import { API } from "./helpers/api";

import { buildLuminaScene } from "../renderer/lumina/scene";
import { __testing } from "../renderer/lumina/composite";
import {
  LUMINA_MATERIAL_CODE,
  OCCLUDER_TEX_WIDTH,
  TEXELS_PER_EDGE,
  packOccluders,
} from "../renderer/lumina/gl/packOccluders";

import type { LuminaEdge, LuminaOccluder } from "../renderer/lumina/scene";

import { arrayToMap } from "@excalidraw/common";

import type { NonDeletedExcalidrawElement } from "@excalidraw/element/types";

const {
  clipSegmentToCone,
  computeEdgeShadowQuad,
  computeSunShadowQuad,
  convexHull,
  intersectRects,
  parseColor,
  selectMirrorEdges,
  shadowStrengthFor,
} = __testing;

describe("Lumina rendering", () => {
  describe("parseColor", () => {
    it("parses #rrggbb", () => {
      expect(parseColor("#ff8000")).toEqual([255, 128, 0]);
    });

    it("parses #rgb shorthand", () => {
      expect(parseColor("#f80")).toEqual([255, 136, 0]);
    });

    it("falls back to white on garbage", () => {
      expect(parseColor("not-a-color")).toEqual([255, 255, 255]);
    });
  });

  describe("shadowStrengthFor", () => {
    it("solid casts full shadow at full opacity", () => {
      expect(
        shadowStrengthFor({
          id: "a",
          edges: [],
          material: "solid",
          opacity: 100,
          ior: 1.5,
        }),
      ).toBeCloseTo(1);
    });

    it("translucent casts a weaker shadow", () => {
      const s = shadowStrengthFor({
        id: "a",
        edges: [],
        material: "translucent",
        opacity: 100,
        ior: 1.5,
      });
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(1);
    });

    it("glass transmits most light (only a faint shadow)", () => {
      // M2 修订三：玻璃是透明的，不该像实心一样把光全挡住。它只投一层很淡的
      // 阴影（此前的 bug 是 glass fall-through 到 solid 的 return base，导致
      // 「玻璃对光的反应和实心一模一样」）。
      const s = shadowStrengthFor({
        id: "a",
        edges: [],
        material: "glass",
        opacity: 100,
        ior: 1.5,
      });
      expect(s).toBeGreaterThan(0); // 仍有一点点（折射/反射的粗略近似）
      expect(s).toBeLessThan(0.3); // 但远比实心淡
    });

    it("mirror stays opaque: full body shadow (reflection is added separately)", () => {
      // 镜面本体不透明（你看不透镜子），照样投完整硬阴影；额外的反射高光由
      // addMirrorReflections 用虚像法另加，不体现在 shadowStrengthFor。
      expect(
        shadowStrengthFor({
          id: "a",
          edges: [],
          material: "mirror",
          opacity: 100,
          ior: 1.5,
        }),
      ).toBeCloseTo(1);
    });

    it("emissive does not cast a shadow (it becomes a light upstream)", () => {
      expect(
        shadowStrengthFor({
          id: "a",
          edges: [],
          material: "emissive",
          opacity: 100,
          ior: 1.5,
        }),
      ).toBe(0);
    });
  });

  describe("convexHull", () => {
    it("returns hull of a square's corners", () => {
      const hull = convexHull([
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0.5, 0.5], // interior point should be dropped
      ]);
      expect(hull).toHaveLength(4);
      expect(hull).not.toContainEqual([0.5, 0.5]);
    });
  });

  describe("computeEdgeShadowQuad", () => {
    it("projects an edge's shadow away from the light", () => {
      const light = {
        id: "l",
        type: "point" as const,
        x: 0,
        y: 0,
        color: "#fff",
        intensity: 1,
        radius: 1000,
        castShadows: true,
      };
      // an edge from (10,10) to (20,10)
      const edge = [
        [10, 10],
        [20, 10],
      ] as const;
      const quad = computeEdgeShadowQuad(light, edge, 1000);
      // a quadrilateral: near A, near B, far B, far A
      expect(quad).toHaveLength(4);
      // near corners are the edge endpoints
      expect(quad[0]).toEqual([10, 10]);
      expect(quad[1]).toEqual([20, 10]);
      // far corners are projected further from the light than the edge
      const maxNear = Math.hypot(20, 10);
      expect(Math.hypot(quad[2][0], quad[2][1])).toBeGreaterThan(maxNear);
      expect(Math.hypot(quad[3][0], quad[3][1])).toBeGreaterThan(maxNear);
    });
  });

  describe("computeSunShadowQuad", () => {
    it("projects all corners along one parallel direction (not radially)", () => {
      // 光沿 +x 传播（direction=0）。两端点各自 +x 平移同一距离 → 平行带。
      const edge = [
        [10, 10],
        [10, 40],
      ] as const;
      const proj = 1000;
      const quad = computeSunShadowQuad(0, edge, proj);
      expect(quad).toHaveLength(4);
      // 近端两角 = 线段端点。
      expect(quad[0]).toEqual([10, 10]);
      expect(quad[1]).toEqual([10, 40]);
      // 远端两角 = 端点沿同一方向向量(+x)平移 proj。平移向量恒定 → 平行光。
      expect(quad[2][0]).toBeCloseTo(10 + proj);
      expect(quad[2][1]).toBeCloseTo(40);
      expect(quad[3][0]).toBeCloseTo(10 + proj);
      expect(quad[3][1]).toBeCloseTo(10);
      // 两条投影向量相等（平行）——这正是与点光源放射投影的区别。
      const v1 = [quad[3][0] - quad[0][0], quad[3][1] - quad[0][1]];
      const v2 = [quad[2][0] - quad[1][0], quad[2][1] - quad[1][1]];
      expect(v1[0]).toBeCloseTo(v2[0]);
      expect(v1[1]).toBeCloseTo(v2[1]);
    });
  });

  describe("clipSegmentToCone", () => {
    // 聚光锥：apex 在原点，轴向 +x（axis=0），半角 45°。
    const apexX = 0;
    const apexY = 0;
    const axis = 0;
    const half = Math.PI / 4;

    it("keeps a segment fully inside the cone unchanged", () => {
      // 线段整段在 +x 方向锥内（x=100，y 从 -50 到 50，都在 ±45° 内）。
      const clipped = clipSegmentToCone(
        100,
        -50,
        100,
        50,
        apexX,
        apexY,
        axis,
        half,
      );
      expect(clipped).not.toBeNull();
      expect(clipped![0]).toBeCloseTo(100);
      expect(clipped![1]).toBeCloseTo(-50);
      expect(clipped![2]).toBeCloseTo(100);
      expect(clipped![3]).toBeCloseTo(50);
    });

    it("returns null for a segment fully behind the light (outside the cone)", () => {
      // 灯背后（-x 方向）的镜面：整段在锥外 → null（不反光，本次修复的核心）。
      const clipped = clipSegmentToCone(
        -100,
        -50,
        -100,
        50,
        apexX,
        apexY,
        axis,
        half,
      );
      expect(clipped).toBeNull();
    });

    it("clips a segment that straddles the cone boundary", () => {
      // 线段 x=100，y 从 -300 到 300：中段在锥内(|y|<=100)，两端超出。
      // 裁剪后 |y| 应被夹到锥边界 ≈ ±100（x=100、半角45° → y=±x=±100）。
      const clipped = clipSegmentToCone(
        100,
        -300,
        100,
        300,
        apexX,
        apexY,
        axis,
        half,
      );
      expect(clipped).not.toBeNull();
      // 端点 x 不变。
      expect(clipped![0]).toBeCloseTo(100);
      expect(clipped![2]).toBeCloseTo(100);
      // y 被夹到 ±100（锥边界），不再是 ±300。
      expect(Math.abs(clipped![1])).toBeLessThanOrEqual(100.01);
      expect(Math.abs(clipped![3])).toBeLessThanOrEqual(100.01);
      expect(Math.abs(clipped![1])).toBeGreaterThan(50);
      expect(Math.abs(clipped![3])).toBeGreaterThan(50);
    });
  });

  describe("intersectRects", () => {
    it("returns the overlap of two intersecting rects", () => {
      const box = intersectRects(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 50, y: 50, width: 100, height: 100 },
      );
      expect(box).toEqual({ x: 50, y: 50, width: 50, height: 50 });
    });

    it("returns null when rects do not overlap", () => {
      expect(
        intersectRects(
          { x: 0, y: 0, width: 10, height: 10 },
          { x: 100, y: 100, width: 10, height: 10 },
        ),
      ).toBeNull();
    });

    it("returns null for edge-touching rects (zero-area overlap)", () => {
      // 仅边相接（右边缘 x=10 碰左边缘 x=10）→ 交集零宽 → null，避免画空框。
      expect(
        intersectRects(
          { x: 0, y: 0, width: 10, height: 10 },
          { x: 10, y: 0, width: 10, height: 10 },
        ),
      ).toBeNull();
    });

    it("returns the inner rect when one contains the other", () => {
      const box = intersectRects(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 20, y: 30, width: 10, height: 10 },
      );
      expect(box).toEqual({ x: 20, y: 30, width: 10, height: 10 });
    });
  });

  describe("selectMirrorEdges", () => {
    const mk = (
      ax: number,
      ay: number,
      bx: number,
      by: number,
    ) => ({ a: [ax, ay] as const, b: [bx, by] as const, opacity: 1 });

    it("returns all edges unchanged when under the limit", () => {
      const edges = [mk(0, 0, 1, 1), mk(2, 2, 3, 3)];
      const out = selectMirrorEdges(edges, 64);
      expect(out).toBe(edges); // 未超限：原样返回同一引用，顺序不变。
    });

    it("keeps the longest edges when over the limit (viewport-independent)", () => {
      // 取舍标准是边长（场景固定量），与视口无关——拖动画布不会改变保留集合。
      const short = mk(0, 0, 1, 0); // 长度 1
      const long = mk(0, 0, 1000, 0); // 长度 1000
      const out = selectMirrorEdges([short, long], 1);
      expect(out).toHaveLength(1);
      expect(out[0]).toBe(long);
    });

    it("keeps the same subset regardless of coordinates (no viewport drift)", () => {
      // 同一组边平移到任意位置，被保留的子集（按边长）必须一致——这正是修掉
      // 「拖动画布反射忽隐忽现」的关键：取舍不依赖坐标绝对位置。
      const edges = [mk(0, 0, 1, 0), mk(0, 0, 5, 0), mk(0, 0, 3, 0)];
      const shifted = edges.map((e) =>
        mk(e.a[0] + 9999, e.a[1] + 9999, e.b[0] + 9999, e.b[1] + 9999),
      );
      const outLen = (arr: ReturnType<typeof mk>[]) =>
        arr.map((e) => Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]));
      expect(outLen(selectMirrorEdges(edges, 2))).toEqual(
        outLen(selectMirrorEdges(shifted, 2)),
      );
    });

    it("truncates to exactly maxEdges", () => {
      const edges = Array.from({ length: 200 }, (_, i) =>
        mk(i, i, i + 1, i + 1),
      );
      expect(selectMirrorEdges(edges, 64)).toHaveLength(64);
    });
  });

  describe("buildLuminaScene", () => {
    it("separates light sources from occluders", () => {
      const rect = API.createElement({
        type: "rectangle",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      });
      const lightHost = API.createElement({
        type: "ellipse",
        x: 200,
        y: 200,
        width: 40,
        height: 40,
        customData: {
          luminaLight: {
            light: "point",
            color: "#ffeeaa",
            intensity: 1,
            castShadows: true,
          },
        },
      });
      const elements = [
        rect,
        lightHost,
      ] as NonDeletedExcalidrawElement[];
      const scene = buildLuminaScene(elements, arrayToMap(elements), {
        ambient: 0.5,
        caustics: false,
      });

      expect(scene.lights).toHaveLength(1);
      expect(scene.occluders).toHaveLength(1);
      expect(scene.lights[0].id).toBe(lightHost.id);
      expect(scene.occluders[0].id).toBe(rect.id);
      // occluder carries real geometry edges (a rectangle has >= 4 sides)
      expect(scene.occluders[0].edges.length).toBeGreaterThanOrEqual(4);
      // light host centre
      expect(scene.lights[0].x).toBeCloseTo(220);
      expect(scene.lights[0].y).toBeCloseTo(220);
      expect(scene.ambient).toBe(0.5);
    });

    it("reads material off occluders", () => {
      const rect = API.createElement({
        type: "rectangle",
        customData: { luminaMaterial: { material: "translucent" } },
      });
      const elements = [rect] as NonDeletedExcalidrawElement[];
      const scene = buildLuminaScene(elements, arrayToMap(elements), {
        ambient: 1,
        caustics: false,
      });
      expect(scene.occluders[0].material).toBe("translucent");
    });

    // ── M2 additions ──────────────────────────────────────────────

    it("carries default ior on non-glass occluders", () => {
      const rect = API.createElement({ type: "rectangle" });
      const elements = [rect] as NonDeletedExcalidrawElement[];
      const scene = buildLuminaScene(elements, arrayToMap(elements), {
        ambient: 1,
        caustics: false,
      });
      expect(scene.occluders[0].ior).toBeCloseTo(1.5);
    });

    it("carries explicit ior on glass occluders", () => {
      const rect = API.createElement({
        type: "rectangle",
        customData: { luminaMaterial: { material: "glass", ior: 2.2 } },
      });
      const elements = [rect] as NonDeletedExcalidrawElement[];
      const scene = buildLuminaScene(elements, arrayToMap(elements), {
        ambient: 1,
        caustics: false,
      });
      expect(scene.occluders[0].material).toBe("glass");
      expect(scene.occluders[0].ior).toBeCloseTo(2.2);
    });

    it("injects emissive material as a light, not an occluder (M2)", () => {
      const glow = API.createElement({
        type: "rectangle",
        x: 0,
        y: 0,
        width: 50,
        height: 50,
        strokeColor: "#00ff00",
        customData: {
          luminaMaterial: {
            material: "emissive",
            emissiveIntensity: 2,
          },
        },
      });
      const elements = [glow] as NonDeletedExcalidrawElement[];
      const scene = buildLuminaScene(elements, arrayToMap(elements), {
        ambient: 1,
        caustics: false,
      });
      // emissive becomes a light source, contributes no occluder
      expect(scene.occluders).toHaveLength(0);
      expect(scene.lights).toHaveLength(1);
      expect(scene.lights[0].intensity).toBe(2);
      // does not cast shadows (it emits, does not block)
      expect(scene.lights[0].castShadows).toBe(false);
    });

    it("emissive light defaults its color to the element strokeColor", () => {
      const glow = API.createElement({
        type: "rectangle",
        strokeColor: "#123456",
        customData: { luminaMaterial: { material: "emissive" } },
      });
      const elements = [glow] as NonDeletedExcalidrawElement[];
      const scene = buildLuminaScene(elements, arrayToMap(elements), {
        ambient: 1,
        caustics: false,
      });
      expect(scene.lights[0].color).toBe("#123456");
    });

    it("derives sun direction from host rotation; leaves point lights without one", () => {
      // 方向的唯一真相源是宿主元素的旋转角：direction = element.angle + π/2。
      // customData 里即便残留 direction 也被忽略（此处故意塞一个错值验证被无视）。
      const sun = API.createElement({
        type: "ellipse",
        angle: 0.5,
        customData: {
          luminaLight: {
            light: "sun",
            color: "#fff",
            intensity: 1,
            direction: 999,
            castShadows: true,
          },
        },
      });
      const point = API.createElement({
        type: "ellipse",
        customData: {
          luminaLight: {
            light: "point",
            color: "#fff",
            intensity: 1,
            castShadows: true,
          },
        },
      });
      const elements = [sun, point] as NonDeletedExcalidrawElement[];
      const scene = buildLuminaScene(elements, arrayToMap(elements), {
        ambient: 1,
        caustics: false,
      });
      const sunLight = scene.lights.find((l) => l.type === "sun")!;
      const pointLight = scene.lights.find((l) => l.type === "point")!;
      expect(sunLight.direction).toBeCloseTo(0.5 + Math.PI / 2);
      expect(pointLight.direction).toBeUndefined();
    });

    it("carries spot cone angle + host-rotation direction; point light has neither", () => {
      // 方向唯一真源是宿主元素旋转角：direction = element.angle + π/2。
      const spot = API.createElement({
        type: "ellipse",
        angle: 0.3 as NonDeletedExcalidrawElement["angle"],
        customData: {
          luminaLight: {
            light: "spot",
            color: "#fff",
            intensity: 1,
            angle: 0.5,
            castShadows: true,
          },
        },
      });
      const point = API.createElement({
        type: "ellipse",
        customData: {
          luminaLight: {
            light: "point",
            color: "#fff",
            intensity: 1,
            castShadows: true,
          },
        },
      });
      const elements = [spot, point] as NonDeletedExcalidrawElement[];
      const scene = buildLuminaScene(elements, arrayToMap(elements), {
        ambient: 1,
        caustics: false,
      });
      const spotLight = scene.lights.find((l) => l.type === "spot")!;
      const pointLight = scene.lights.find((l) => l.type === "point")!;
      // 锥轴方向 = 宿主旋转角 + π/2。
      expect(spotLight.direction).toBeCloseTo(0.3 + Math.PI / 2);
      // 锥半角仍从 customData 读。
      expect(spotLight.angle).toBeCloseTo(0.5);
      expect(pointLight.direction).toBeUndefined();
      expect(pointLight.angle).toBeUndefined();
    });

    it("defaults spot cone angle + direction when omitted", () => {
      const spot = API.createElement({
        type: "ellipse",
        customData: {
          luminaLight: {
            light: "spot",
            color: "#fff",
            intensity: 1,
            castShadows: true,
          },
        },
      });
      const elements = [spot] as NonDeletedExcalidrawElement[];
      const scene = buildLuminaScene(elements, arrayToMap(elements), {
        ambient: 1,
        caustics: false,
      });
      const spotLight = scene.lights.find((l) => l.type === "spot")!;
      // 锥半角缺省兜底 DEFAULT_LUMINA_SPOT_ANGLE(π/4)。
      expect(spotLight.angle).toBeCloseTo(Math.PI / 4);
      // 方向 = 宿主旋转角(缺省 0) + π/2。
      expect(spotLight.direction).toBeCloseTo(Math.PI / 2);
    });
  });

  describe("packOccluders", () => {
    it("returns an empty 1x1 texture for no occluders", () => {
      const packed = packOccluders([]);
      expect(packed.edgeCount).toBe(0);
      expect(packed.width).toBe(1);
      expect(packed.height).toBe(1);
      expect(packed.data).toHaveLength(4);
    });

    it("packs each edge into 2 texels with coords then material meta", () => {
      const packed = packOccluders([
        {
          id: "o1",
          edges: [
            [
              [10, 20],
              [30, 40],
            ],
          ],
          material: "glass",
          opacity: 80,
          ior: 1.7,
        },
      ]);
      expect(packed.edgeCount).toBe(1);
      // texel 0: endpoints
      expect(packed.data[0]).toBeCloseTo(10);
      expect(packed.data[1]).toBeCloseTo(20);
      expect(packed.data[2]).toBeCloseTo(30);
      expect(packed.data[3]).toBeCloseTo(40);
      // texel 1: materialCode (glass=2), opacity normalized 0..1, ior
      expect(packed.data[4]).toBe(LUMINA_MATERIAL_CODE.glass);
      expect(packed.data[5]).toBeCloseTo(0.8);
      expect(packed.data[6]).toBeCloseTo(1.7);
    });

    it("flattens edges across occluders and respects maxEdges", () => {
      const many: LuminaOccluder = {
        id: "o",
        edges: Array.from(
          { length: 10 },
          (_, i) =>
            [
              [i, i],
              [i + 1, i + 1],
            ] as LuminaEdge,
        ),
        material: "solid",
        opacity: 100,
        ior: 1.5,
      };
      const packed = packOccluders([many], 4);
      expect(packed.edgeCount).toBe(4);
    });

    it("keeps the signature stable when geometry/material is unchanged", () => {
      const occ: LuminaOccluder = {
        id: "o",
        edges: [
          [
            [0, 0],
            [10, 10],
          ],
        ],
        material: "solid",
        opacity: 100,
        ior: 1.5,
      };
      // 同样输入 → 同样签名（renderer 据此跳过纹理重传）。
      expect(packOccluders([occ]).signature).toBe(
        packOccluders([occ]).signature,
      );
    });

    it("changes the signature when occluder geometry changes", () => {
      const base: LuminaOccluder = {
        id: "o",
        edges: [
          [
            [0, 0],
            [10, 10],
          ],
        ],
        material: "solid",
        opacity: 100,
        ior: 1.5,
      };
      const moved: LuminaOccluder = {
        ...base,
        edges: [
          [
            [0, 0],
            [20, 10],
          ],
        ],
      };
      expect(packOccluders([base]).signature).not.toBe(
        packOccluders([moved]).signature,
      );
    });

    it("flags hasMirror only when a mirror occluder is present", () => {
      const solid: LuminaOccluder = {
        id: "s",
        edges: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
        material: "solid",
        opacity: 100,
        ior: 1.5,
      };
      const mirror: LuminaOccluder = { ...solid, id: "m", material: "mirror" };
      expect(packOccluders([solid]).hasMirror).toBe(false);
      expect(packOccluders([solid, mirror]).hasMirror).toBe(true);
    });
  });
});
