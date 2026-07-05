import { API } from "@excalidraw/excalidraw/tests/helpers/api";

import {
  getLuminaMaterial,
  getLuminaMaterialData,
  getLuminaLightData,
  isLuminaLightSource,
  hasLuminaMaterial,
  normalizeLuminaMaterialData,
  normalizeLuminaLightData,
  DEFAULT_LUMINA_MATERIAL,
  DEFAULT_LUMINA_LIGHT_TYPE,
  DEFAULT_LUMINA_LIGHT_COLOR,
  DEFAULT_LUMINA_LIGHT_INTENSITY,
} from "../src/lumina";

import type { LuminaLightData, LuminaMaterialData } from "../src/lumina";

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

  describe("defensive reads", () => {
    it("handles null/undefined without throwing", () => {
      expect(getLuminaMaterial(null)).toBe(DEFAULT_LUMINA_MATERIAL);
      expect(getLuminaMaterial(undefined)).toBe(DEFAULT_LUMINA_MATERIAL);
      expect(isLuminaLightSource(null)).toBe(false);
      expect(getLuminaLightData(undefined)).toBeNull();
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
