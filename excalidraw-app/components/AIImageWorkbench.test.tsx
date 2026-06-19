import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { act } from "@testing-library/react";
import { vi } from "vitest";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  createImportedReferenceSource,
  exportSelectionToReferenceSource,
} from "../ai/canvasExport";
import { saveAIImageConfig } from "../ai/config";
import { insertGeneratedImageIntoCanvas } from "../ai/imageCanvas";
import { generateImagesWithOpenAIAdapter } from "../ai/openAIImageAdapter";

import { AIImageWorkbench } from "./AIImageWorkbench";

import type {
  AIImageGenerationOutput,
  AIImageProviderConfig,
} from "../ai/types";

vi.mock("../ai/openAIImageAdapter", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../ai/openAIImageAdapter")
  >();

  return {
    ...actual,
    generateImagesWithOpenAIAdapter: vi.fn(),
  };
});

vi.mock("../ai/imageCanvas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai/imageCanvas")>();

  return {
    ...actual,
    insertGeneratedImageIntoCanvas: vi.fn(),
  };
});

vi.mock("../ai/canvasExport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai/canvasExport")>();

  return {
    ...actual,
    createImportedReferenceSource: vi.fn(actual.createImportedReferenceSource),
    exportSelectionToReferenceSource: vi.fn(),
  };
});

const createImageConfig = (): AIImageProviderConfig => ({
  baseURL: "https://example.com/v1",
  apiKey: "test-key",
  defaultModel: "image-model",
  models: [
    {
      id: "image-model",
      siteName: "Test Provider",
      baseURL: "https://example.com/v1",
      apiKey: "test-key",
      model: "test-image-model",
      label: "Test image model",
      mediaType: "image",
      nativeModel: "other",
      capabilities: ["text-to-image", "image-to-image", "inpaint"],
      endpoints: {
        textToImage: { path: "/images/generations", format: "json" },
        imageToImage: { path: "/images/edits", format: "form" },
        inpaint: { path: "/images/edits", format: "form" },
      },
      requestTimeoutSeconds: 30,
    },
  ],
});

const createExcalidrawAPI = ({
  selectedElementIds = {},
  elements = [],
  files = {},
  onChange,
}: {
  selectedElementIds?: Record<string, true>;
  elements?: any[];
  files?: Record<string, any>;
  onChange?: ExcalidrawImperativeAPI["onChange"];
} = {}): ExcalidrawImperativeAPI =>
  ({
    getAppState: () => ({
      selectedElementIds,
    }),
    getSceneElements: () => elements,
    getFiles: () => files,
    onChange: onChange || (() => () => {}),
    setToast: vi.fn(),
  } as unknown as ExcalidrawImperativeAPI);

const generatedOutput: AIImageGenerationOutput = {
  dataURL:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=" as AIImageGenerationOutput["dataURL"],
  mimeType: "image/png",
};

describe("AIImageWorkbench", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(generateImagesWithOpenAIAdapter).mockReset();
    vi.mocked(insertGeneratedImageIntoCanvas).mockReset();
    vi.mocked(exportSelectionToReferenceSource).mockReset();
    vi.mocked(createImportedReferenceSource).mockClear();
    saveAIImageConfig(createImageConfig());
    vi.mocked(insertGeneratedImageIntoCanvas).mockResolvedValue({
      id: "inserted-image",
      fileId: "inserted-file",
      width: 320,
      height: 240,
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("guards Generate against synchronous re-entry", async () => {
    let resolveGeneration:
      | ((outputs: AIImageGenerationOutput[]) => void)
      | null = null;

    vi.mocked(generateImagesWithOpenAIAdapter).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveGeneration = resolve;
        }),
    );

    render(<AIImageWorkbench excalidrawAPI={createExcalidrawAPI()} />);

    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "A calm whiteboard concept" },
    });

    const generateButton = screen.getByRole("button", {
      name: "Generate image",
    });

    act(() => {
      fireEvent.click(generateButton);
      fireEvent.click(generateButton);
    });

    expect(generateImagesWithOpenAIAdapter).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveGeneration?.([generatedOutput]);
    });

    await waitFor(() => {
      expect(insertGeneratedImageIntoCanvas).toHaveBeenCalledTimes(1);
    });
  });

  it("aborts generation on unmount and ignores late results", async () => {
    const generationSignalRef: { current: AbortSignal | null } = {
      current: null,
    };
    let resolveGeneration:
      | ((outputs: AIImageGenerationOutput[]) => void)
      | null = null;

    vi.mocked(generateImagesWithOpenAIAdapter).mockImplementation(
      ({ signal }) => {
        generationSignalRef.current = signal || null;

        return new Promise((resolve) => {
          resolveGeneration = resolve;
        });
      },
    );

    const { unmount } = render(
      <AIImageWorkbench excalidrawAPI={createExcalidrawAPI()} />,
    );

    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "A calm whiteboard concept" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Generate image",
      }),
    );

    await waitFor(() => {
      expect(generationSignalRef.current).not.toBeNull();
    });

    unmount();

    if (!generationSignalRef.current) {
      throw new Error("Expected generation signal to be captured.");
    }

    expect(generationSignalRef.current.aborted).toBe(true);

    await act(async () => {
      resolveGeneration?.([generatedOutput]);
    });

    expect(insertGeneratedImageIntoCanvas).not.toHaveBeenCalled();
  });

  it("consumes an initial reference add request on mount", async () => {
    vi.mocked(exportSelectionToReferenceSource).mockResolvedValue({
      source: {
        elementId: "reference-element",
        file: new File(["reference"], "reference.png", { type: "image/png" }),
        dataURL: generatedOutput.dataURL,
        index: 1,
        sourceType: "canvas",
        createdAt: 1,
      },
    });

    render(
      <AIImageWorkbench
        excalidrawAPI={createExcalidrawAPI({
          selectedElementIds: { "reference-element": true },
          elements: [
            {
              id: "reference-element",
              type: "rectangle",
              isDeleted: false,
            },
          ],
        })}
        referenceAddRequest={{ id: 1 }}
      />,
    );

    await waitFor(() => {
      expect(exportSelectionToReferenceSource).toHaveBeenCalledTimes(1);
    });
  });

  it("does not rebuild selected image references when selection is unchanged", async () => {
    const changeListeners: Array<() => void> = [];
    const selectedElementIds = { "image-1": true } as const;
    const elements = [
      {
        id: "image-1",
        type: "image",
        fileId: "file-1",
        width: 100,
        height: 80,
        isDeleted: false,
      },
    ];
    const files = {
      "file-1": {
        dataURL: generatedOutput.dataURL,
        mimeType: "image/png",
      },
    };

    render(
      <AIImageWorkbench
        excalidrawAPI={createExcalidrawAPI({
          selectedElementIds,
          elements,
          files,
          onChange: ((listener: () => void) => {
            changeListeners.push(listener);

            return () => {};
          }) as ExcalidrawImperativeAPI["onChange"],
        })}
      />,
    );

    await waitFor(() => {
      expect(createImportedReferenceSource).toHaveBeenCalledTimes(1);
    });

    act(() => {
      changeListeners.forEach((listener) => listener());
      changeListeners.forEach((listener) => listener());
    });

    expect(createImportedReferenceSource).toHaveBeenCalledTimes(1);
  });

  it("anchors reference-mode generated images to the first reference image", async () => {
    vi.mocked(generateImagesWithOpenAIAdapter).mockResolvedValue([
      generatedOutput,
    ]);

    render(
      <AIImageWorkbench
        excalidrawAPI={createExcalidrawAPI({
          selectedElementIds: { "image-1": true },
          elements: [
            {
              id: "image-1",
              type: "image",
              fileId: "file-1",
              x: 120,
              y: 80,
              width: 100,
              height: 80,
              isDeleted: false,
            },
          ],
          files: {
            "file-1": {
              dataURL: generatedOutput.dataURL,
              mimeType: "image/png",
            },
          },
        })}
      />,
    );

    await waitFor(() => {
      expect(createImportedReferenceSource).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Reference" }));
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Use the selected reference" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate image" }));

    await waitFor(() => {
      expect(insertGeneratedImageIntoCanvas).toHaveBeenCalledTimes(1);
    });
    expect(insertGeneratedImageIntoCanvas).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: {
          kind: "reference",
          elementIds: ["image-1"],
        },
      }),
    );
  });

  it("debounces persisted reference state and omits data URLs", async () => {
    vi.useFakeTimers();

    const setItemSpy = vi.spyOn(window.localStorage, "setItem");

    render(
      <AIImageWorkbench
        excalidrawAPI={createExcalidrawAPI({
          selectedElementIds: { "image-1": true },
          elements: [
            {
              id: "image-1",
              type: "image",
              fileId: "file-1",
              width: 100,
              height: 80,
              isDeleted: false,
            },
          ],
          files: {
            "file-1": {
              dataURL: generatedOutput.dataURL,
              mimeType: "image/png",
            },
          },
        })}
      />,
    );

    await waitFor(() => {
      expect(createImportedReferenceSource).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Reference" }));
    fireEvent.click(screen.getByRole("button", { name: "Unlocked" }));

    await act(async () => {});

    await act(async () => {
      vi.advanceTimersByTime(249);
    });
    expect(setItemSpy).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });

    expect(setItemSpy).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(String(setItemSpy.mock.calls[0][1]));
    expect(persisted.images[0].dataURL).toBeUndefined();
    expect(JSON.stringify(persisted)).not.toContain("base64");

    vi.useRealTimers();
  });

  it("does not allow missing references to generate", async () => {
    const changeListeners: Array<() => void> = [];
    const selectedElementIds: Record<string, true> = { "image-1": true };
    const imageElement = {
      id: "image-1",
      type: "image",
      fileId: "file-1",
      width: 100,
      height: 80,
      isDeleted: false,
    };

    render(
      <AIImageWorkbench
        excalidrawAPI={createExcalidrawAPI({
          selectedElementIds,
          elements: [imageElement],
          files: {
            "file-1": {
              dataURL: generatedOutput.dataURL,
              mimeType: "image/png",
            },
          },
          onChange: ((listener: () => void) => {
            changeListeners.push(listener);

            return () => {};
          }) as ExcalidrawImperativeAPI["onChange"],
        })}
      />,
    );

    await waitFor(() => {
      expect(createImportedReferenceSource).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Reference" }));
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Use the selected reference" },
    });

    delete selectedElementIds["image-1"];
    imageElement.isDeleted = true;
    act(() => {
      changeListeners.forEach((listener) => listener());
    });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Generate image" }),
      ).toBeDisabled();
    });
    expect(generateImagesWithOpenAIAdapter).not.toHaveBeenCalled();
  });

  it("marks video and audio controls as preview-only", () => {
    render(<AIImageWorkbench excalidrawAPI={createExcalidrawAPI()} />);

    fireEvent.click(screen.getByRole("button", { name: "Video" }));

    expect(screen.getByPlaceholderText("Video preview only")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Video preview only" }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Audio" }));

    expect(screen.getByPlaceholderText("Audio preview only")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Audio preview only" }),
    ).toBeDisabled();
  });

  it("rejects malformed generation outputs before inserting", async () => {
    vi.mocked(generateImagesWithOpenAIAdapter).mockResolvedValue([
      { dataURL: "" } as AIImageGenerationOutput,
    ]);

    render(<AIImageWorkbench excalidrawAPI={createExcalidrawAPI()} />);

    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "A malformed provider response" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate image" }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Generation failed: provider returned malformed image data.",
        ),
      ).toBeInTheDocument();
    });
    expect(insertGeneratedImageIntoCanvas).not.toHaveBeenCalled();
  });
});
