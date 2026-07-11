import type { DataURL } from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/element/types";

import {
  AIImageGenerationError,
  buildEndpointURL,
  buildFormDataRequestBody,
  buildGeminiNativeRequestBody,
  buildImageEditBody,
  buildJSONRequestBody,
  buildOpenAIImageEndpoint,
  buildTextToImageBody,
  generateImagesWithOpenAIAdapter,
  getEndpointConfigForMode,
} from "./openAIImageAdapter";
import {
  GEMINI_NATIVE_ENDPOINTS,
  NEWAPI_STYLE_ENDPOINTS,
  OPENAI_STANDARD_ENDPOINTS,
  UNIFIED_JSON_ENDPOINTS,
} from "./endpointPresets";

import type { AIImageGenerationRequest, AIImageSourceEnhanced } from "./types";

const baseRequest: AIImageGenerationRequest = {
  config: {
    baseURL: "https://api.example.com/v1",
    apiKey: "sk-local-only",
    defaultModel: "gpt-image-1",
    models: [],
  },
  mode: "text-to-image",
  model: "gpt-image-1",
  prompt: "a small library",
  negativePrompt: "blur",
  params: {
    size: "1024x1024",
    n: 1,
    seed: 7,
    quality: "auto",
    style: "natural",
  },
};

describe("OpenAI-compatible image adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds generation and edit endpoints from the configured base URL", () => {
    expect(
      buildOpenAIImageEndpoint("https://api.example.com/v1/", "text-to-image"),
    ).toBe("https://api.example.com/v1/images/generations");
    expect(
      buildOpenAIImageEndpoint("https://api.example.com/v1/", "image-to-image"),
    ).toBe("https://api.example.com/v1/images/edits");
    expect(
      buildOpenAIImageEndpoint(
        "https://api.example.com/v1/images/generations",
        "text-to-image",
      ),
    ).toBe("https://api.example.com/v1/images/generations");
    expect(
      buildOpenAIImageEndpoint(
        "https://api.example.com/v1/images/generations",
        "image-to-image",
      ),
    ).toBe("https://api.example.com/v1/images/edits");
  });

  it("builds custom endpoint URLs from model endpoint config", () => {
    expect(
      buildEndpointURL("https://api.example.com/v1/", {
        path: "/custom/generate",
        format: "json",
      }),
    ).toBe("https://api.example.com/v1/custom/generate");
    expect(
      buildEndpointURL("https://api.example.com/v1/images/generations", {
        path: "images/edits",
        format: "form",
      }),
    ).toBe("https://api.example.com/v1/images/edits");
    expect(
      buildEndpointURL(
        "https://www.pic2api.com/v1beta",
        {
          path: "/models/{model}:generateContent",
          format: "gemini",
        },
        "gemini-3.0-pro-image",
      ),
    ).toBe(
      "https://www.pic2api.com/v1beta/models/gemini-3.0-pro-image:generateContent",
    );
  });

  it("resolves endpoint config for each image mode", () => {
    const model = {
      endpoints: NEWAPI_STYLE_ENDPOINTS,
    };

    expect(getEndpointConfigForMode(model, "text-to-image")).toEqual({
      path: "/images/generations",
      format: "json",
    });
    expect(getEndpointConfigForMode(model, "image-to-image")).toEqual({
      path: "/images/generations",
      format: "json",
    });
    expect(getEndpointConfigForMode(model, "inpaint")).toEqual({
      path: "/images/inpaint",
      format: "form",
    });
  });

  it("builds text-to-image JSON without copying provider secrets", () => {
    const body = buildTextToImageBody({
      ...baseRequest,
      model: "sd3-medium",
    });

    expect(body).toMatchObject({
      model: "sd3-medium",
      prompt: "a small library",
      negative_prompt: "blur",
      n: 1,
      size: "1024x1024",
      response_format: "b64_json",
      seed: 7,
      quality: "auto",
      style: "natural",
    });
    expect(JSON.stringify(body)).not.toContain("sk-local-only");
  });

  it("omits response_format for gpt-image models on the openai-compatible path", () => {
    const body = buildTextToImageBody({
      ...baseRequest,
      model: "gpt-image-2",
    });

    expect(body.response_format).toBeUndefined();
    expect(body).toMatchObject({
      model: "gpt-image-2",
      prompt: "a small library",
      n: 1,
      size: "1024x1024",
    });

    const formData = buildImageEditBody({
      ...baseRequest,
      mode: "image-to-image",
      model: "gpt-image-2",
      sources: [
        {
          elementId: "element-a",
          fileId: "file-a" as FileId,
          dataURL: "data:image/png;base64,AAA" as DataURL,
          file: new File(["image"], "reference.png", { type: "image/png" }),
        },
      ],
    });

    expect(formData.get("response_format")).toBeNull();
    expect(formData.get("model")).toBe("gpt-image-2");
  });

  it("builds JSON request bodies with field mapping and base64 images", () => {
    const image = new File(["image"], "reference.png", { type: "image/png" });
    const body = buildJSONRequestBody(
      {
        ...baseRequest,
        mode: "image-to-image",
        sources: [
          {
            elementId: "element-a",
            fileId: "file-a" as FileId,
            dataURL: "data:image/png;base64,AAA" as DataURL,
            file: image,
          },
        ],
      },
      {
        prompt: "text",
        model: "engine",
        image: "init_image",
        n: "num_images",
      },
    );

    expect(body).toMatchObject({
      engine: "gpt-image-1",
      text: "a small library",
      init_image: "AAA",
      num_images: 1,
    });
    expect(body.model).toBeUndefined();
    expect(body.prompt).toBeUndefined();
    expect(body.image).toBeUndefined();
  });

  it("builds Gemini native JSON request bodies with inline images", () => {
    const image = new File(["image"], "reference.png", { type: "image/png" });
    const body = buildGeminiNativeRequestBody({
      ...baseRequest,
      mode: "image-to-image",
      params: {
        ...baseRequest.params,
        aspectRatio: "16:9",
        resolution: "2k",
      },
      sources: [
        {
          elementId: "element-a",
          fileId: "file-a" as FileId,
          dataURL: "data:image/png;base64,AAA" as DataURL,
          file: image,
        },
      ],
    });

    expect(body).toEqual({
      contents: [
        {
          role: "user",
          parts: [
            { text: "a small library" },
            {
              inline_data: {
                mime_type: "image/png",
                data: "AAA",
              },
            },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        aspectRatio: "16:9",
        resolution: "2k",
      },
    });
  });

  it("includes per-reference weights when a source overrides global strength", () => {
    const imageA = new File(["image-a"], "reference-a.png", {
      type: "image/png",
    });
    const imageB = new File(["image-b"], "reference-b.png", {
      type: "image/png",
    });
    const sources: AIImageSourceEnhanced[] = [
      {
        index: 1,
        elementId: "element-a",
        elementIds: ["element-a"],
        fileId: "file-a" as FileId,
        dataURL: "data:image/png;base64,AAA" as DataURL,
        file: imageA,
        sourceType: "imported",
        weight: 0.8,
        createdAt: 1,
      },
      {
        index: 2,
        elementId: "element-b",
        elementIds: ["element-b"],
        fileId: "file-b" as FileId,
        dataURL: "data:image/png;base64,BBB" as DataURL,
        file: imageB,
        sourceType: "canvas",
        createdAt: 2,
      },
    ];
    const request = {
      ...baseRequest,
      mode: "image-to-image" as const,
      params: {
        ...baseRequest.params,
        referenceStrength: 0.4,
      },
      sources,
    };

    expect(buildJSONRequestBody(request).reference_weights).toEqual([0.8, 0.4]);
    expect(buildFormDataRequestBody(request).get("reference_weights")).toBe(
      "[0.8,0.4]",
    );
  });

  it("builds LConAI text-to-image JSON from documented fields only", () => {
    const body = buildTextToImageBody(
      {
        ...baseRequest,
        model: "gpt-image-2",
        negativePrompt: "blur",
        params: {
          ...baseRequest.params,
          seed: 12,
          quality: "auto",
          style: "natural",
        },
      },
      "lconai",
    );

    expect(body).toEqual({
      model: "gpt-image-2",
      prompt: "a small library",
      n: 1,
      size: "1024x1024",
      response_format: "b64_json",
    });
  });

  it("builds image edit FormData with references and mask", () => {
    const image = new File(["image"], "reference.png", { type: "image/png" });
    const mask = new File(["mask"], "mask.png", { type: "image/png" });
    const formData = buildImageEditBody({
      ...baseRequest,
      mode: "inpaint",
      params: { ...baseRequest.params, referenceStrength: 0.4 },
      sources: [
        {
          elementId: "element-a",
          fileId: "file-a" as FileId,
          dataURL: "data:image/png;base64,AAA" as DataURL,
          file: image,
        },
      ],
      mask: {
        dataURL: "data:image/png;base64,BBB" as DataURL,
        file: mask,
      },
    });

    expect(formData.get("model")).toBe("gpt-image-1");
    expect(formData.get("prompt")).toBe("a small library");
    expect(formData.get("reference_strength")).toBe("0.4");
    expect(formData.getAll("image")).toHaveLength(1);
    expect(formData.get("mask")).toMatchObject({
      name: "mask.png",
      type: "image/png",
    });
  });

  it("builds LConAI image edit FormData with indexed multi-image fields", () => {
    const firstImage = new File(["first"], "first.png", { type: "image/png" });
    const secondImage = new File(["second"], "second.png", {
      type: "image/png",
    });
    const formData = buildImageEditBody(
      {
        ...baseRequest,
        mode: "image-to-image",
        model: "gpt-image-2",
        negativePrompt: "blur",
        params: { ...baseRequest.params, referenceStrength: 0.4 },
        sources: [
          {
            elementId: "element-a",
            fileId: "file-a" as FileId,
            dataURL: "data:image/png;base64,AAA" as DataURL,
            file: firstImage,
          },
          {
            elementId: "element-b",
            fileId: "file-b" as FileId,
            dataURL: "data:image/png;base64,BBB" as DataURL,
            file: secondImage,
          },
        ],
      },
      "lconai",
    );

    expect(formData.get("model")).toBe("gpt-image-2");
    expect(formData.get("prompt")).toBe("a small library");
    expect(formData.get("response_format")).toBe("b64_json");
    expect(formData.get("image")).toBeNull();
    expect(formData.get("image[0]")).toMatchObject({
      name: "first.png",
      type: "image/png",
    });
    expect(formData.get("image[1]")).toMatchObject({
      name: "second.png",
      type: "image/png",
    });
    expect(formData.get("negative_prompt")).toBeNull();
    expect(formData.get("reference_strength")).toBeNull();
  });

  it("builds FormData request bodies with custom field names", () => {
    const image = new File(["image"], "reference.png", { type: "image/png" });
    const mask = new File(["mask"], "mask.png", { type: "image/png" });
    const formData = buildFormDataRequestBody(
      {
        ...baseRequest,
        mode: "inpaint",
        sources: [
          {
            elementId: "element-a",
            fileId: "file-a" as FileId,
            dataURL: "data:image/png;base64,AAA" as DataURL,
            file: image,
          },
        ],
        mask: {
          dataURL: "data:image/png;base64,BBB" as DataURL,
          file: mask,
        },
      },
      {
        prompt: "text",
        image: "init_image",
        mask: "mask_image",
      },
    );

    expect(formData.get("text")).toBe("a small library");
    expect(formData.get("prompt")).toBeNull();
    expect(formData.get("init_image")).toMatchObject({
      name: "reference.png",
      type: "image/png",
    });
    expect(formData.get("image")).toBeNull();
    expect(formData.get("mask_image")).toMatchObject({
      name: "mask.png",
      type: "image/png",
    });
    expect(formData.get("mask")).toBeNull();
  });

  it("returns b64 image outputs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            data: [{ b64_json: "AAA", revised_prompt: "revised" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    await expect(generateImagesWithOpenAIAdapter(baseRequest)).resolves.toEqual(
      [
        {
          dataURL: "data:image/png;base64,AAA",
          mimeType: "image/png",
          revisedPrompt: "revised",
        },
      ],
    );
  });

  it("uses the selected model card connection", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [{ b64_json: "AAA" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    await generateImagesWithOpenAIAdapter({
      ...baseRequest,
      config: {
        baseURL: "",
        apiKey: "",
        defaultModel: "model-card-1",
        models: [
          {
            id: "model-card-1",
            siteName: "Local API",
            baseURL: "https://card.example.com/v1",
            apiKey: "sk-card-only",
            model: "gpt-image-1",
            label: "gpt-image-1",
            mediaType: "image",
            capabilities: ["text-to-image"],
            endpoints: OPENAI_STANDARD_ENDPOINTS,
            requestTimeoutSeconds: 600,
          },
        ],
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://card.example.com/v1/images/generations",
      expect.any(Object),
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect((init.headers as Headers).get("Authorization")).toBe(
      "Bearer sk-card-only",
    );
  });

  it("uses LConAI raw Authorization header without Bearer prefix", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [{ b64_json: "AAA" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    await generateImagesWithOpenAIAdapter({
      ...baseRequest,
      config: {
        baseURL: "https://n.lconai.com/v1",
        apiKey: "sk-lconai-local",
        defaultModel: "gpt-image-2",
        models: [],
      },
      model: "gpt-image-2",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://n.lconai.com/v1/images/generations",
      expect.any(Object),
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect((init.headers as Headers).get("Authorization")).toBe(
      "sk-lconai-local",
    );
  });

  it("uses NewAPI Style JSON endpoint config for reference image requests", async () => {
    const image = new File(["image"], "reference.png", { type: "image/png" });
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [{ b64_json: "AAA" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    await generateImagesWithOpenAIAdapter({
      ...baseRequest,
      config: {
        baseURL: "",
        apiKey: "",
        defaultModel: "newapi-card",
        models: [
          {
            id: "newapi-card",
            siteName: "NewAPI",
            baseURL: "https://newapi.example.com/v1",
            apiKey: "sk-newapi",
            model: "gpt-image-1",
            label: "gpt-image-1",
            mediaType: "image",
            capabilities: ["image-to-image"],
            endpoints: NEWAPI_STYLE_ENDPOINTS,
            requestTimeoutSeconds: 600,
          },
        ],
      },
      mode: "image-to-image",
      model: "newapi-card",
      sources: [
        {
          elementId: "element-a",
          fileId: "file-a" as FileId,
          dataURL: "data:image/png;base64,AAA" as DataURL,
          file: image,
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://newapi.example.com/v1/images/generations",
      expect.any(Object),
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];

    expect((init.headers as Headers).get("Content-Type")).toBe(
      "application/json",
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "gpt-image-1",
      prompt: "a small library",
      image: "AAA",
    });
  });

  it("uses Unified JSON field mapping when configured on the model", async () => {
    const image = new File(["image"], "reference.png", { type: "image/png" });
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          images: [{ base64: "BBB" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    await generateImagesWithOpenAIAdapter({
      ...baseRequest,
      config: {
        baseURL: "",
        apiKey: "",
        defaultModel: "unified-card",
        models: [
          {
            id: "unified-card",
            siteName: "Unified",
            baseURL: "https://unified.example.com/v1",
            apiKey: "sk-unified",
            model: "gpt-image-1",
            label: "gpt-image-1",
            mediaType: "image",
            capabilities: ["image-to-image"],
            endpoints: UNIFIED_JSON_ENDPOINTS,
            fieldMapping: {
              prompt: "text",
              image: "init_image",
            },
            requestTimeoutSeconds: 600,
          },
        ],
      },
      mode: "image-to-image",
      model: "unified-card",
      sources: [
        {
          elementId: "element-a",
          fileId: "file-a" as FileId,
          dataURL: "data:image/png;base64,AAA" as DataURL,
          file: image,
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://unified.example.com/v1/images/create",
      expect.any(Object),
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];

    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "gpt-image-1",
      text: "a small library",
      init_image: "AAA",
    });
    expect(JSON.parse(init.body as string).prompt).toBeUndefined();
    expect(JSON.parse(init.body as string).image).toBeUndefined();
  });

  it("uses Gemini native endpoint config and API key header", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: "image/png",
                      data: "G".repeat(120),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateImagesWithOpenAIAdapter({
        ...baseRequest,
        config: {
          baseURL: "",
          apiKey: "",
          defaultModel: "gemini-card",
          models: [
            {
              id: "gemini-card",
              siteName: "Gemini",
              baseURL: "https://www.pic2api.com/v1beta",
              apiKey: "sk-gemini",
              model: "gemini-3.0-pro-image",
              label: "gemini-3.0-pro-image",
              mediaType: "image",
              capabilities: ["text-to-image", "image-to-image"],
              endpoints: GEMINI_NATIVE_ENDPOINTS,
              requestTimeoutSeconds: 600,
            },
          ],
        },
        model: "gemini-card",
        params: {
          ...baseRequest.params,
          aspectRatio: "16:9",
          resolution: "2k",
        },
      }),
    ).resolves.toEqual([
      {
        dataURL: `data:image/png;base64,${"G".repeat(120)}`,
        mimeType: "image/png",
        revisedPrompt: undefined,
      },
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.pic2api.com/v1beta/models/gemini-3.0-pro-image:generateContent",
      expect.any(Object),
    );

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const headers = init.headers as Headers;

    expect(headers.get("x-goog-api-key")).toBe("sk-gemini");
    expect(headers.get("Authorization")).toBeNull();
    expect(JSON.parse(init.body as string)).toMatchObject({
      contents: [
        {
          role: "user",
          parts: [{ text: "a small library" }],
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        aspectRatio: "16:9",
        resolution: "2k",
      },
    });
  });

  it("normalizes auth failures without echoing the API key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: { message: "The supplied key sk-local-only is invalid." },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    await expect(generateImagesWithOpenAIAdapter(baseRequest)).rejects.toEqual(
      new AIImageGenerationError(
        "AI image request was rejected by the provider. Check the configured API key and model permissions.",
        "auth",
        {
          status: 401,
          providerError: {
            message: "The supplied key sk-local-only is invalid.",
          },
        },
      ),
    );
  });

  it("normalizes browser-side network failures without echoing the API key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    await expect(generateImagesWithOpenAIAdapter(baseRequest)).rejects.toEqual(
      new AIImageGenerationError(
        "AI image request failed before reaching the provider. Check that the model Base URL is reachable from this browser, uses HTTPS, and allows CORS for image requests.",
        "cors-or-network",
        {
          endpoint: "https://api.example.com/v1/images/generations",
          errorMessage: "Failed to fetch",
        },
      ),
    );
  });

  it("normalizes provider error objects returned with HTTP 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: {
              message: "Invalid URL (GET /v1/images/generations)",
              type: "invalid_request_error",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    await expect(generateImagesWithOpenAIAdapter(baseRequest)).rejects.toEqual(
      new AIImageGenerationError(
        "Invalid URL (GET /v1/images/generations)",
        "request-failed",
        {
          status: 200,
          providerError: {
            message: "Invalid URL (GET /v1/images/generations)",
            type: "invalid_request_error",
          },
        },
      ),
    );
  });

  it("does not download image generation API endpoints as image URLs", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [{ url: "https://api.example.com/v1/images/generations" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    await expect(generateImagesWithOpenAIAdapter(baseRequest)).rejects.toEqual(
      new AIImageGenerationError(
        "Generation failed: provider returned an image generation API endpoint instead of an image file URL.",
        "invalid-response",
        {
          remoteURL: "https://api.example.com/v1/images/generations",
        },
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("includes provider response details when no images are returned", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            data: [],
            id: "empty-response",
            object: "image_generation",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    await expect(generateImagesWithOpenAIAdapter(baseRequest)).rejects.toEqual(
      new AIImageGenerationError(
        "Generation failed: provider returned no images.",
        "invalid-response",
        {
          providerResponse: {
            data: [],
            id: "empty-response",
            object: "image_generation",
          },
        },
      ),
    );
  });

  it("accepts a single data object image response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            data: {
              b64_json: "BBB",
              revised_prompt: "single revised",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    await expect(generateImagesWithOpenAIAdapter(baseRequest)).resolves.toEqual(
      [
        {
          dataURL: "data:image/png;base64,BBB",
          mimeType: "image/png",
          revisedPrompt: "single revised",
        },
      ],
    );
  });

  it("accepts proxy image arrays outside the OpenAI data field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            images: [
              {
                data_url: "data:image/webp;base64,CCC",
                revisedPrompt: "proxy revised",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    await expect(generateImagesWithOpenAIAdapter(baseRequest)).resolves.toEqual(
      [
        {
          dataURL: "data:image/webp;base64,CCC",
          mimeType: "image/webp",
          revisedPrompt: "proxy revised",
        },
      ],
    );
  });

  it("accepts Responses API style image generation output", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            output: [
              {
                type: "image_generation_call",
                result: "D".repeat(120),
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    await expect(generateImagesWithOpenAIAdapter(baseRequest)).resolves.toEqual(
      [
        {
          dataURL: `data:image/png;base64,${"D".repeat(120)}`,
          mimeType: "image/png",
          revisedPrompt: undefined,
        },
      ],
    );
  });

  it("accepts chat completion markdown image outputs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (url === "https://cdn.example.com/generated.png") {
          return new Response("image", {
            status: 200,
            headers: { "Content-Type": "image/png" },
          });
        }

        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                index: 0,
                message: {
                  role: "assistant",
                  content: "![image](https://cdn.example.com/generated.png)",
                },
              },
            ],
            object: "chat.completion",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    await expect(generateImagesWithOpenAIAdapter(baseRequest)).resolves.toEqual(
      [
        {
          dataURL: "data:image/png;base64,aW1hZ2U=",
          mimeType: "image/png",
          remoteURL: "https://cdn.example.com/generated.png",
          storageType: "data-url",
          remoteFetchError: undefined,
          revisedPrompt: undefined,
        },
      ],
    );
  });

  it("falls back to renderable remote image URLs when CORS blocks inline download", async () => {
    const remoteURL = "https://cdn.example.com/generated.png";
    const fetchMock = vi.fn(async (url) => {
      if (url === remoteURL) {
        throw new TypeError("Failed to fetch");
      }

      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: `![image](${remoteURL})`,
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    class MockImage {
      public onload: (() => void) | null = null;
      public onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => {
          this.onload?.();
        });
      }
    }

    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("Image", MockImage);

    const outputs = await generateImagesWithOpenAIAdapter(baseRequest);

    expect(outputs).toEqual([
      {
        dataURL: remoteURL,
        mimeType: "image/png",
        remoteURL,
        storageType: "remote-url",
        remoteFetchError: {
          message:
            "Provider returned an image URL, but the browser could not download it. This is usually a CORS or network issue.",
          code: "cors-or-network",
          details: {
            remoteURL,
            errorMessage: "Failed to fetch",
          },
        },
        revisedPrompt: undefined,
      },
    ]);
  });
});
