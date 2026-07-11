import { API } from "@excalidraw/excalidraw/tests/helpers/api";

import {
  getLuminaMaterial,
  getLuminaMaterialData,
  getLuminaLightData,
  getLuminaGameData,
  isLuminaLightSource,
  isLuminaGameRole,
  hasLuminaMaterial,
  hasLuminaGameData,
  normalizeLuminaMaterialData,
  normalizeLuminaIor,
  normalizeLuminaLightData,
  normalizeLuminaGameData,
  normalizeLuminaDarkRoomThreshold,
  DEFAULT_LUMINA_MATERIAL,
  DEFAULT_LUMINA_LIGHT_TYPE,
  DEFAULT_LUMINA_LIGHT_COLOR,
  DEFAULT_LUMINA_LIGHT_INTENSITY,
} from "../src/lumina";

import type {
  LuminaGameData,
  LuminaLightData,
  LuminaMaterialData,
} from "../src/lumina";

describe("lumina data model helpers", () => {
  describe("material", () => {
    it("returns default material for elements without lumina data", () => {
      const el = API.createElement({ type: "rectangle" });
      expect(getLuminaMaterial(el)).toBe(DEFAULT_LUMINA_MATERIAL);
      expect(getLuminaMaterialData(el)).toBeNull();
      expect(hasLuminaMaterial(el)).toBe(false);
    });

    it("reads a valid explicit material", () => {
      const el = API.createElement({
        type: "rectangle",
        customData: {
          luminaMaterial: { material: "glass", ior: 1.5 } as LuminaMaterialData,
        },
      });
      expect(getLuminaMaterial(el)).toBe("glass");
      expect(getLuminaMaterialData(el)?.ior).toBe(1.5);
      expect(hasLuminaMaterial(el)).toBe(true);
    });

    it("falls back to default for an invalid material string", () => {
      const el = API.createElement({
        type: "rectangle",
        customData: { luminaMaterial: { material: "bogus" } },
      });
      expect(getLuminaMaterial(el)).toBe(DEFAULT_LUMINA_MATERIAL);
      expect(hasLuminaMaterial(el)).toBe(false);
    });

    it("normalizes glass IOR into the supported range", () => {
      expect(normalizeLuminaIor(undefined)).toBe(1.5);
      expect(normalizeLuminaIor(Number.NaN)).toBe(1.5);
      expect(normalizeLuminaIor(0.5)).toBe(1);
      expect(normalizeLuminaIor(3)).toBe(2.5);
      expect(
        normalizeLuminaMaterialData({ material: "glass", ior: 1.33 }).ior,
      ).toBe(1.33);
    });
  });

  describe("light source", () => {
    it("treats elements without lumina data as non-light-sources", () => {
      const el = API.createElement({ type: "ellipse" });
      expect(isLuminaLightSource(el)).toBe(false);
      expect(getLuminaLightData(el)).toBeNull();
    });

    it("recognizes a valid light source", () => {
      const el = API.createElement({
        type: "ellipse",
        customData: {
          luminaLight: {
            light: "point",
            color: "#ffaa00",
            intensity: 2,
            castShadows: true,
          } as LuminaLightData,
        },
      });
      expect(isLuminaLightSource(el)).toBe(true);
      expect(getLuminaLightData(el)?.color).toBe("#ffaa00");
      expect(getLuminaLightData(el)?.intensity).toBe(2);
    });

    it("rejects a light source with an invalid light type", () => {
      const el = API.createElement({
        type: "ellipse",
        customData: { luminaLight: { light: "laser", color: "#fff" } },
      });
      expect(isLuminaLightSource(el)).toBe(false);
      expect(getLuminaLightData(el)).toBeNull();
    });
  });

  describe("material and light coexist on one element", () => {
    it("reads both independently", () => {
      const el = API.createElement({
        type: "ellipse",
        customData: {
          luminaMaterial: { material: "emissive" },
          luminaLight: {
            light: "point",
            color: "#fff",
            intensity: 1,
            castShadows: true,
          },
        },
      });
      expect(getLuminaMaterial(el)).toBe("emissive");
      expect(isLuminaLightSource(el)).toBe(true);
    });
  });

  describe("game data", () => {
    it("returns null for elements without lumina game data", () => {
      const el = API.createElement({ type: "rectangle" });
      expect(getLuminaGameData(el)).toBeNull();
      expect(hasLuminaGameData(el)).toBe(false);
      expect(isLuminaGameRole(el, "target")).toBe(false);
    });

    it("reads a valid game target role", () => {
      const el = API.createElement({
        type: "rectangle",
        customData: {
          luminaGame: {
            role: "target",
            required: true,
            tolerance: 24,
            puzzleId: "laser-1",
          } as LuminaGameData,
        },
      });
      expect(getLuminaGameData(el)?.role).toBe("target");
      expect(getLuminaGameData(el)?.tolerance).toBe(24);
      expect(hasLuminaGameData(el)).toBe(true);
      expect(isLuminaGameRole(el, "target")).toBe(true);
    });

    it("rejects an invalid game role defensively", () => {
      const el = API.createElement({
        type: "rectangle",
        customData: { luminaGame: { role: "artifact" } },
      });
      expect(getLuminaGameData(el)).toBeNull();
      expect(hasLuminaGameData(el)).toBe(false);
    });

    it("reads treasure roles and normalizes dark-room thresholds", () => {
      const el = API.createElement({
        type: "rectangle",
        customData: { luminaGame: { role: "treasure", tolerance: 0.6 } },
      });
      expect(getLuminaGameData(el)?.role).toBe("treasure");
      expect(isLuminaGameRole(el, "treasure")).toBe(true);
      expect(normalizeLuminaDarkRoomThreshold(0.6)).toBe(0.6);
      expect(normalizeLuminaDarkRoomThreshold(-1)).toBe(0);
      expect(normalizeLuminaDarkRoomThreshold(2)).toBe(1);
      expect(normalizeLuminaDarkRoomThreshold("bad")).toBe(0.35);
    });

    it("normalizeLuminaGameData preserves valid optional fields", () => {
      const data = normalizeLuminaGameData({
        role: "emitter",
        puzzleId: "p1",
        required: false,
        tolerance: 12,
        label: "A",
        meta: { maxBounces: 4 },
      });
      expect(data).toEqual({
        role: "emitter",
        puzzleId: "p1",
        required: false,
        tolerance: 12,
        label: "A",
        meta: { maxBounces: 4 },
      });
    });
  });

  describe("defensive reads", () => {
    it("handles null/undefined without throwing", () => {
      expect(getLuminaMaterial(null)).toBe(DEFAULT_LUMINA_MATERIAL);
      expect(getLuminaMaterial(undefined)).toBe(DEFAULT_LUMINA_MATERIAL);
      expect(isLuminaLightSource(null)).toBe(false);
      expect(getLuminaLightData(undefined)).toBeNull();
      expect(getLuminaGameData(undefined)).toBeNull();
    });
  });

  describe("normalizers", () => {
    it("normalizeLuminaMaterialData preserves material and extras", () => {
      const data = normalizeLuminaMaterialData({ material: "mirror" });
      expect(data.material).toBe("mirror");
    });

    it("normalizeLuminaLightData fills defaults", () => {
      const data = normalizeLuminaLightData();
      expect(data.light).toBe(DEFAULT_LUMINA_LIGHT_TYPE);
      expect(data.color).toBe(DEFAULT_LUMINA_LIGHT_COLOR);
      expect(data.intensity).toBe(DEFAULT_LUMINA_LIGHT_INTENSITY);
      expect(data.castShadows).toBe(true);
    });

    it("normalizeLuminaLightData respects provided values", () => {
      const data = normalizeLuminaLightData({
        light: "spot",
        intensity: 3,
        castShadows: false,
      });
      expect(data.light).toBe("spot");
      expect(data.intensity).toBe(3);
      expect(data.castShadows).toBe(false);
    });
  });
});
