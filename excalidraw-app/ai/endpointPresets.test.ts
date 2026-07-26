import {
  ENDPOINT_PRESETS,
  GEMINI_NATIVE_ENDPOINTS,
  getPresetById,
  getPresetIdForConfig,
  NEWAPI_STYLE_ENDPOINTS,
  OPENAI_STANDARD_ENDPOINTS,
  RIGHT_CODE_ENDPOINTS,
  UNIFIED_JSON_ENDPOINTS,
  UNIFIED_JSON_FIELD_MAPPING,
} from "./endpointPresets";
import { migrateModelConfig } from "./config";

describe("AI image endpoint presets", () => {
  it("defines the built-in endpoint presets", () => {
    expect(ENDPOINT_PRESETS.map((preset) => preset.id)).toEqual([
      "openai-standard",
      "newapi-style",
      "unified-json",
      "gemini-native",
      "right-code",
      "custom",
    ]);
  });

  it("returns the OpenAI Standard preset", () => {
    expect(getPresetById("openai-standard")).toMatchObject({
      name: "OpenAI Standard",
      endpoints: {
        textToImage: { path: "/images/generations", format: "json" },
        imageToImage: { path: "/images/edits", format: "form" },
        inpaint: { path: "/images/edits", format: "form" },
      },
    });
  });

  it("returns the NewAPI Style preset", () => {
    expect(getPresetById("newapi-style")).toMatchObject({
      name: "NewAPI Style",
      endpoints: {
        textToImage: { path: "/images/generations", format: "json" },
        imageToImage: { path: "/images/generations", format: "json" },
        inpaint: { path: "/images/inpaint", format: "form" },
      },
    });
  });

  it("matches presets from endpoint and field mapping config", () => {
    expect(getPresetIdForConfig(OPENAI_STANDARD_ENDPOINTS)).toBe(
      "openai-standard",
    );
    expect(getPresetIdForConfig(NEWAPI_STYLE_ENDPOINTS)).toBe("newapi-style");
    expect(
      getPresetIdForConfig(UNIFIED_JSON_ENDPOINTS, UNIFIED_JSON_FIELD_MAPPING),
    ).toBe("unified-json");
    expect(getPresetIdForConfig(GEMINI_NATIVE_ENDPOINTS)).toBe("gemini-native");
    expect(getPresetIdForConfig(RIGHT_CODE_ENDPOINTS)).toBe("right-code");
    expect(
      getPresetIdForConfig({
        ...OPENAI_STANDARD_ENDPOINTS,
        textToImage: { path: "/v2/create", format: "json" },
      }),
    ).toBe("custom");
    // An otherwise-OpenAI config that flips `async` on must not match the
    // synchronous OpenAI Standard preset.
    expect(
      getPresetIdForConfig({
        ...OPENAI_STANDARD_ENDPOINTS,
        textToImage: {
          ...OPENAI_STANDARD_ENDPOINTS.textToImage,
          async: true,
        },
      }),
    ).toBe("custom");
  });

  it("migrates legacy model configs to OpenAI Standard endpoints", () => {
    expect(
      migrateModelConfig({
        id: "legacy",
        siteName: "Legacy",
        baseURL: "https://api.example.com/v1",
        apiKey: "sk-local-only",
        model: "gpt-image-1",
        label: "gpt-image-1",
        mediaType: "image",
        nativeModel: "other",
        capabilities: ["text-to-image"],
        requestTimeoutSeconds: 600,
      } as any),
    ).toMatchObject({
      id: "legacy",
      endpoints: OPENAI_STANDARD_ENDPOINTS,
    });
  });
});
