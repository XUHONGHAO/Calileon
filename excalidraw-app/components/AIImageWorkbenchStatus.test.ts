import {
  createAIImageWorkbenchStatus,
  getAIImageWorkbenchConfigurationNotice,
  getAIImageWorkbenchModeLabel,
} from "./AIImageWorkbenchStatus";

import type { AIImageWorkbenchStatusInput } from "./AIImageWorkbenchStatus";

const createStatusInput = (
  overrides: Partial<AIImageWorkbenchStatusInput> = {},
): AIImageWorkbenchStatusInput => ({
  mediaType: "image",
  mode: "text-to-image",
  selectedModelLabel: "Example Provider",
  hasSelectedModelBaseURL: true,
  selectedModelId: "model-1",
  prompt: "A polished diagram",
  modelSupportsMode: true,
  referenceCount: 0,
  selectedImageCount: 0,
  hasCurrentMask: false,
  hasExcalidrawAPI: true,
  isGenerating: false,
  ...overrides,
});

const statusByLabel = (input: AIImageWorkbenchStatusInput, label: string) => {
  const status = createAIImageWorkbenchStatus(input);

  return status.statusStripItems.find((item) => item.label === label);
};

describe("AIImageWorkbenchStatus", () => {
  it("allows text-to-image generation when required inputs are ready", () => {
    const status = createAIImageWorkbenchStatus(createStatusInput());

    expect(status.canGenerate).toBe(true);
    expect(status.requiresReference).toBe(false);
    expect(status.requiresMask).toBe(false);
    expect(statusByLabel(createStatusInput(), "Prompt")).toMatchObject({
      value: "Ready",
      tone: "ready",
    });
  });

  it("surfaces missing model and prompt states", () => {
    const input = createStatusInput({
      selectedModelLabel: null,
      hasSelectedModelBaseURL: false,
      selectedModelId: "",
      prompt: "   ",
    });
    const status = createAIImageWorkbenchStatus(input);

    expect(status.canGenerate).toBe(false);
    expect(statusByLabel(input, "Model")).toMatchObject({
      value: "No model",
      tone: "warning",
    });
    expect(statusByLabel(input, "Prompt")).toMatchObject({
      value: "Empty",
      tone: "warning",
    });
  });

  it("surfaces incomplete and unsupported configured model states", () => {
    const missingEndpoint = createStatusInput({
      hasSelectedModelBaseURL: false,
    });
    const unsupportedMode = createStatusInput({
      modelSupportsMode: false,
    });

    expect(statusByLabel(missingEndpoint, "Model")).toMatchObject({
      value: "Missing endpoint",
      tone: "warning",
    });
    expect(statusByLabel(unsupportedMode, "Model")).toMatchObject({
      value: "Unsupported mode",
      tone: "warning",
    });
  });

  it("keeps configured models ready when an inherited endpoint is available", () => {
    const inheritedEndpoint = createStatusInput({
      hasSelectedModelBaseURL: true,
    });

    expect(statusByLabel(inheritedEndpoint, "Model")).toMatchObject({
      value: "Example Provider",
      tone: "ready",
    });
    expect(createAIImageWorkbenchStatus(inheritedEndpoint).canGenerate).toBe(
      true,
    );
  });

  it("creates configuration notices with direct settings actions", () => {
    expect(
      getAIImageWorkbenchConfigurationNotice({
        ...createStatusInput(),
        hasModelsForMediaType: false,
        mediaType: "video",
      }),
    ).toEqual({
      message: "Add video model in AI Settings.",
      actionLabel: "Open AI Settings",
    });

    expect(
      getAIImageWorkbenchConfigurationNotice({
        ...createStatusInput(),
        hasModelsForMediaType: true,
        hasSelectedModelBaseURL: false,
      }),
    ).toEqual({
      message: "Add a model endpoint before generating.",
      actionLabel: "Open AI Settings",
    });

    expect(
      getAIImageWorkbenchConfigurationNotice({
        ...createStatusInput(),
        hasModelsForMediaType: true,
        modelSupportsMode: false,
      }),
    ).toEqual({
      message: "Selected model does not support this mode.",
      actionLabel: "Open AI Settings",
    });

    expect(
      getAIImageWorkbenchConfigurationNotice({
        ...createStatusInput(),
        hasModelsForMediaType: true,
      }),
    ).toBeNull();
  });

  it("requires references for image-to-image generation", () => {
    const missingReferences = createStatusInput({
      mode: "image-to-image",
      referenceCount: 0,
    });
    const readyReferences = createStatusInput({
      mode: "image-to-image",
      referenceCount: 2,
    });

    expect(createAIImageWorkbenchStatus(missingReferences)).toMatchObject({
      canGenerate: false,
      requiresReference: true,
      activeReferenceCount: 0,
    });
    expect(statusByLabel(missingReferences, "Refs")).toMatchObject({
      value: "0 active",
      tone: "warning",
    });
    expect(createAIImageWorkbenchStatus(readyReferences)).toMatchObject({
      canGenerate: true,
      activeReferenceCount: 2,
    });
  });

  it("requires exactly one selected image with a mask for inpaint generation", () => {
    const missingMask = createStatusInput({
      mode: "inpaint",
      referenceCount: 3,
      selectedImageCount: 1,
      hasCurrentMask: false,
    });
    const readyMask = createStatusInput({
      mode: "inpaint",
      referenceCount: 3,
      selectedImageCount: 1,
      hasCurrentMask: true,
    });

    expect(createAIImageWorkbenchStatus(missingMask)).toMatchObject({
      canGenerate: false,
      requiresMask: true,
      activeReferenceCount: 1,
    });
    expect(statusByLabel(missingMask, "Mask")).toMatchObject({
      value: "Needed",
      tone: "warning",
    });
    expect(createAIImageWorkbenchStatus(readyMask).canGenerate).toBe(true);
    expect(statusByLabel(readyMask, "Mask")).toMatchObject({
      value: "Ready",
      tone: "mask",
    });
  });

  it("blocks unsupported, generating, and non-image runs", () => {
    expect(
      createAIImageWorkbenchStatus(
        createStatusInput({ modelSupportsMode: false }),
      ).canGenerate,
    ).toBe(false);
    expect(
      createAIImageWorkbenchStatus(createStatusInput({ isGenerating: true })),
    ).toMatchObject({
      canGenerate: false,
      statusStripItems: expect.arrayContaining([
        expect.objectContaining({
          label: "Run",
          value: "Generating",
          tone: "history",
        }),
      ]),
    });
    expect(
      createAIImageWorkbenchStatus(createStatusInput({ mediaType: "video" }))
        .canGenerate,
    ).toBe(false);
  });

  it("surfaces terminal generation run states in the status strip", () => {
    expect(
      statusByLabel(createStatusInput({ runStatus: "succeeded" }), "Run"),
    ).toMatchObject({
      value: "Succeeded",
      tone: "ready",
    });
    expect(
      statusByLabel(createStatusInput({ runStatus: "failed" }), "Run"),
    ).toMatchObject({
      value: "Failed",
      tone: "warning",
    });
    expect(
      statusByLabel(createStatusInput({ runStatus: "canceled" }), "Run"),
    ).toMatchObject({
      value: "Canceled",
      tone: "warning",
    });
    expect(
      statusByLabel(createStatusInput({ runStatus: "inserted" }), "Run"),
    ).toMatchObject({
      value: "Inserted",
      tone: "ready",
    });
  });

  it("keeps mode labels aligned with the workbench UI", () => {
    expect(
      getAIImageWorkbenchModeLabel({
        mediaType: "image",
        mode: "text-to-image",
      }),
    ).toBe("Text");
    expect(
      getAIImageWorkbenchModeLabel({
        mediaType: "image",
        mode: "image-to-image",
      }),
    ).toBe("Reference");
    expect(
      getAIImageWorkbenchModeLabel({
        mediaType: "video",
        mode: "text-to-image",
      }),
    ).toBe("Video");
  });
});
