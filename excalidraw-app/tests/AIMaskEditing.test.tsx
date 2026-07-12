import { createRef, useMemo, useRef, useState } from "react";

import { KEYS } from "@excalidraw/common";
import { Excalidraw, CaptureUpdateAction } from "@excalidraw/excalidraw";
import { getDefaultAppState } from "@excalidraw/excalidraw/appState";
import { defaultLang, setLanguage } from "@excalidraw/excalidraw/i18n";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { Keyboard } from "@excalidraw/excalidraw/tests/helpers/ui";
import {
  act,
  fireEvent,
  render as renderExcalidraw,
  screen,
} from "@excalidraw/excalidraw/tests/test-utils";
import { render as rtlRender, waitFor } from "@testing-library/react";
import { pointFrom } from "@excalidraw/math";
import { vi } from "vitest";

import type {
  AppState,
  BinaryFileData,
  DataURL,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  ExcalidrawFreeDrawElement,
  FileId,
} from "@excalidraw/element/types";
import type { LocalPoint } from "@excalidraw/math";

import { STORAGE_KEYS } from "../app_constants";
import * as maskCanvas from "../ai/maskCanvas";
import {
  AIMaskEditingController,
  type AIMaskEditingControllerHandle,
} from "../components/AIMaskEditingController";
import {
  AIMaskEditingOverlay,
  type AIMaskEditingTargetBounds,
} from "../components/AIMaskEditingOverlay";
import { createMaskViewportGeometry } from "../ai/maskViewportGeometry";
import {
  AIImageWorkbench,
  createInitialAIImageWorkbenchDraftState,
} from "../components/AIImageWorkbench";

import type { AIMaskReadyPayload } from "../ai/types";

const TEST_FILE_ID = "mask-test-file" as FileId;
const SECOND_TEST_FILE_ID = "mask-test-file-2" as FileId;
const TEST_IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lw9H8wAAAABJRU5ErkJggg==" as DataURL;

// The prompt input is a contenteditable <div> (aria-label "Prompt"), not a
// <textarea>: it has no placeholder attr and isn't a form control, so
// getByPlaceholderText / fireEvent.change / toHaveValue don't apply. Set its
// text and dispatch the `input` event the editor listens for; read textContent.
const getPromptEditor = () => screen.getByLabelText("Prompt");
const typePrompt = (value: string) => {
  const editor = getPromptEditor();
  editor.textContent = value;
  fireEvent.input(editor);
};
const expectPromptValue = (value: string) => {
  expect(getPromptEditor().textContent).toBe(value);
};

const targetImage = API.createElement({
  type: "image",
  id: "target-image",
  fileId: TEST_FILE_ID,
  x: 40,
  y: 60,
  width: 120,
  height: 90,
  status: "saved",
});

const movedTargetImage = {
  ...targetImage,
  x: 90,
  y: 100,
};

const secondTargetImage = API.createElement({
  type: "image",
  id: "second-target-image",
  fileId: SECOND_TEST_FILE_ID,
  x: 220,
  y: 60,
  width: 120,
  height: 90,
  status: "saved",
});

const imageFile: BinaryFileData = {
  id: TEST_FILE_ID,
  dataURL: TEST_IMAGE_DATA_URL,
  mimeType: "image/png",
  created: 1,
  lastRetrieved: 1,
};

const secondImageFile: BinaryFileData = {
  ...imageFile,
  id: SECOND_TEST_FILE_ID,
};

describe("AI mask editing", () => {
  beforeEach(() => {
    vi.stubGlobal("Image", MaskSourceImage);
    localStorage.clear();
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_AI_IMAGE,
      JSON.stringify({
        baseURL: "https://example.test/v1",
        apiKey: "test-key",
        defaultModel: "inpaint-model",
        models: [
          {
            id: "inpaint-model",
            siteName: "Test provider",
            baseURL: "https://example.test/v1",
            apiKey: "test-key",
            model: "test-inpaint-model",
            label: "Test inpaint model",
            mediaType: "image",
            capabilities: ["text-to-image", "image-to-image", "inpaint"],
            requestTimeoutSeconds: 600,
          },
        ],
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("blocks real editor tools, deletion, transforms, and history while editing", async () => {
    const controllerRef = createRef<AIMaskEditingControllerHandle>();
    let realAPI: ExcalidrawImperativeAPI | null = null;

    await renderExcalidraw(
      <RealExcalidrawMaskHarness
        controllerRef={controllerRef}
        onAPI={(api) => {
          realAPI = api;
        }}
      />,
    );
    await waitFor(() => {
      expect(realAPI).not.toBeNull();
      expect(controllerRef.current).not.toBeNull();
    });

    act(() => {
      realAPI!.updateScene({
        appState: { selectedElementIds: { [targetImage.id]: true } },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    });
    const beforeElement = realAPI!.getSceneElements()[0];
    const beforeTool = realAPI!.getAppState().activeTool;
    const beforeSelection = realAPI!.getAppState().selectedElementIds;
    const beforeUndoLength = API.getUndoStack().length;
    const beforeRedoLength = API.getRedoStack().length;

    act(() => {
      controllerRef.current!.requestEnterMaskEditing(targetImage.id);
    });
    await waitFor(() => {
      expect(screen.getByText(/Drawing \(white brush\)/)).toBeInTheDocument();
    });

    Keyboard.keyPress("r");
    Keyboard.keyPress("h");
    Keyboard.keyPress("k");
    Keyboard.keyPress(KEYS.DELETE);
    Keyboard.keyPress(KEYS.ARROW_RIGHT);
    Keyboard.undo();
    Keyboard.redo();

    const doneButton = screen.getByRole("button", { name: "Done" });
    doneButton.focus();
    Keyboard.keyPress(KEYS.DELETE, doneButton);
    Keyboard.keyPress("r", doneButton);
    Keyboard.keyPress(KEYS.ARROW_RIGHT, doneButton);

    const brushSizeSlider = screen.getByRole("slider", {
      name: "Brush size",
    });
    brushSizeSlider.focus();
    Keyboard.keyPress(KEYS.DELETE, brushSizeSlider);
    Keyboard.keyPress("v", brushSizeSlider);
    Keyboard.keyPress(KEYS.ARROW_RIGHT, brushSizeSlider);
    Keyboard.keyPress(KEYS.TAB, brushSizeSlider);
    expect(doneButton).toHaveFocus();
    await act(async () => {});

    expect(realAPI!.getAppState().activeTool).toEqual(beforeTool);
    expect(realAPI!.getAppState().selectedElementIds).toEqual(beforeSelection);
    expect(realAPI!.getSceneElements()[0]).toEqual(beforeElement);
    expect(API.getUndoStack()).toHaveLength(beforeUndoLength);
    expect(API.getRedoStack()).toHaveLength(beforeRedoLength);
  });

  it("cancels mask editing if the target geometry changes externally", async () => {
    const controllerRef = createRef<AIMaskEditingControllerHandle>();
    let realAPI: ExcalidrawImperativeAPI | null = null;

    await renderExcalidraw(
      <RealExcalidrawMaskHarness
        controllerRef={controllerRef}
        onAPI={(api) => {
          realAPI = api;
        }}
      />,
    );
    await waitFor(() => {
      expect(realAPI).not.toBeNull();
      expect(controllerRef.current).not.toBeNull();
    });

    act(() => {
      controllerRef.current!.requestEnterMaskEditing(targetImage.id);
    });
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    const currentTarget = realAPI!.getSceneElements()[0];
    act(() => {
      realAPI!.updateScene({
        elements: [{ ...currentTarget, x: currentTarget.x + 25 }],
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(realAPI!.getSceneElements()[0].x).toBe(currentTarget.x + 25);
  });

  it("enters mask editing from the workbench and restores state on cancel", async () => {
    rtlRender(<MaskEditingHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Inpaint" }));
    await flushReact();

    const editMaskButton = screen.getByRole("button", {
      name: "Edit mask on canvas",
    });
    fireEvent.click(editMaskButton);

    await flushReact();
    screen.getByText(/Drawing \(white brush\)/);
    expect(screen.getByTestId("active-tool").textContent).toBe("freedraw");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await flushReact();
    expect(screen.queryByText(/Drawing \(white brush\)/)).toBeNull();
    expect(screen.getByTestId("active-tool").textContent).toBe("rectangle");
    expect(screen.getByTestId("selected-element").textContent).toBe(
      targetImage.id,
    );
  });

  it("keeps selected image references after canvas deselection until the card remove button is used", async () => {
    rtlRender(<ReferenceQueueHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Reference" }));
    await flushReact();

    expect(screen.getByAltText("Reference #1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Deselect canvas" }));
    await flushReact();

    expect(screen.getByAltText("Reference #1")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Remove reference #1" }),
    );
    await flushReact();

    expect(screen.queryByAltText("Reference #1")).not.toBeInTheDocument();
  });

  it("shows erasing state, brush size control, and mask preview", () => {
    const onBrushSizeChange = vi.fn();
    const onMaskPointerDown = vi.fn();
    const onMaskPointerMove = vi.fn();
    const onMaskPointerUp = vi.fn();

    rtlRender(
      <AIMaskEditingOverlay
        targetImageId={targetImage.id}
        targetBounds={createMaskViewportGeometry({
          centerX: 100,
          centerY: 105,
          width: 120,
          height: 90,
          angle: 0,
        })}
        isErasing={true}
        brushSize={32}
        zoomValue={1}
        maskPreviewDataURL={TEST_IMAGE_DATA_URL}
        isDonePending={false}
        onBrushSizeChange={onBrushSizeChange}
        onDone={() => undefined}
        onCancel={() => undefined}
        onMaskPointerDown={onMaskPointerDown}
        onMaskPointerMove={onMaskPointerMove}
        onMaskPointerUp={onMaskPointerUp}
      />,
    );

    expect(screen.getByText(/Erasing mask/)).toBeInTheDocument();
    expect(screen.getByText("Brush size: 32px")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Mask preview" })).toHaveAttribute(
      "src",
      TEST_IMAGE_DATA_URL,
    );
    expect(
      document.querySelector(".AIMaskEditingOverlay__canvasMask"),
    ).not.toBeNull();

    fireEvent.pointerMove(window, { clientX: 80, clientY: 90 });
    expect(
      document.querySelector(".AIMaskEditingOverlay__brushCursor"),
    ).toHaveStyle({
      width: "32px",
      height: "32px",
    });

    fireEvent.change(screen.getByRole("slider", { name: "Brush size" }), {
      target: { value: "44" },
    });

    expect(onBrushSizeChange).toHaveBeenCalledWith(44);

    const drawingSurface = screen.getByTestId("mask-drawing-surface");
    fireEvent.pointerDown(drawingSurface, {
      pointerId: 1,
      button: 0,
      clientX: 80,
      clientY: 90,
    });
    fireEvent.pointerDown(drawingSurface, {
      pointerId: 2,
      button: 0,
      clientX: 85,
      clientY: 95,
    });
    fireEvent.pointerMove(drawingSurface, {
      pointerId: 2,
      clientX: 90,
      clientY: 100,
    });
    fireEvent.blur(window);

    expect(onMaskPointerDown).toHaveBeenCalledTimes(1);
    expect(onMaskPointerMove).not.toHaveBeenCalled();
    expect(onMaskPointerUp).toHaveBeenCalledTimes(1);
  });

  it("uses localized copy for all visible mask editing controls", async () => {
    await act(async () => {
      await setLanguage({ code: "__test__", label: "test language" });
    });

    try {
      rtlRender(
        <AIMaskEditingOverlay
          targetImageId={targetImage.id}
          targetBounds={createMaskViewportGeometry({
            centerX: 100,
            centerY: 105,
            width: 120,
            height: 90,
            angle: 0,
          })}
          isErasing={true}
          brushSize={32}
          zoomValue={1}
          maskPreviewDataURL={TEST_IMAGE_DATA_URL}
          isDonePending={false}
          onBrushSizeChange={() => undefined}
          onDone={() => undefined}
          onCancel={() => undefined}
          onMaskPointerDown={() => undefined}
          onMaskPointerMove={() => undefined}
          onMaskPointerUp={() => undefined}
        />,
      );

      expect(
        screen.getByText(/\[\[ai\.workbench\.maskEditor\.erasing\]\]/),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", {
          name: /\[\[ai\.workbench\.maskEditor\.done\]\]/,
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", {
          name: /\[\[ai\.workbench\.maskEditor\.cancel\]\]/,
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          /\[\[ai\.workbench\.maskEditor\.brushSize\("size":32\)\]\]/,
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("slider", {
          name: /\[\[ai\.workbench\.maskEditor\.brushSizeLabel\]\]/,
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("img", {
          name: /\[\[ai\.workbench\.maskEditor\.preview\]\]/,
        }),
      ).toBeInTheDocument();
    } finally {
      await act(async () => {
        await setLanguage(defaultLang);
      });
    }
  });

  it("toggles the in-memory eraser mode without changing editor drawing state", async () => {
    rtlRender(<MaskEditingControllerHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Start mask editing" }));

    await flushReact();
    screen.getByText(/Drawing \(white brush\)/);
    const initialStrokeColor =
      screen.getByTestId("mask-stroke-color").textContent;
    const initialStrokeWidth =
      screen.getByTestId("mask-stroke-width").textContent;

    fireEvent.keyDown(window, { key: "e" });

    await flushReact();
    screen.getByText(/Erasing mask/);
    expect(screen.getByTestId("mask-stroke-color").textContent).toBe(
      initialStrokeColor,
    );

    fireEvent.change(screen.getByRole("slider", { name: "Brush size" }), {
      target: { value: "36" },
    });

    await flushReact();
    expect(screen.getByTestId("mask-stroke-width").textContent).toBe(
      initialStrokeWidth,
    );
  });

  it("exports a mask on done, clears temporary strokes, and hands it to the workbench", async () => {
    rtlRender(<MaskEditingDoneHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Inpaint" }));
    await flushReact();

    const editMaskButton = screen.getByRole("button", {
      name: "Edit mask on canvas",
    });
    fireEvent.click(editMaskButton);

    await flushReact();
    screen.getByText(/Drawing \(white brush\)/);
    const drawingSurface = screen.getByTestId("mask-drawing-surface");
    fireEvent.pointerDown(drawingSurface, {
      pointerId: 1,
      button: 0,
      clientX: 80,
      clientY: 90,
    });
    fireEvent.pointerMove(drawingSurface, {
      pointerId: 1,
      clientX: 110,
      clientY: 105,
    });
    fireEvent.pointerUp(drawingSurface, {
      pointerId: 1,
      clientX: 110,
      clientY: 105,
    });
    fireEvent.keyDown(window, { key: "e" });

    await flushReact();
    screen.getByText(/Erasing mask/);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => {
      expect(
        screen.getByText("Mask: mask-target-image.png"),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("mask-element-count")).toHaveTextContent("1");
    expect(screen.getByTestId("scene-element-ids")).toHaveTextContent(
      targetImage.id,
    );
    expect(screen.getByTestId("scene-element-ids")).not.toHaveTextContent(
      "mask-stroke",
    );
  });

  it("keeps mask strokes out of the scene and supports session undo", async () => {
    rtlRender(<MaskEditingDoneHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Inpaint" }));
    await flushReact();
    fireEvent.click(
      screen.getByRole("button", { name: "Edit mask on canvas" }),
    );
    await flushReact();

    const drawingSurface = screen.getByTestId("mask-drawing-surface");
    const drawStroke = (pointerId: number, offset: number) => {
      fireEvent.pointerDown(drawingSurface, {
        pointerId,
        button: 0,
        clientX: 75 + offset,
        clientY: 85 + offset,
      });
      fireEvent.pointerMove(drawingSurface, {
        pointerId,
        clientX: 95 + offset,
        clientY: 100 + offset,
      });
      fireEvent.pointerUp(drawingSurface, {
        pointerId,
        clientX: 95 + offset,
        clientY: 100 + offset,
      });
    };

    drawStroke(1, 0);
    drawStroke(2, 10);
    expect(screen.getByTestId("scene-element-ids")).toHaveTextContent(
      targetImage.id,
    );
    expect(screen.getByTestId("scene-element-ids")).not.toHaveTextContent(
      "freedraw",
    );

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => {
      expect(screen.getByTestId("mask-element-count")).toHaveTextContent("1");
    });
  });

  it("cancels the in-memory mask session with Escape", async () => {
    rtlRender(<MaskEditingControllerHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Start mask editing" }));
    await flushReact();
    expect(screen.getByTestId("mask-drawing-surface")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await flushReact();

    expect(screen.queryByTestId("mask-drawing-surface")).toBeNull();
  });

  it("preserves AI image workbench draft state after the tab unmounts", () => {
    rtlRender(<PersistentWorkbenchHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Inpaint" }));
    typePrompt("blue circle");

    fireEvent.click(screen.getByRole("button", { name: "Hide workbench" }));
    expect(screen.queryByPlaceholderText("Describe the image")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Show workbench" }));

    expect(screen.getByRole("button", { name: "Inpaint" })).toHaveClass(
      "is-selected",
    );
    expectPromptValue("blue circle");
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("keeps text, reference, and inpaint image drafts independent", () => {
    const config = JSON.parse(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_AI_IMAGE) || "{}",
    );
    config.models.push({
      id: "text-only-model",
      siteName: "Text provider",
      baseURL: "https://example.test/v1",
      apiKey: "test-key",
      model: "test-text-model",
      label: "Text only model",
      mediaType: "image",
      capabilities: ["text-to-image"],
      requestTimeoutSeconds: 600,
    });
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_AI_IMAGE,
      JSON.stringify(config),
    );

    rtlRender(<PersistentWorkbenchHarness />);

    fireEvent.change(screen.getByLabelText("Model ID"), {
      target: { value: "text-only-model" },
    });
    typePrompt("text prompt");

    fireEvent.click(screen.getByRole("button", { name: "Inpaint" }));

    expect(screen.getByLabelText("Model ID")).toHaveValue("inpaint-model");
    expectPromptValue("");

    typePrompt("inpaint prompt");
    fireEvent.click(screen.getByRole("button", { name: "Reference" }));

    expectPromptValue("");

    fireEvent.click(screen.getByRole("button", { name: "Text" }));

    expect(screen.getByLabelText("Model ID")).toHaveValue("text-only-model");
    expectPromptValue("text prompt");

    fireEvent.click(screen.getByRole("button", { name: "Inpaint" }));

    expectPromptValue("inpaint prompt");
  });

  it("binds saved masks to the selected image and passes strokes for re-editing", () => {
    const onEnterMaskEditing = vi.fn();

    rtlRender(
      <ImageBoundMaskWorkbenchHarness
        onEnterMaskEditing={onEnterMaskEditing}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inpaint" }));
    fireEvent.click(screen.getByRole("button", { name: "Attach first mask" }));

    expect(screen.getByText("Mask: mask-target-image.png")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Select second image" }),
    );

    expect(screen.queryByText("Mask: mask-target-image.png")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Clear mask" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Select first image" }));

    expect(screen.getByText("Mask: mask-target-image.png")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Re-edit mask on canvas" }),
    );

    expect(onEnterMaskEditing).toHaveBeenCalledWith(
      targetImage.id,
      expect.arrayContaining([expect.objectContaining({ id: "mask-stroke" })]),
    );
  });

  it("repositions saved mask strokes when the target image moved before re-editing", async () => {
    rtlRender(<MovedImageMaskControllerHarness />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Start moved image mask editing",
      }),
    );

    await flushReact();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => {
      expect(screen.getByTestId("editable-mask-position")).toHaveTextContent(
        "114,112",
      );
    });
    expect(screen.getByTestId("saved-mask-geometry-version")).toHaveTextContent(
      "2",
    );
  });

  it("invalidates a stale async export when a new mask session starts", async () => {
    const exportSignalRef: { current: AbortSignal | null } = { current: null };
    const resolveExportRef: { current: ((file: File) => void) | null } = {
      current: null,
    };
    vi.spyOn(maskCanvas, "exportMaskAsFile").mockImplementation(
      (_targetImage, _maskElements, _files, signal) => {
        exportSignalRef.current = signal || null;

        return new Promise<File>((resolve, reject) => {
          resolveExportRef.current = resolve;
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      },
    );

    rtlRender(<MovedImageMaskControllerHarness />);
    const startButton = screen.getByRole("button", {
      name: "Start moved image mask editing",
    });
    fireEvent.click(startButton);
    await flushReact();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => {
      expect(exportSignalRef.current).not.toBeNull();
    });
    fireEvent.click(startButton);
    await flushReact();

    expect(exportSignalRef.current?.aborted).toBe(true);
    resolveExportRef.current?.(
      new File(["mask"], "stale-mask.png", { type: "image/png" }),
    );
    await flushReact();

    expect(screen.getByTestId("mask-drawing-surface")).toBeInTheDocument();
    expect(screen.getByTestId("editable-mask-position")).toHaveTextContent("");
  });
});

const RealExcalidrawMaskHarness = ({
  controllerRef,
  onAPI,
}: {
  controllerRef: React.RefObject<AIMaskEditingControllerHandle | null>;
  onAPI: (api: ExcalidrawImperativeAPI) => void;
}) => {
  const [api, setAPI] = useState<ExcalidrawImperativeAPI | null>(null);

  return (
    <>
      <Excalidraw
        handleKeyboardGlobally
        initialData={{
          elements: [targetImage],
          files: { [imageFile.id]: imageFile },
        }}
        onExcalidrawAPI={(nextAPI) => {
          const resolvedAPI = nextAPI as ExcalidrawImperativeAPI;
          setAPI(resolvedAPI);
          onAPI(resolvedAPI);
        }}
      />
      <AIMaskEditingController ref={controllerRef} excalidrawAPI={api} />
    </>
  );
};
const MaskEditingHarness = () => {
  const [activeToolType, setActiveToolType] =
    useState<AppState["activeTool"]["type"]>("rectangle");
  const [selectedElementIds, setSelectedElementIds] = useState<
    AppState["selectedElementIds"]
  >({ [targetImage.id]: true });
  const [maskTargetBounds, setMaskTargetBounds] =
    useState<AIMaskEditingTargetBounds | null>(null);
  const previousStateRef = useRef<{
    activeToolType: AppState["activeTool"]["type"];
    selectedElementIds: AppState["selectedElementIds"];
  } | null>(null);
  const activeToolRef = useRef(activeToolType);
  const selectedElementIdsRef = useRef(selectedElementIds);

  activeToolRef.current = activeToolType;
  selectedElementIdsRef.current = selectedElementIds;

  const excalidrawAPI = useMemo(
    () =>
      ({
        getAppState: () => ({
          ...getDefaultAppState(),
          activeTool: {
            ...getDefaultAppState().activeTool,
            type: activeToolRef.current,
          },
          selectedElementIds: selectedElementIdsRef.current,
        }),
        getSceneElements: () => [targetImage] as readonly ExcalidrawElement[],
        getFiles: () => ({
          [TEST_FILE_ID]: imageFile,
        }),
        onChange: (callback: () => void) => {
          callback();
          return () => null;
        },
        setActiveTool: (tool: { type: AppState["activeTool"]["type"] }) => {
          setActiveToolType(tool.type);
        },
      } as unknown as ExcalidrawImperativeAPI),
    [],
  );

  return (
    <div>
      <AIImageWorkbench
        excalidrawAPI={excalidrawAPI}
        onEnterMaskEditing={(imageId) => {
          previousStateRef.current = {
            activeToolType: activeToolRef.current,
            selectedElementIds: selectedElementIdsRef.current,
          };
          excalidrawAPI.setActiveTool({ type: "freedraw" });
          setSelectedElementIds({ [imageId]: true });
          setMaskTargetBounds(
            createMaskViewportGeometry({
              centerX: 100,
              centerY: 105,
              width: 120,
              height: 90,
              angle: 0,
            }),
          );
        }}
      />
      {maskTargetBounds && (
        <AIMaskEditingOverlay
          targetImageId={targetImage.id}
          targetBounds={maskTargetBounds}
          isErasing={false}
          brushSize={20}
          zoomValue={1}
          maskPreviewDataURL={null}
          isDonePending={false}
          onBrushSizeChange={() => null}
          onDone={() => setMaskTargetBounds(null)}
          onCancel={() => {
            if (previousStateRef.current) {
              setActiveToolType(previousStateRef.current.activeToolType);
              setSelectedElementIds(
                previousStateRef.current.selectedElementIds,
              );
            }
            setMaskTargetBounds(null);
          }}
          onMaskPointerDown={() => null}
          onMaskPointerMove={() => null}
          onMaskPointerUp={() => null}
        />
      )}
      <div data-testid="active-tool">{activeToolType}</div>
      <div data-testid="selected-element">
        {Object.keys(selectedElementIds).join(",")}
      </div>
    </div>
  );
};

const ReferenceQueueHarness = () => {
  const changeListenersRef = useRef<
    Set<Parameters<ExcalidrawImperativeAPI["onChange"]>[0]>
  >(new Set());
  const [selectedElementIds, setSelectedElementIds] = useState<
    AppState["selectedElementIds"]
  >({ [targetImage.id]: true });
  const selectedElementIdsRef = useRef(selectedElementIds);
  const sceneElements = useMemo(
    () => [targetImage] as readonly ExcalidrawElement[],
    [],
  );
  const files = useMemo(
    () => ({
      [TEST_FILE_ID]: imageFile,
    }),
    [],
  );
  const appState = useMemo(
    () => ({
      ...getDefaultAppState(),
      width: 800,
      height: 600,
      offsetLeft: 0,
      offsetTop: 0,
      selectedElementIds: selectedElementIdsRef.current,
    }),
    [],
  );

  selectedElementIdsRef.current = selectedElementIds;

  const notifyChange = () => {
    for (const callback of changeListenersRef.current) {
      callback(
        sceneElements,
        {
          ...appState,
          selectedElementIds: selectedElementIdsRef.current,
        },
        files,
      );
    }
  };

  const excalidrawAPI = useMemo(
    () =>
      ({
        getAppState: () => ({
          ...appState,
          selectedElementIds: selectedElementIdsRef.current,
        }),
        getSceneElements: () => sceneElements,
        getFiles: () => files,
        onChange: (
          callback: Parameters<ExcalidrawImperativeAPI["onChange"]>[0],
        ) => {
          changeListenersRef.current.add(callback);
          callback(
            sceneElements,
            {
              ...appState,
              selectedElementIds: selectedElementIdsRef.current,
            },
            files,
          );

          return () => {
            changeListenersRef.current.delete(callback);
          };
        },
        setToast: vi.fn(),
      } as unknown as ExcalidrawImperativeAPI),
    [appState, files, sceneElements],
  );

  return (
    <div>
      <AIImageWorkbench excalidrawAPI={excalidrawAPI} />
      <button
        type="button"
        onClick={() => {
          selectedElementIdsRef.current = {};
          setSelectedElementIds({});
          notifyChange();
        }}
      >
        Deselect canvas
      </button>
    </div>
  );
};

const MaskEditingControllerHarness = () => {
  const controllerRef = useRef<AIMaskEditingControllerHandle>(null);
  const [appState, setAppState] = useState<AppState>(() => {
    const defaultAppState = getDefaultAppState();

    return {
      ...defaultAppState,
      width: 800,
      height: 600,
      offsetLeft: 0,
      offsetTop: 0,
      activeTool: {
        type: "selection",
        customType: null,
        locked: defaultAppState.activeTool.locked,
        fromSelection: false,
        lastActiveTool: null,
      },
      selectedElementIds: { [targetImage.id]: true },
    };
  });
  const appStateRef = useRef(appState);
  const sceneElementsRef = useRef<readonly ExcalidrawElement[]>([targetImage]);

  appStateRef.current = appState;

  const excalidrawAPI = useMemo(
    () =>
      ({
        getAppState: () => appStateRef.current,
        getSceneElements: () => sceneElementsRef.current,
        getSceneElementsIncludingDeleted: () => sceneElementsRef.current,
        getSceneElementsMapIncludingDeleted: () =>
          new Map(
            sceneElementsRef.current.map((element) => [element.id, element]),
          ),
        getFiles: () => ({
          [TEST_FILE_ID]: imageFile,
        }),
        updateScene: ({
          appState: nextAppState,
        }: Parameters<ExcalidrawImperativeAPI["updateScene"]>[0]) => {
          if (!nextAppState) {
            return;
          }

          setAppState((current) => ({
            ...current,
            ...nextAppState,
          }));
        },
        onChange: (
          callback: Parameters<ExcalidrawImperativeAPI["onChange"]>[0],
        ) => {
          callback(sceneElementsRef.current, appStateRef.current, {
            [TEST_FILE_ID]: imageFile,
          });

          return () => null;
        },
        onScrollChange: () => () => null,
        setActiveTool: (
          tool: Parameters<ExcalidrawImperativeAPI["setActiveTool"]>[0],
        ) => {
          if (tool.type === "custom") {
            return;
          }

          setAppState((current) => ({
            ...current,
            activeTool: {
              ...current.activeTool,
              type: tool.type,
              customType: null,
            },
          }));
        },
        setToast: vi.fn(),
      } as unknown as ExcalidrawImperativeAPI),
    [],
  );

  return (
    <div>
      <button
        type="button"
        onClick={() =>
          controllerRef.current?.requestEnterMaskEditing(targetImage.id)
        }
      >
        Start mask editing
      </button>
      <AIMaskEditingController
        ref={controllerRef}
        excalidrawAPI={excalidrawAPI}
      />
      <div data-testid="mask-stroke-color">
        {appState.currentItemStrokeColor}
      </div>
      <div data-testid="mask-stroke-width">
        {appState.currentItemStrokeWidth}
      </div>
    </div>
  );
};

const MaskEditingDoneHarness = () => {
  const controllerRef = useRef<AIMaskEditingControllerHandle>(null);
  const [lastMaskElementCount, setLastMaskElementCount] = useState<
    number | null
  >(null);
  const maskReadyHandlerRef = useRef<
    ((payload: AIMaskReadyPayload) => void) | null
  >(null);
  const pendingMaskPayloadRef = useRef<AIMaskReadyPayload | null>(null);
  const changeListenersRef = useRef<
    Set<Parameters<ExcalidrawImperativeAPI["onChange"]>[0]>
  >(new Set());
  const [appState, setAppState] = useState<AppState>(() => {
    const defaultAppState = getDefaultAppState();

    return {
      ...defaultAppState,
      width: 800,
      height: 600,
      offsetLeft: 0,
      offsetTop: 0,
      activeTool: {
        type: "selection",
        customType: null,
        locked: defaultAppState.activeTool.locked,
        fromSelection: false,
        lastActiveTool: null,
      },
      selectedElementIds: { [targetImage.id]: true },
    };
  });
  const [sceneElements, setSceneElements] = useState<
    readonly ExcalidrawElement[]
  >([targetImage]);
  const appStateRef = useRef(appState);
  const sceneElementsRef = useRef(sceneElements);

  appStateRef.current = appState;
  sceneElementsRef.current = sceneElements;

  const notifyChange = () => {
    for (const callback of changeListenersRef.current) {
      callback(sceneElementsRef.current, appStateRef.current, {
        [TEST_FILE_ID]: imageFile,
      });
    }
  };

  const excalidrawAPI = useMemo(
    () =>
      ({
        getAppState: () => appStateRef.current,
        getSceneElements: () => sceneElementsRef.current,
        getSceneElementsIncludingDeleted: () => sceneElementsRef.current,
        getSceneElementsMapIncludingDeleted: () =>
          new Map(
            sceneElementsRef.current.map((element) => [element.id, element]),
          ),
        getFiles: () => ({
          [TEST_FILE_ID]: imageFile,
        }),
        updateScene: ({
          elements,
          appState: nextAppState,
        }: Parameters<ExcalidrawImperativeAPI["updateScene"]>[0]) => {
          if (elements) {
            setSceneElements(elements as readonly ExcalidrawElement[]);
          }

          if (nextAppState) {
            setAppState((current) => ({
              ...current,
              ...nextAppState,
            }));
          }
        },
        onChange: (
          callback: Parameters<ExcalidrawImperativeAPI["onChange"]>[0],
        ) => {
          changeListenersRef.current.add(callback);
          callback(sceneElementsRef.current, appStateRef.current, {
            [TEST_FILE_ID]: imageFile,
          });

          return () => {
            changeListenersRef.current.delete(callback);
          };
        },
        onScrollChange: () => () => null,
        setActiveTool: (
          tool: Parameters<ExcalidrawImperativeAPI["setActiveTool"]>[0],
        ) => {
          if (tool.type === "custom") {
            return;
          }

          setAppState((current) => ({
            ...current,
            activeTool: {
              ...current.activeTool,
              type: tool.type,
              customType: null,
            },
          }));
        },
        setToast: vi.fn(),
      } as unknown as ExcalidrawImperativeAPI),
    [],
  );

  const registerMaskReadyHandler = (
    handler: ((payload: AIMaskReadyPayload) => void) | null,
  ) => {
    maskReadyHandlerRef.current = handler;

    if (handler && pendingMaskPayloadRef.current) {
      handler(pendingMaskPayloadRef.current);
      pendingMaskPayloadRef.current = null;
    }
  };

  const handleMaskReady = (payload: AIMaskReadyPayload) => {
    setLastMaskElementCount(payload.maskElements.length);
    if (maskReadyHandlerRef.current) {
      maskReadyHandlerRef.current(payload);
      return;
    }

    pendingMaskPayloadRef.current = payload;
  };

  const addWhiteMask = () => {
    setSceneElements((current) => {
      const nextElements = [...current, createMaskStroke()];
      sceneElementsRef.current = nextElements;
      window.setTimeout(notifyChange, 0);

      return nextElements;
    });
  };

  return (
    <div>
      <AIImageWorkbench
        excalidrawAPI={excalidrawAPI}
        onEnterMaskEditing={(imageId) => {
          controllerRef.current?.requestEnterMaskEditing(imageId);
        }}
        onMaskReady={registerMaskReadyHandler}
      />
      <AIMaskEditingController
        ref={controllerRef}
        excalidrawAPI={excalidrawAPI}
        onMaskReady={handleMaskReady}
      />
      <button type="button" onClick={addWhiteMask}>
        Add white mask
      </button>
      <div data-testid="scene-element-ids">
        {sceneElements.map((element) => element.id).join(",")}
      </div>
      <div data-testid="mask-element-count">{lastMaskElementCount ?? ""}</div>
    </div>
  );
};

const PersistentWorkbenchHarness = () => {
  const [isWorkbenchVisible, setIsWorkbenchVisible] = useState(true);
  const [draftState, setDraftState] = useState(
    createInitialAIImageWorkbenchDraftState,
  );

  return (
    <div>
      <button
        type="button"
        onClick={() => setIsWorkbenchVisible((current) => !current)}
      >
        {isWorkbenchVisible ? "Hide workbench" : "Show workbench"}
      </button>
      {isWorkbenchVisible && (
        <AIImageWorkbench
          excalidrawAPI={null}
          draftState={draftState}
          onDraftStateChange={setDraftState}
        />
      )}
    </div>
  );
};

const ImageBoundMaskWorkbenchHarness = ({
  onEnterMaskEditing,
}: {
  onEnterMaskEditing: (
    imageId: string,
    maskElements?: readonly ExcalidrawFreeDrawElement[],
  ) => void;
}) => {
  const [selectedImageId, setSelectedImageId] = useState(targetImage.id);
  const selectedImageIdRef = useRef(selectedImageId);
  const maskReadyHandlerRef = useRef<
    ((payload: AIMaskReadyPayload) => void) | null
  >(null);
  const changeListenersRef = useRef<
    Set<Parameters<ExcalidrawImperativeAPI["onChange"]>[0]>
  >(new Set());
  const appState = useMemo(
    () => ({
      ...getDefaultAppState(),
      width: 800,
      height: 600,
      offsetLeft: 0,
      offsetTop: 0,
    }),
    [],
  );

  selectedImageIdRef.current = selectedImageId;

  const sceneElements = useMemo(
    () => [targetImage, secondTargetImage] as readonly ExcalidrawElement[],
    [],
  );
  const files = useMemo(
    () => ({
      [TEST_FILE_ID]: imageFile,
      [SECOND_TEST_FILE_ID]: secondImageFile,
    }),
    [],
  );
  const excalidrawAPI = useMemo(
    () =>
      ({
        getAppState: () => ({
          ...appState,
          selectedElementIds: {
            [selectedImageIdRef.current]: true,
          },
        }),
        getSceneElements: () => sceneElements,
        getFiles: () => files,
        onChange: (
          callback: Parameters<ExcalidrawImperativeAPI["onChange"]>[0],
        ) => {
          changeListenersRef.current.add(callback);
          callback(
            sceneElements,
            {
              ...appState,
              selectedElementIds: {
                [selectedImageIdRef.current]: true,
              },
            },
            files,
          );

          return () => {
            changeListenersRef.current.delete(callback);
          };
        },
      } as unknown as ExcalidrawImperativeAPI),
    [appState, files, sceneElements],
  );

  const notifySelectionChange = () => {
    for (const callback of changeListenersRef.current) {
      callback(
        sceneElements,
        {
          ...appState,
          selectedElementIds: {
            [selectedImageIdRef.current]: true,
          },
        },
        files,
      );
    }
  };

  const selectImage = (imageId: string) => {
    selectedImageIdRef.current = imageId;
    setSelectedImageId(imageId);
    notifySelectionChange();
  };

  return (
    <div>
      <AIImageWorkbench
        excalidrawAPI={excalidrawAPI}
        onEnterMaskEditing={onEnterMaskEditing}
        onMaskReady={(handler) => {
          maskReadyHandlerRef.current = handler;
        }}
      />
      <button
        type="button"
        onClick={() => {
          maskReadyHandlerRef.current?.({
            imageId: targetImage.id,
            maskFile: new File(["mask"], "mask-target-image.png", {
              type: "image/png",
            }),
            maskElements: [createMaskStroke()],
          });
        }}
      >
        Attach first mask
      </button>
      <button type="button" onClick={() => selectImage(targetImage.id)}>
        Select first image
      </button>
      <button type="button" onClick={() => selectImage(secondTargetImage.id)}>
        Select second image
      </button>
    </div>
  );
};

const MovedImageMaskControllerHarness = () => {
  const controllerRef = useRef<AIMaskEditingControllerHandle>(null);
  const [savedMaskPosition, setSavedMaskPosition] = useState("");
  const [savedMaskGeometryVersion, setSavedMaskGeometryVersion] = useState("");
  const changeListenersRef = useRef<
    Set<Parameters<ExcalidrawImperativeAPI["onChange"]>[0]>
  >(new Set());
  const [appState, setAppState] = useState<AppState>(() => {
    const defaultAppState = getDefaultAppState();

    return {
      ...defaultAppState,
      width: 800,
      height: 600,
      offsetLeft: 0,
      offsetTop: 0,
      activeTool: {
        type: "selection",
        customType: null,
        locked: defaultAppState.activeTool.locked,
        fromSelection: false,
        lastActiveTool: null,
      },
      selectedElementIds: { [movedTargetImage.id]: true },
    };
  });
  const [sceneElements, setSceneElements] = useState<
    readonly ExcalidrawElement[]
  >([movedTargetImage]);
  const appStateRef = useRef(appState);
  const sceneElementsRef = useRef(sceneElements);

  appStateRef.current = appState;
  sceneElementsRef.current = sceneElements;

  const notifyChange = () => {
    for (const callback of changeListenersRef.current) {
      callback(sceneElementsRef.current, appStateRef.current, {
        [TEST_FILE_ID]: imageFile,
      });
    }
  };

  const excalidrawAPI = useMemo(
    () =>
      ({
        getAppState: () => appStateRef.current,
        getSceneElements: () => sceneElementsRef.current,
        getSceneElementsIncludingDeleted: () => sceneElementsRef.current,
        getSceneElementsMapIncludingDeleted: () =>
          new Map(
            sceneElementsRef.current.map((element) => [element.id, element]),
          ),
        getFiles: () => ({
          [TEST_FILE_ID]: imageFile,
        }),
        updateScene: ({
          elements,
          appState: nextAppState,
        }: Parameters<ExcalidrawImperativeAPI["updateScene"]>[0]) => {
          if (elements) {
            const nextElements = elements as readonly ExcalidrawElement[];
            sceneElementsRef.current = nextElements;
            setSceneElements(nextElements);
            window.setTimeout(notifyChange, 0);
          }

          if (nextAppState) {
            setAppState((current) => {
              const nextState = {
                ...current,
                ...nextAppState,
              };
              appStateRef.current = nextState;

              return nextState;
            });
          }
        },
        onChange: (
          callback: Parameters<ExcalidrawImperativeAPI["onChange"]>[0],
        ) => {
          changeListenersRef.current.add(callback);
          callback(sceneElementsRef.current, appStateRef.current, {
            [TEST_FILE_ID]: imageFile,
          });

          return () => {
            changeListenersRef.current.delete(callback);
          };
        },
        onScrollChange: () => () => null,
        setActiveTool: (
          tool: Parameters<ExcalidrawImperativeAPI["setActiveTool"]>[0],
        ) => {
          if (tool.type === "custom") {
            return;
          }

          setAppState((current) => ({
            ...current,
            activeTool: {
              ...current.activeTool,
              type: tool.type,
              customType: null,
            },
          }));
        },
        setToast: vi.fn(),
      } as unknown as ExcalidrawImperativeAPI),
    [],
  );
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          controllerRef.current?.requestEnterMaskEditing(movedTargetImage.id, [
            createBoundMaskStroke(),
          ])
        }
      >
        Start moved image mask editing
      </button>
      <AIMaskEditingController
        ref={controllerRef}
        excalidrawAPI={excalidrawAPI}
        onMaskReady={(payload) => {
          const element = payload.maskElements[0];
          setSavedMaskPosition(
            element ? `${Math.round(element.x)},${Math.round(element.y)}` : "",
          );
          setSavedMaskGeometryVersion(
            element?.customData?.aiMaskSource?.version?.toString() || "",
          );
        }}
      />
      <div data-testid="editable-mask-position">{savedMaskPosition}</div>
      <div data-testid="saved-mask-geometry-version">
        {savedMaskGeometryVersion}
      </div>
    </div>
  );
};

const createMaskStroke = () =>
  API.createElement({
    type: "freedraw",
    id: "mask-stroke",
    x: 64,
    y: 72,
    strokeColor: "#ffffff",
    strokeWidth: 20,
    points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(32, 18)],
  });

class MaskSourceImage {
  public naturalWidth = 200;
  public naturalHeight = 200;
  public width = 200;
  public height = 200;
  public onload: ((event: Event) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;

  public set src(_value: string) {
    queueMicrotask(() => this.onload?.(new Event("load")));
  }
}

const createBoundMaskStroke = () => ({
  ...createMaskStroke(),
  customData: {
    aiMaskSource: {
      version: 1,
      imageId: targetImage.id,
      x: targetImage.x,
      y: targetImage.y,
      width: targetImage.width,
      height: targetImage.height,
      angle: targetImage.angle,
    },
  },
});

const flushReact = async () => {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
};
