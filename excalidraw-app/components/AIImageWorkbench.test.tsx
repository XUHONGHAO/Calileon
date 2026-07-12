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
import { loadAIGenerationLogs } from "../ai/generationLog";
import { insertGeneratedImageIntoCanvas } from "../ai/imageCanvas";
import { generateImagesWithOpenAIAdapter } from "../ai/openAIImageAdapter";
import { pollVideoTask, submitVideoTask } from "../ai/openAIVideoAdapter";
import {
  getVideoDimensions,
  insertVideoEmbedIntoCanvas,
} from "../ai/videoCanvas";
import { loadPendingVideoTasks } from "../ai/videoTaskStore";

import { AIImageWorkbench } from "./AIImageWorkbench";

import type {
  AIImageGenerationOutput,
  AIImageProviderConfig,
  AIMaskReadyPayload,
} from "../ai/types";

const aiWorkbenchIDBMock = vi.hoisted(() => ({
  payloads: new Map<string, unknown>(),
  deferredKeyPart: null as string | null,
  rejectedKeyPart: null as string | null,
  resolveDeferred: null as (() => void) | null,
}));

vi.mock("../data/AIWorkbenchIndexedDB", () => ({
  AIWorkbenchIndexedDBAdapter: {
    setRevisionPayloads: async (
      descriptor: { scopeId: string; revision: string; kind: string },
      payloads: Array<{ id: string; value: unknown }>,
    ) =>
      payloads.map((payload) => {
        const key = `${descriptor.kind}:${descriptor.scopeId}:${descriptor.revision}:${payload.id}`;
        aiWorkbenchIDBMock.payloads.set(key, payload.value);
        return key;
      }),
    getMany: async (keys: string[]) => {
      if (
        aiWorkbenchIDBMock.deferredKeyPart &&
        keys.some((key) => key.includes(aiWorkbenchIDBMock.deferredKeyPart!))
      ) {
        await new Promise<void>((resolve) => {
          aiWorkbenchIDBMock.resolveDeferred = resolve;
        });
      }
      if (
        aiWorkbenchIDBMock.rejectedKeyPart &&
        keys.some((key) => key.includes(aiWorkbenchIDBMock.rejectedKeyPart!))
      ) {
        throw new Error("IndexedDB read failed");
      }
      return keys.map((key) => aiWorkbenchIDBMock.payloads.get(key));
    },
    deleteMany: async (keys: string[]) => {
      keys.forEach((key) => aiWorkbenchIDBMock.payloads.delete(key));
    },
  },
}));

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

vi.mock("../ai/openAIVideoAdapter", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../ai/openAIVideoAdapter")
  >();

  return {
    ...actual,
    pollVideoTask: vi.fn(),
    submitVideoTask: vi.fn(),
  };
});

vi.mock("../ai/videoCanvas", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai/videoCanvas")>();

  return {
    ...actual,
    getVideoDimensions: vi.fn(),
    insertVideoEmbedIntoCanvas: vi.fn(),
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

const createImageConfig = (
  requestTimeoutSeconds = 30,
): AIImageProviderConfig => ({
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
      requestTimeoutSeconds,
    },
  ],
});

const createVideoConfig = (
  requestTimeoutSeconds = 30,
): AIImageProviderConfig => {
  const config = createImageConfig();

  return {
    ...config,
    models: [
      ...config.models,
      {
        id: "video-model",
        siteName: "Test Video Provider",
        baseURL: "https://example.com/v1",
        apiKey: "test-video-key",
        model: "test-video-model",
        label: "Test video model",
        mediaType: "video",
        nativeModel: "other",
        capabilities: ["text-to-video", "image-to-video"],
        endpoints: config.models[0].endpoints,
        requestTimeoutSeconds,
      },
    ],
  };
};

const createExcalidrawAPI = ({
  selectedElementIds = {},
  elements = [],
  files = {},
  name = null,
  getName,
  onChange,
}: {
  selectedElementIds?: Record<string, true>;
  elements?: any[];
  files?: Record<string, any>;
  name?: string | null;
  getName?: () => string;
  onChange?: ExcalidrawImperativeAPI["onChange"];
} = {}): ExcalidrawImperativeAPI =>
  ({
    getAppState: () => ({
      selectedElementIds,
      name,
    }),
    getName: getName || (() => name || "Untitled"),
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

// The prompt input is a contenteditable <div>, not a form control, so
// fireEvent.change doesn't apply. Set its text and dispatch the same `input`
// event the component listens for.
const typePrompt = (value: string) => {
  const editor = screen.getByLabelText("Prompt");
  editor.textContent = value;
  fireEvent.input(editor);
};

const prepareVideoGeneration = (prompt = "A paper plane taking flight") => {
  fireEvent.click(screen.getByRole("button", { name: "Video" }));
  fireEvent.change(
    screen.getByPlaceholderText("Describe the video to generate..."),
    { target: { value: prompt } },
  );
};

describe("AIImageWorkbench", () => {
  beforeEach(() => {
    localStorage.clear();
    aiWorkbenchIDBMock.payloads.clear();
    aiWorkbenchIDBMock.deferredKeyPart = null;
    aiWorkbenchIDBMock.rejectedKeyPart = null;
    aiWorkbenchIDBMock.resolveDeferred = null;
    vi.mocked(generateImagesWithOpenAIAdapter).mockReset();
    vi.mocked(insertGeneratedImageIntoCanvas).mockReset();
    vi.mocked(exportSelectionToReferenceSource).mockReset();
    vi.mocked(createImportedReferenceSource).mockClear();
    vi.mocked(submitVideoTask).mockReset();
    vi.mocked(pollVideoTask).mockReset();
    vi.mocked(getVideoDimensions).mockReset();
    vi.mocked(insertVideoEmbedIntoCanvas).mockReset();
    saveAIImageConfig(createImageConfig());
    vi.mocked(insertGeneratedImageIntoCanvas).mockResolvedValue({
      id: "inserted-image",
      fileId: "inserted-file",
      width: 320,
      height: 240,
    } as any);
    vi.mocked(getVideoDimensions).mockResolvedValue({
      width: 1280,
      height: 720,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
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

    typePrompt("A calm whiteboard concept");

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

  it("stops inserting later outputs when canceled during a deferred insert", async () => {
    const onCloudAITaskRun = vi.fn(async () => {});
    let resolveInsert:
      | ((element: {
          id: string;
          fileId: string;
          width: number;
          height: number;
        }) => void)
      | null = null;

    vi.mocked(generateImagesWithOpenAIAdapter).mockResolvedValue([
      generatedOutput,
      generatedOutput,
    ]);
    vi.mocked(insertGeneratedImageIntoCanvas).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInsert = resolve as typeof resolveInsert;
        }) as ReturnType<typeof insertGeneratedImageIntoCanvas>,
    );

    render(
      <AIImageWorkbench
        excalidrawAPI={createExcalidrawAPI()}
        onCloudAITaskRun={onCloudAITaskRun}
      />,
    );

    typePrompt("A pair of calm whiteboard concepts");
    fireEvent.click(screen.getByRole("button", { name: "Generate image" }));

    await waitFor(() => {
      expect(insertGeneratedImageIntoCanvas).toHaveBeenCalledTimes(1);
      expect(insertGeneratedImageIntoCanvas).toHaveBeenCalledWith(
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0]);
    await act(async () => {
      resolveInsert?.({
        id: "inserted-image-1",
        fileId: "inserted-file-1",
        width: 320,
        height: 240,
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Generation canceled.")).toBeInTheDocument();
      expect(screen.getByAltText("generated asset #1")).toBeInTheDocument();
    });
    expect(insertGeneratedImageIntoCanvas).toHaveBeenCalledTimes(1);
    expect(onCloudAITaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "canceled",
        outputs: [
          expect.objectContaining({
            insertedElementId: "inserted-image-1",
            insertedFileId: "inserted-file-1",
          }),
        ],
      }),
    );
    expect(loadAIGenerationLogs()[0]).toMatchObject({
      status: "canceled",
      response: {
        details: {
          outputCount: 1,
          outputs: [expect.objectContaining({ index: 0 })],
          error: expect.anything(),
        },
      },
    });
  });

  it("records cancellation when an adapter resolves after ignoring abort", async () => {
    const onCloudAITaskRun = vi.fn(async () => {});
    const signalRef: { current: AbortSignal | null } = { current: null };
    let resolveGeneration:
      | ((outputs: AIImageGenerationOutput[]) => void)
      | null = null;
    vi.mocked(generateImagesWithOpenAIAdapter).mockImplementation(
      ({ signal }) => {
        signalRef.current = signal || null;
        return new Promise((resolve) => {
          resolveGeneration = resolve;
        });
      },
    );

    render(
      <AIImageWorkbench
        excalidrawAPI={createExcalidrawAPI()}
        onCloudAITaskRun={onCloudAITaskRun}
      />,
    );

    typePrompt("A calm whiteboard concept");
    fireEvent.click(screen.getByRole("button", { name: "Generate image" }));

    await waitFor(() => {
      expect(signalRef.current).not.toBeNull();
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0]);
    await act(async () => {
      resolveGeneration?.([generatedOutput]);
    });

    await waitFor(() => {
      expect(screen.getByText("Generation canceled.")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Generate image" }),
      ).toBeEnabled();
    });
    expect(insertGeneratedImageIntoCanvas).not.toHaveBeenCalled();
    expect(onCloudAITaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "canceled",
        errorCode: "canceled",
        outputs: [],
      }),
    );
    expect(loadAIGenerationLogs()[0]).toMatchObject({ status: "canceled" });
  });

  it("tracks an inserted output when the run times out during insertion", async () => {
    vi.useFakeTimers();
    saveAIImageConfig(createImageConfig(1));
    const onCloudAITaskRun = vi.fn(async () => {});
    let resolveInsert:
      | ((element: {
          id: string;
          fileId: string;
          width: number;
          height: number;
        }) => void)
      | null = null;
    vi.mocked(generateImagesWithOpenAIAdapter).mockResolvedValue([
      generatedOutput,
      generatedOutput,
    ]);
    vi.mocked(insertGeneratedImageIntoCanvas).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInsert = resolve as typeof resolveInsert;
        }) as ReturnType<typeof insertGeneratedImageIntoCanvas>,
    );

    render(
      <AIImageWorkbench
        excalidrawAPI={createExcalidrawAPI()}
        onCloudAITaskRun={onCloudAITaskRun}
      />,
    );
    typePrompt("A pair of calm whiteboard concepts");
    fireEvent.click(screen.getByRole("button", { name: "Generate image" }));

    await act(async () => {});
    expect(insertGeneratedImageIntoCanvas).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      resolveInsert?.({
        id: "timed-out-image-1",
        fileId: "timed-out-file-1",
        width: 320,
        height: 240,
      });
    });

    expect(
      screen.getByText("Generation timed out after 1 seconds."),
    ).toBeInTheDocument();
    expect(insertGeneratedImageIntoCanvas).toHaveBeenCalledTimes(1);
    expect(onCloudAITaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorCode: "timeout",
        outputs: [
          expect.objectContaining({
            insertedElementId: "timed-out-image-1",
            insertedFileId: "timed-out-file-1",
          }),
        ],
      }),
    );
    expect(loadAIGenerationLogs()[0]).toMatchObject({
      status: "failed",
      response: {
        details: {
          outputCount: 1,
          outputs: [expect.objectContaining({ index: 0 })],
          error: expect.anything(),
        },
      },
    });
  });

  it("keeps earlier generated assets when a later output fails to insert", async () => {
    const onCloudAITaskRun = vi.fn(async () => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(generateImagesWithOpenAIAdapter).mockResolvedValue([
      generatedOutput,
      generatedOutput,
    ]);
    vi.mocked(insertGeneratedImageIntoCanvas)
      .mockResolvedValueOnce({
        id: "inserted-image-1",
        fileId: "inserted-file-1",
        width: 320,
        height: 240,
      } as any)
      .mockRejectedValueOnce(new Error("Second insert failed"));

    render(
      <AIImageWorkbench
        excalidrawAPI={createExcalidrawAPI()}
        onCloudAITaskRun={onCloudAITaskRun}
      />,
    );

    typePrompt("A pair of calm whiteboard concepts");
    fireEvent.click(screen.getByRole("button", { name: "Generate image" }));

    await waitFor(() => {
      expect(
        screen.getByText(
          "Inserted 1 of 2 generated images. The remaining images could not be inserted.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByAltText("generated asset #1")).toBeInTheDocument();
    });
    expect(insertGeneratedImageIntoCanvas).toHaveBeenCalledTimes(2);
    expect(onCloudAITaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorCode: "partial-insert-failure",
        outputs: [
          expect.objectContaining({
            insertedElementId: "inserted-image-1",
            insertedFileId: "inserted-file-1",
          }),
        ],
      }),
    );
    expect(loadAIGenerationLogs()[0]).toMatchObject({
      status: "failed",
      response: {
        summary:
          "Inserted 1 of 2 generated images. The remaining images could not be inserted.",
        details: {
          outputCount: 1,
          outputs: [expect.objectContaining({ index: 0 })],
          error: expect.anything(),
        },
      },
    });
  });

  it("reports completed generation runs to the cloud task callback", async () => {
    const onCloudAITaskRun = vi.fn(async () => {});
    vi.mocked(generateImagesWithOpenAIAdapter).mockResolvedValue([
      generatedOutput,
    ]);

    render(
      <AIImageWorkbench
        excalidrawAPI={createExcalidrawAPI()}
        onCloudAITaskRun={onCloudAITaskRun}
      />,
    );

    typePrompt("A calm whiteboard concept");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Generate image",
      }),
    );

    await waitFor(() => {
      expect(onCloudAITaskRun).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "success",
          prompt: "A calm whiteboard concept",
          outputs: [
            expect.objectContaining({
              insertedElementId: "inserted-image",
              insertedFileId: "inserted-file",
            }),
          ],
        }),
      );
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

    typePrompt("A calm whiteboard concept");
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

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Reference" }));
    typePrompt("Use the selected reference");
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

  it("debounces reference persistence into a lightweight v4 manifest", async () => {
    const setItemSpy = vi.spyOn(window.localStorage, "setItem");

    render(
      <AIImageWorkbench
        persistenceScopeId="local:test-board"
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

    vi.useFakeTimers();
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

    await waitFor(() => expect(setItemSpy).toHaveBeenCalledTimes(1));
    const persisted = JSON.parse(String(setItemSpy.mock.calls[0][1]));
    expect(persisted.version).toBe(4);
    expect(persisted.images[0].dataURL).toBeUndefined();
    expect(persisted.images[0].payloadKey).toContain("reference:");
    expect(aiWorkbenchIDBMock.payloads.size).toBe(1);

    vi.useRealTimers();
  });

  it("restores reference and inpaint mask state after a page refresh", async () => {
    let maskReadyHandler: ((payload: AIMaskReadyPayload) => void) | null = null;
    let dynamicNameCounter = 0;
    const getDynamicName = vi.fn(() => `Untitled-${++dynamicNameCounter}`);
    const imageElement = {
      id: "image-1",
      type: "image",
      fileId: "file-1",
      width: 100,
      height: 80,
      isDeleted: false,
    };
    const files = {
      "file-1": {
        dataURL: generatedOutput.dataURL,
        mimeType: "image/png",
      },
    };
    const firstRender = render(
      <AIImageWorkbench
        persistenceScopeId="local:refresh-board"
        excalidrawAPI={createExcalidrawAPI({
          selectedElementIds: { "image-1": true },
          elements: [imageElement],
          files,
          getName: getDynamicName,
        })}
        onMaskReady={(handler) => {
          maskReadyHandler = handler;
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inpaint" }));

    await waitFor(() => {
      expect(maskReadyHandler).not.toBeNull();
      expect(screen.getByAltText("Reference #1")).toBeInTheDocument();
    });

    act(() => {
      maskReadyHandler?.({
        imageId: "image-1",
        maskFile: new File(["mask"], "mask-image-1.png", {
          type: "image/png",
        }),
        maskElements: [],
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Mask: mask-image-1.png")).toBeInTheDocument();
      expect(
        localStorage.getItem(
          "ai-workbench-reference-manifest:local%3Arefresh-board",
        ),
      ).not.toBeNull();
      expect(
        localStorage.getItem(
          "ai-workbench-mask-manifest:local%3Arefresh-board",
        ),
      ).not.toBeNull();
    });

    firstRender.unmount();
    maskReadyHandler = null;

    render(
      <AIImageWorkbench
        persistenceScopeId="local:refresh-board"
        excalidrawAPI={createExcalidrawAPI({
          elements: [imageElement],
          files,
          getName: getDynamicName,
        })}
        onMaskReady={(handler) => {
          maskReadyHandler = handler;
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inpaint" }));

    await waitFor(() => {
      expect(screen.getByAltText("Reference #1")).toBeInTheDocument();
      expect(screen.getByText("Mask: mask-image-1.png")).toBeInTheDocument();
    });

    expect(getDynamicName).not.toHaveBeenCalled();
  });

  it("ignores a stale persistence restore after the scope changes", async () => {
    const createManifest = (payloadKey: string, elementId: string) =>
      JSON.stringify({
        version: 4,
        revision: `revision-${elementId}`,
        locked: false,
        images: [
          {
            index: 1,
            elementId,
            elementIds: [elementId],
            sourceType: "imported",
            createdAt: elementId === "image-a" ? 1 : 2,
            fileName: `${elementId}.png`,
            mimeType: "image/png",
            payloadKey,
          },
        ],
      });
    localStorage.setItem(
      "ai-workbench-reference-manifest:local%3Ascope-a",
      createManifest("reference:scope-a", "image-a"),
    );
    localStorage.setItem(
      "ai-workbench-reference-manifest:local%3Ascope-b",
      createManifest("reference:scope-b", "image-b"),
    );
    aiWorkbenchIDBMock.payloads.set(
      "reference:scope-a",
      new File(["A"], "image-a.png", { type: "image/png" }),
    );
    aiWorkbenchIDBMock.payloads.set(
      "reference:scope-b",
      new File(["B"], "image-b.png", { type: "image/png" }),
    );
    aiWorkbenchIDBMock.deferredKeyPart = "scope-a";
    const excalidrawAPI = createExcalidrawAPI();

    const view = render(
      <AIImageWorkbench
        persistenceScopeId="local:scope-a"
        excalidrawAPI={excalidrawAPI}
      />,
    );
    await waitFor(() => {
      expect(aiWorkbenchIDBMock.resolveDeferred).not.toBeNull();
    });

    view.rerender(
      <AIImageWorkbench
        persistenceScopeId="local:scope-b"
        excalidrawAPI={excalidrawAPI}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reference" }));
    await waitFor(() => {
      expect(screen.getByAltText("Reference #1")).toHaveAttribute(
        "src",
        expect.stringContaining("Qg=="),
      );
    });

    await act(async () => {
      aiWorkbenchIDBMock.resolveDeferred?.();
    });
    expect(screen.getByAltText("Reference #1")).toHaveAttribute(
      "src",
      expect.stringContaining("Qg=="),
    );
  });

  it("clears restored media when scope becomes null or changes from null", async () => {
    localStorage.setItem(
      "ai-workbench-reference-manifest:local%3Ascope-a",
      JSON.stringify({
        version: 4,
        revision: "revision-a",
        locked: true,
        images: [
          {
            index: 1,
            elementId: "image-a",
            elementIds: ["image-a"],
            sourceType: "imported",
            createdAt: 1,
            fileName: "image-a.png",
            mimeType: "image/png",
            payloadKey: "reference:scope-a",
          },
        ],
      }),
    );
    aiWorkbenchIDBMock.payloads.set(
      "reference:scope-a",
      new File(["A"], "image-a.png", { type: "image/png" }),
    );
    const excalidrawAPI = createExcalidrawAPI();
    const view = render(
      <AIImageWorkbench
        persistenceScopeId="local:scope-a"
        excalidrawAPI={excalidrawAPI}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reference" }));
    await waitFor(() => {
      expect(screen.getByAltText("Reference #1")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Locked" }),
      ).toBeInTheDocument();
    });

    view.rerender(
      <AIImageWorkbench
        persistenceScopeId={null}
        excalidrawAPI={excalidrawAPI}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByAltText("Reference #1")).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Unlocked" }),
      ).toBeInTheDocument();
    });

    view.rerender(
      <AIImageWorkbench
        persistenceScopeId="local:scope-b"
        excalidrawAPI={excalidrawAPI}
      />,
    );
    await act(async () => {});
    expect(screen.queryByAltText("Reference #1")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Unlocked" }),
    ).toBeInTheDocument();
  });

  it("restores masks when references are damaged and persists a later reference edit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    localStorage.setItem(
      "ai-workbench-reference-manifest:local%3Aisolated-reference-failure",
      JSON.stringify({
        version: 4,
        revision: "broken-reference-revision",
        locked: true,
        images: [
          {
            index: 1,
            elementId: "broken-reference",
            elementIds: ["broken-reference"],
            sourceType: "imported",
            createdAt: 1,
            fileName: "broken.png",
            mimeType: "image/png",
            payloadKey: "reference:broken",
          },
        ],
      }),
    );
    localStorage.setItem(
      "ai-workbench-mask-manifest:local%3Aisolated-reference-failure",
      JSON.stringify({
        version: 2,
        revision: "valid-mask-revision",
        masks: [
          {
            imageId: "image-1",
            updatedAt: 1,
            fileName: "restored-mask.png",
            mimeType: "image/png",
            payloadKey: "mask:valid",
          },
        ],
      }),
    );
    aiWorkbenchIDBMock.payloads.set("mask:valid", {
      blob: new File(["mask"], "restored-mask.png", { type: "image/png" }),
      elements: [],
    });
    aiWorkbenchIDBMock.rejectedKeyPart = "reference:broken";

    render(
      <AIImageWorkbench
        persistenceScopeId="local:isolated-reference-failure"
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

    fireEvent.click(screen.getByRole("button", { name: "Inpaint" }));
    await waitFor(() => {
      expect(screen.getByText("Mask: restored-mask.png")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "Reference" }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Unlocked" }),
      ).toBeInTheDocument();
    });
    expect(
      JSON.parse(
        localStorage.getItem(
          "ai-workbench-reference-manifest:local%3Aisolated-reference-failure",
        )!,
      ).revision,
    ).toBe("broken-reference-revision");

    fireEvent.click(screen.getByRole("button", { name: "Unlocked" }));
    await waitFor(() => {
      expect(
        JSON.parse(
          localStorage.getItem(
            "ai-workbench-reference-manifest:local%3Aisolated-reference-failure",
          )!,
        ).revision,
      ).not.toBe("broken-reference-revision");
    });
  });

  it("restores references when masks are damaged and persists a later mask edit", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let maskReadyHandler: ((payload: AIMaskReadyPayload) => void) | null = null;
    localStorage.setItem(
      "ai-workbench-reference-manifest:local%3Aisolated-mask-failure",
      JSON.stringify({
        version: 4,
        revision: "valid-reference-revision",
        locked: true,
        images: [
          {
            index: 1,
            elementId: "image-1",
            elementIds: ["image-1"],
            sourceType: "imported",
            createdAt: 1,
            fileName: "reference.png",
            mimeType: "image/png",
            payloadKey: "reference:valid",
          },
        ],
      }),
    );
    localStorage.setItem(
      "ai-workbench-mask-manifest:local%3Aisolated-mask-failure",
      JSON.stringify({
        version: 2,
        revision: "broken-mask-revision",
        masks: [
          {
            imageId: "image-1",
            updatedAt: 1,
            fileName: "broken-mask.png",
            mimeType: "image/png",
            payloadKey: "mask:broken",
          },
        ],
      }),
    );
    aiWorkbenchIDBMock.payloads.set(
      "reference:valid",
      new File(["reference"], "reference.png", { type: "image/png" }),
    );
    aiWorkbenchIDBMock.rejectedKeyPart = "mask:broken";

    render(
      <AIImageWorkbench
        persistenceScopeId="local:isolated-mask-failure"
        excalidrawAPI={createExcalidrawAPI()}
        onMaskReady={(handler) => {
          maskReadyHandler = handler;
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inpaint" }));
    await waitFor(() => {
      expect(screen.getByAltText("Reference #1")).toBeInTheDocument();
      expect(maskReadyHandler).not.toBeNull();
    });
    expect(
      JSON.parse(
        localStorage.getItem(
          "ai-workbench-mask-manifest:local%3Aisolated-mask-failure",
        )!,
      ).revision,
    ).toBe("broken-mask-revision");

    act(() => {
      maskReadyHandler?.({
        imageId: "image-1",
        maskFile: new File(["new-mask"], "new-mask.png", {
          type: "image/png",
        }),
        maskElements: [],
      });
    });
    await waitFor(() => {
      expect(
        JSON.parse(
          localStorage.getItem(
            "ai-workbench-mask-manifest:local%3Aisolated-mask-failure",
          )!,
        ).revision,
      ).not.toBe("broken-mask-revision");
    });
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

    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Reference" }));
    typePrompt("Use the selected reference");

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

  it("enables video generation controls while audio stays preview-only", () => {
    render(<AIImageWorkbench excalidrawAPI={createExcalidrawAPI()} />);

    fireEvent.click(screen.getByRole("button", { name: "Video" }));

    expect(
      screen.getByPlaceholderText("Describe the video to generate..."),
    ).not.toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Generate video" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Audio" }));

    expect(screen.getByPlaceholderText("Audio preview only")).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Audio preview only" }),
    ).toBeDisabled();
  });

  it("guards video submission against synchronous re-entry", () => {
    saveAIImageConfig(createVideoConfig());
    vi.mocked(submitVideoTask).mockImplementation(() => new Promise(() => {}));

    render(<AIImageWorkbench excalidrawAPI={createExcalidrawAPI()} />);
    prepareVideoGeneration();

    const generateButton = screen.getByRole("button", {
      name: "Generate video",
    });

    act(() => {
      fireEvent.click(generateButton);
      fireEvent.click(generateButton);
    });

    expect(submitVideoTask).toHaveBeenCalledTimes(1);
    expect(generateButton).toBeDisabled();
  });

  it("cancels an in-flight video submission", async () => {
    saveAIImageConfig(createVideoConfig());
    const submissionSignalRef: { current: AbortSignal | null } = {
      current: null,
    };
    vi.mocked(submitVideoTask).mockImplementation(({ signal }) => {
      submissionSignalRef.current = signal || null;

      return new Promise((_, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    });

    render(<AIImageWorkbench excalidrawAPI={createExcalidrawAPI()} />);
    prepareVideoGeneration();
    fireEvent.click(screen.getByRole("button", { name: "Generate video" }));

    await waitFor(() => {
      expect(submissionSignalRef.current).not.toBeNull();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(submissionSignalRef.current?.aborted).toBe(true);
      expect(screen.getByText("Generation canceled.")).toBeInTheDocument();
    });
    expect(loadPendingVideoTasks()).toEqual([]);
  });

  it("times out video submission using the model request timeout", async () => {
    vi.useFakeTimers();
    saveAIImageConfig(createVideoConfig(1));
    const submissionSignalRef: { current: AbortSignal | null } = {
      current: null,
    };
    vi.mocked(submitVideoTask).mockImplementation(({ signal }) => {
      submissionSignalRef.current = signal || null;

      return new Promise((_, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    });

    render(<AIImageWorkbench excalidrawAPI={createExcalidrawAPI()} />);
    prepareVideoGeneration();
    fireEvent.click(screen.getByRole("button", { name: "Generate video" }));

    expect(submissionSignalRef.current).not.toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(submissionSignalRef.current?.aborted).toBe(true);
    expect(
      screen.getByText("Generation timed out after 1 seconds."),
    ).toBeInTheDocument();
    expect(loadAIGenerationLogs()[0]).toMatchObject({
      mediaType: "video",
      mode: "text-to-video",
      status: "failed",
    });
    vi.useRealTimers();
  });

  it("aborts an in-flight video submission on unmount", async () => {
    saveAIImageConfig(createVideoConfig());
    let submissionSignal: AbortSignal | undefined;
    vi.mocked(submitVideoTask).mockImplementation(({ signal }) => {
      submissionSignal = signal;
      return new Promise((_, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    });

    const { unmount } = render(
      <AIImageWorkbench excalidrawAPI={createExcalidrawAPI()} />,
    );
    prepareVideoGeneration();
    fireEvent.click(screen.getByRole("button", { name: "Generate video" }));

    await waitFor(() => expect(submissionSignal).toBeDefined());
    unmount();

    expect(submissionSignal?.aborted).toBe(true);
    expect(loadPendingVideoTasks()).toEqual([]);
  });
  it("keeps a video task and retries after a transient poll error", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    saveAIImageConfig(createVideoConfig());
    vi.mocked(submitVideoTask).mockResolvedValue({
      taskId: "video-retry",
      endpoint: "https://example.com/v1/videos",
      model: "test-video-model",
    });
    vi.mocked(pollVideoTask)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockImplementation(() => new Promise(() => {}));

    const { unmount } = render(
      <AIImageWorkbench excalidrawAPI={createExcalidrawAPI()} />,
    );
    prepareVideoGeneration();
    fireEvent.click(screen.getByRole("button", { name: "Generate video" }));

    await act(async () => {});
    expect(pollVideoTask).toHaveBeenCalledTimes(1);
    expect(loadPendingVideoTasks()).toEqual([
      expect.objectContaining({ taskId: "video-retry" }),
    ]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(pollVideoTask).toHaveBeenCalledTimes(2);
    expect(loadPendingVideoTasks()).toEqual([
      expect.objectContaining({ taskId: "video-retry" }),
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      "AI video task polling failed; retrying.",
    );

    unmount();
    vi.useRealTimers();
  });

  it("times out a stuck poll request and retries without losing the task", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    saveAIImageConfig(createVideoConfig(1));
    vi.mocked(submitVideoTask).mockResolvedValue({
      taskId: "video-stuck-poll",
      endpoint: "https://example.com/v1/videos",
      model: "test-video-model",
    });
    vi.mocked(pollVideoTask).mockImplementation(
      ({ signal }) =>
        new Promise((_, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );

    const { unmount } = render(
      <AIImageWorkbench excalidrawAPI={createExcalidrawAPI()} />,
    );
    prepareVideoGeneration();
    fireEvent.click(screen.getByRole("button", { name: "Generate video" }));

    await act(async () => {});
    expect(pollVideoTask).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(pollVideoTask).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalledWith(
      "AI video task polling failed; retrying.",
    );
    expect(loadPendingVideoTasks()).toEqual([
      expect.objectContaining({ taskId: "video-stuck-poll" }),
    ]);

    unmount();
    vi.useRealTimers();
  });

  it("records image-to-video as the actual video log mode", async () => {
    saveAIImageConfig(createVideoConfig());
    vi.mocked(submitVideoTask).mockResolvedValue({
      taskId: "video-image-mode",
      endpoint: "https://example.com/v1/videos",
      model: "test-video-model",
    });
    vi.mocked(pollVideoTask).mockResolvedValue({
      status: "failed",
      error: "Provider rejected the task",
    });

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
    prepareVideoGeneration("Animate the selected image");
    fireEvent.click(screen.getByRole("button", { name: "Generate video" }));

    await waitFor(() => {
      expect(loadAIGenerationLogs()[0]).toMatchObject({
        mediaType: "video",
        mode: "image-to-video",
        status: "failed",
      });
    });
    expect(submitVideoTask).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "image-to-video" }),
    );
  });

  it("persists a completed cloud video before inserting v2 asset metadata", async () => {
    saveAIImageConfig(createVideoConfig());
    vi.mocked(submitVideoTask).mockResolvedValue({
      taskId: "video-asset-task",
      endpoint: "https://example.com/v1/videos",
      model: "test-video-model",
    });
    vi.mocked(pollVideoTask).mockResolvedValue({
      status: "completed",
      videoURL:
        "https://provider.example/output?X-Amz-Signature=provider-secret",
      durationSeconds: 6,
    });
    const onPersistVideoOutput = vi.fn().mockResolvedValue({
      assetId: "stable-video-asset",
      mimeType: "video/mp4",
      bytes: 4096,
    });

    render(
      <AIImageWorkbench
        excalidrawAPI={createExcalidrawAPI()}
        onPersistVideoOutput={onPersistVideoOutput}
      />,
    );
    prepareVideoGeneration();
    fireEvent.click(screen.getByRole("button", { name: "Generate video" }));

    await waitFor(() => {
      expect(insertVideoEmbedIntoCanvas).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            version: 2,
            assetId: "stable-video-asset",
            width: 1280,
            height: 720,
          }),
        }),
      );
    });
    const inserted = vi.mocked(insertVideoEmbedIntoCanvas).mock.calls[0][0];
    expect(JSON.stringify(inserted.metadata)).not.toContain("provider-secret");
    expect(onPersistVideoOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "video-asset-task",
        output: expect.objectContaining({ mimeType: "video/mp4" }),
      }),
    );
    expect(loadPendingVideoTasks()).toEqual([]);
  });

  it("keeps a completed task when video persistence is not configured", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    saveAIImageConfig(createVideoConfig());
    vi.mocked(submitVideoTask).mockResolvedValue({
      taskId: "video-missing-persistence",
      endpoint: "https://example.com/v1/videos",
      model: "test-video-model",
    });
    vi.mocked(pollVideoTask).mockResolvedValue({
      status: "completed",
      videoURL: "https://provider.example/output?token=temporary",
    });

    render(<AIImageWorkbench excalidrawAPI={createExcalidrawAPI()} />);
    prepareVideoGeneration();
    fireEvent.click(screen.getByRole("button", { name: "Generate video" }));

    await waitFor(() => {
      expect(loadPendingVideoTasks()).toEqual([
        expect.objectContaining({ taskId: "video-missing-persistence" }),
      ]);
      expect(errorSpy).toHaveBeenCalled();
    });
    expect(insertVideoEmbedIntoCanvas).not.toHaveBeenCalled();
    expect(loadAIGenerationLogs()).toEqual([]);
  });

  it("keeps a completed task when persistence returns no asset", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    saveAIImageConfig(createVideoConfig());
    vi.mocked(submitVideoTask).mockResolvedValue({
      taskId: "video-null-persistence",
      endpoint: "https://example.com/v1/videos",
      model: "test-video-model",
    });
    vi.mocked(pollVideoTask).mockResolvedValue({
      status: "completed",
      videoURL: "https://provider.example/output?token=temporary",
    });

    render(
      <AIImageWorkbench
        excalidrawAPI={createExcalidrawAPI()}
        onPersistVideoOutput={vi.fn().mockResolvedValue(null)}
      />,
    );
    prepareVideoGeneration();
    fireEvent.click(screen.getByRole("button", { name: "Generate video" }));

    await waitFor(() => {
      expect(loadPendingVideoTasks()).toEqual([
        expect.objectContaining({ taskId: "video-null-persistence" }),
      ]);
      expect(errorSpy).toHaveBeenCalled();
    });
    expect(insertVideoEmbedIntoCanvas).not.toHaveBeenCalled();
    expect(loadAIGenerationLogs()).toEqual([]);
  });

  it("does not insert or clear a completed task after its context is aborted", async () => {
    saveAIImageConfig(createVideoConfig());
    vi.mocked(submitVideoTask).mockResolvedValue({
      taskId: "video-context-changed",
      endpoint: "https://example.com/v1/videos",
      model: "test-video-model",
    });
    vi.mocked(pollVideoTask).mockResolvedValue({
      status: "completed",
      videoURL: "https://provider.example/output?token=temporary",
    });

    render(
      <AIImageWorkbench
        excalidrawAPI={createExcalidrawAPI()}
        onPersistVideoOutput={vi
          .fn()
          .mockRejectedValue(
            new DOMException(
              "AI video persistence context changed.",
              "AbortError",
            ),
          )}
      />,
    );
    prepareVideoGeneration();
    fireEvent.click(screen.getByRole("button", { name: "Generate video" }));

    await waitFor(() => {
      expect(loadPendingVideoTasks()).toEqual([
        expect.objectContaining({ taskId: "video-context-changed" }),
      ]);
    });
    expect(insertVideoEmbedIntoCanvas).not.toHaveBeenCalled();
    expect(loadAIGenerationLogs()).toEqual([]);
  });

  it("recovers from a transient poll error and inserts the completed asset", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    saveAIImageConfig(createVideoConfig());
    vi.mocked(submitVideoTask).mockResolvedValue({
      taskId: "video-retry-completed",
      endpoint: "https://example.com/v1/videos",
      model: "test-video-model",
    });
    vi.mocked(pollVideoTask)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({
        status: "completed",
        videoURL: "https://provider.example/output?token=temporary",
      });
    const onPersistVideoOutput = vi.fn().mockResolvedValue({
      assetId: "stable-retry-asset",
      mimeType: "video/mp4",
      bytes: 4096,
    });

    render(
      <AIImageWorkbench
        excalidrawAPI={createExcalidrawAPI()}
        onPersistVideoOutput={onPersistVideoOutput}
      />,
    );
    prepareVideoGeneration();
    fireEvent.click(screen.getByRole("button", { name: "Generate video" }));

    await act(async () => {});
    expect(pollVideoTask).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(warnSpy).toHaveBeenCalled();
    expect(onPersistVideoOutput).toHaveBeenCalled();
    expect(insertVideoEmbedIntoCanvas).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          version: 2,
          assetId: "stable-retry-asset",
        }),
      }),
    );
    expect(loadPendingVideoTasks()).toEqual([]);
    vi.useRealTimers();
  });
  it("keeps a completed task recoverable when cloud video persistence fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    saveAIImageConfig(createVideoConfig());
    vi.mocked(submitVideoTask).mockResolvedValue({
      taskId: "video-persist-retry",
      endpoint: "https://example.com/v1/videos",
      model: "test-video-model",
    });
    vi.mocked(pollVideoTask).mockResolvedValue({
      status: "completed",
      videoURL: "https://provider.example/output?token=temporary",
    });

    render(
      <AIImageWorkbench
        excalidrawAPI={createExcalidrawAPI()}
        onPersistVideoOutput={vi
          .fn()
          .mockRejectedValue(new Error("asset ingest unavailable"))}
      />,
    );
    prepareVideoGeneration();
    fireEvent.click(screen.getByRole("button", { name: "Generate video" }));

    await waitFor(() => {
      expect(loadPendingVideoTasks()).toEqual([
        expect.objectContaining({ taskId: "video-persist-retry" }),
      ]);
      expect(errorSpy).toHaveBeenCalled();
    });
    expect(insertVideoEmbedIntoCanvas).not.toHaveBeenCalled();
  });

  it("rejects malformed generation outputs before inserting", async () => {
    vi.mocked(generateImagesWithOpenAIAdapter).mockResolvedValue([
      { dataURL: "" } as AIImageGenerationOutput,
    ]);

    render(<AIImageWorkbench excalidrawAPI={createExcalidrawAPI()} />);

    typePrompt("A malformed provider response");
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
