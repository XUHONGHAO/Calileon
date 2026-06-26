import {
  applyPromptTemplateToWorkbenchDraft,
  createCopyPromptActionState,
  createSendPromptToAssistantActionState,
  reuseGenerationLogInWorkbenchDraft,
  sendPromptToWorkbenchDraft,
} from "./AIImageWorkbenchDraft";

import type { AIImageWorkbenchDraftState } from "./AIImageWorkbench";
import type {
  AIGenerationLogEntry,
  AIImageGenerationParams,
  PromptTemplate,
} from "../ai/types";

const baseParams = (): AIImageGenerationParams => ({
  size: "1024x1024",
  n: 1,
  seed: null,
  quality: "auto",
  style: "",
  referenceStrength: 0.6,
  duration: 5,
  fps: 24,
  resolution: "auto",
  aspectRatio: "auto",
  audioFormat: "mp3",
  voice: "",
});

const createDraftState = (): AIImageWorkbenchDraftState => ({
  mediaType: "image",
  mode: "text-to-image",
  imageModes: {
    "text-to-image": {
      selectedModelId: "text-model",
      prompt: "",
      negativePrompt: "",
      params: baseParams(),
      masksByImageId: {},
    },
    "image-to-image": {
      selectedModelId: "reference-model",
      prompt: "",
      negativePrompt: "",
      params: baseParams(),
      masksByImageId: {},
    },
    inpaint: {
      selectedModelId: "inpaint-model",
      prompt: "",
      negativePrompt: "",
      params: baseParams(),
      masksByImageId: {
        imageA: {
          file: new File(["mask"], "mask.png", { type: "image/png" }),
          updatedAt: 1,
          elements: [],
        },
      },
    },
  },
  video: {
    selectedModelId: "video-model",
    prompt: "",
    negativePrompt: "",
    params: baseParams(),
  },
  audio: {
    selectedModelId: "audio-model",
    prompt: "",
    negativePrompt: "",
    params: baseParams(),
  },
});

const createTemplate = (
  overrides: Partial<PromptTemplate> = {},
): PromptTemplate => ({
  id: "template-1",
  label: "Template",
  template: "A visual concept prompt",
  modes: ["text-to-image"],
  category: "composition",
  language: "en",
  createdAt: 1,
  isBuiltIn: true,
  ...overrides,
});

const createLog = (
  overrides: Partial<AIGenerationLogEntry> = {},
): AIGenerationLogEntry => ({
  id: "log-1",
  submittedAt: "2026-06-18T10:00:00.000Z",
  completedAt: "2026-06-18T10:00:02.000Z",
  mediaType: "image",
  mode: "image-to-image",
  status: "success",
  model: {
    id: "model-from-log",
    name: "native-model",
    siteName: "Provider",
  },
  prompt: "Reuse this prompt",
  negativePrompt: "avoid blur",
  params: {
    ...baseParams(),
    seed: 99,
    style: "natural",
  },
  request: {
    baseURL: "https://api.example.test/v1",
    endpoint: "https://api.example.test/v1/images/edits",
  },
  response: {
    summary: "Generated image inserted.",
    details: { outputCount: 1 },
  },
  ...overrides,
});

describe("AIImageWorkbenchDraft helpers", () => {
  it("disables copying empty prompt text", () => {
    expect(createCopyPromptActionState("   ")).toMatchObject({
      canCopy: false,
      prompt: "   ",
    });
  });

  it("keeps the original prompt text when preparing copy state", () => {
    expect(
      createCopyPromptActionState("  keep leading whitespace for copy  "),
    ).toMatchObject({
      canCopy: true,
      prompt: "  keep leading whitespace for copy  ",
    });
  });

  it("trims prompts before sending them to the assistant", () => {
    expect(createSendPromptToAssistantActionState("   ")).toMatchObject({
      canSend: false,
      prompt: "",
    });
    expect(
      createSendPromptToAssistantActionState("  refine this concept  "),
    ).toMatchObject({
      canSend: true,
      prompt: "refine this concept",
    });
  });

  it("sends assistant prompts to text-to-image draft state", () => {
    const nextState = sendPromptToWorkbenchDraft(
      createDraftState(),
      "Assistant prompt",
    );

    expect(nextState.mediaType).toBe("image");
    expect(nextState.mode).toBe("text-to-image");
    expect(nextState.imageModes["text-to-image"].prompt).toBe(
      "Assistant prompt",
    );
  });

  it("applies prompt templates to their first supported image mode", () => {
    const nextState = applyPromptTemplateToWorkbenchDraft(
      createDraftState(),
      createTemplate({
        template: "Inpaint prompt",
        modes: ["inpaint", "text-to-image"],
      }),
    );

    expect(nextState.mediaType).toBe("image");
    expect(nextState.mode).toBe("inpaint");
    expect(nextState.imageModes.inpaint.prompt).toBe("Inpaint prompt");
    expect(nextState.imageModes.inpaint.masksByImageId.imageA).toBeDefined();
  });

  it("falls back templates without modes to text-to-image", () => {
    const nextState = applyPromptTemplateToWorkbenchDraft(
      createDraftState(),
      createTemplate({
        template: "Fallback prompt",
        modes: [],
      }),
    );

    expect(nextState.mode).toBe("text-to-image");
    expect(nextState.imageModes["text-to-image"].prompt).toBe(
      "Fallback prompt",
    );
  });

  it("reuses image generation logs in the matching image mode", () => {
    const nextState = reuseGenerationLogInWorkbenchDraft(
      createDraftState(),
      createLog(),
    );

    expect(nextState.mediaType).toBe("image");
    expect(nextState.mode).toBe("image-to-image");
    expect(nextState.imageModes["image-to-image"]).toMatchObject({
      selectedModelId: "model-from-log",
      prompt: "Reuse this prompt",
      negativePrompt: "avoid blur",
      params: {
        seed: 99,
        style: "natural",
      },
    });
  });

  it("reuses video generation logs in the video draft", () => {
    const nextState = reuseGenerationLogInWorkbenchDraft(
      createDraftState(),
      createLog({
        mediaType: "video",
        mode: "text-to-video",
        prompt: "Animate this scene",
        negativePrompt: undefined,
        params: {
          ...baseParams(),
          duration: 8,
          aspectRatio: "16:9",
        },
      }),
    );

    expect(nextState.mediaType).toBe("video");
    expect(nextState.video).toMatchObject({
      selectedModelId: "model-from-log",
      prompt: "Animate this scene",
      negativePrompt: "",
      params: {
        duration: 8,
        aspectRatio: "16:9",
      },
    });
  });
});
