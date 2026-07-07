import { STORAGE_KEYS } from "../app_constants";

import {
  DEFAULT_AI_MODEL_PROVIDER_PRESETS,
  DEFAULT_AI_IMAGE_REQUEST_TIMEOUT_SECONDS,
  loadAIImageConfig,
  parseModelIdListInput,
  parseModelListInput,
  saveAIImageConfig,
  serializeModelListInput,
} from "./config";
import { OPENAI_STANDARD_ENDPOINTS } from "./endpointPresets";

describe("AI image config", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("parses model list lines with labels and capabilities", () => {
    const models = parseModelListInput(
      "gpt-image-1 | GPT Image | text-to-image,image-to-image,inpaint\nseed-only",
    );

    expect(models).toEqual([
      {
        id: "gpt-image-1",
        siteName: "GPT Image",
        baseURL: "",
        apiKey: "",
        model: "gpt-image-1",
        label: "GPT Image",
        mediaType: "image",
        nativeModel: "other",
        capabilities: ["text-to-image", "image-to-image", "inpaint"],
        endpoints: OPENAI_STANDARD_ENDPOINTS,
        requestTimeoutSeconds: DEFAULT_AI_IMAGE_REQUEST_TIMEOUT_SECONDS,
      },
      {
        id: "seed-only",
        siteName: "seed-only",
        baseURL: "",
        apiKey: "",
        model: "seed-only",
        label: "seed-only",
        mediaType: "image",
        nativeModel: "other",
        capabilities: [
          "text-to-image",
          "negative-prompt",
          "seed",
          "quality",
          "style",
        ],
        endpoints: OPENAI_STANDARD_ENDPOINTS,
        requestTimeoutSeconds: DEFAULT_AI_IMAGE_REQUEST_TIMEOUT_SECONDS,
      },
    ]);
  });

  it("parses multiple model IDs from editor input", () => {
    expect(
      parseModelIdListInput(
        "gemini-3.0-pro-image\ngemini-3.1-flash-image; gpt-image-2, gpt-image-2",
      ),
    ).toEqual([
      "gemini-3.0-pro-image",
      "gemini-3.1-flash-image",
      "gpt-image-2",
    ]);
  });

  it("round-trips provider config through localStorage", () => {
    const savedConfig = saveAIImageConfig({
      baseURL: " https://api.example.com/v1 ",
      apiKey: "sk-local-only",
      defaultModel: "gpt-image-1",
      models: parseModelListInput(
        "gpt-image-1 | GPT Image | text-to-image,negative-prompt",
      ),
    });

    expect(savedConfig.baseURL).toBe("https://api.example.com/v1");
    expect(savedConfig.models[0]).toMatchObject({
      baseURL: "https://api.example.com/v1",
      apiKey: "sk-local-only",
      model: "gpt-image-1",
      siteName: "GPT Image",
      nativeModel: "other",
      requestTimeoutSeconds: DEFAULT_AI_IMAGE_REQUEST_TIMEOUT_SECONDS,
    });
    expect(loadAIImageConfig()).toEqual(savedConfig);
    expect(
      JSON.parse(
        localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_AI_IMAGE) || "{}",
      ).version,
    ).toBe(1);
  });

  it("normalizes per-model request timeout seconds", () => {
    const savedConfig = saveAIImageConfig({
      baseURL: "",
      apiKey: "",
      defaultModel: "gpt-image-1",
      models: [
        {
          ...parseModelListInput("gpt-image-1 | GPT Image")[0],
          requestTimeoutSeconds: 90.6,
        },
      ],
    });

    expect(savedConfig.models[0].requestTimeoutSeconds).toBe(91);
    expect(loadAIImageConfig().models[0].requestTimeoutSeconds).toBe(91);
  });

  it("serializes models back to editable text", () => {
    const models = parseModelListInput(
      "gpt-image-1 | GPT Image | text-to-image,inpaint",
    );

    expect(serializeModelListInput(models)).toBe(
      "gpt-image-1 | GPT Image | text-to-image,inpaint",
    );
  });

  it("does not serialize default capabilities back into the model input", () => {
    expect(serializeModelListInput(parseModelListInput("seed-only"))).toBe(
      "seed-only",
    );
  });

  it("parses a compact model label without treating it as capabilities", () => {
    expect(parseModelListInput("gpt-image-1 | GPT Image")).toEqual([
      {
        id: "gpt-image-1",
        siteName: "GPT Image",
        baseURL: "",
        apiKey: "",
        model: "gpt-image-1",
        label: "GPT Image",
        mediaType: "image",
        nativeModel: "other",
        capabilities: [
          "text-to-image",
          "negative-prompt",
          "seed",
          "quality",
          "style",
        ],
        endpoints: OPENAI_STANDARD_ENDPOINTS,
        requestTimeoutSeconds: DEFAULT_AI_IMAGE_REQUEST_TIMEOUT_SECONDS,
      },
    ]);
  });

  it("parses video and audio model cards from compact text", () => {
    expect(
      parseModelListInput(
        "veo | Veo | video | text-to-video,duration; suno | audio",
      ),
    ).toEqual([
      {
        id: "veo",
        siteName: "Veo",
        baseURL: "",
        apiKey: "",
        model: "veo",
        label: "Veo",
        mediaType: "video",
        capabilities: ["text-to-video", "duration"],
        endpoints: OPENAI_STANDARD_ENDPOINTS,
        requestTimeoutSeconds: DEFAULT_AI_IMAGE_REQUEST_TIMEOUT_SECONDS,
      },
      {
        id: "suno",
        siteName: "suno",
        baseURL: "",
        apiKey: "",
        model: "suno",
        label: "suno",
        mediaType: "audio",
        capabilities: ["text-to-audio", "duration", "audio-format", "voice"],
        endpoints: OPENAI_STANDARD_ENDPOINTS,
        requestTimeoutSeconds: DEFAULT_AI_IMAGE_REQUEST_TIMEOUT_SECONDS,
      },
    ]);
  });

  it("exposes one-click provider presets without bundled API keys", () => {
    expect(DEFAULT_AI_MODEL_PROVIDER_PRESETS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "zhichuang-aggregation",
          siteName: "智创聚合",
          baseURL: "https://n.lconai.com/v1",
          model: "gpt-image-2",
          endpointPresetId: "openai-standard",
        }),
        expect.objectContaining({
          id: "pic2api",
          siteName: "pic2api API",
          baseURL: "https://www.pic2api.com/v1",
          model: "gemini-3.0-pro-image",
          endpointPresetId: "openai-standard",
        }),
        expect.objectContaining({
          id: "duoyuanx",
          siteName: "多元探索",
          baseURL: "https://duoyuanx.com/v1",
          model: "gpt-image-2",
          endpointPresetId: "openai-standard",
        }),
      ]),
    );
    expect(
      DEFAULT_AI_MODEL_PROVIDER_PRESETS.every(
        (preset) => !("apiKey" in preset),
      ),
    ).toBe(true);
  });
});
