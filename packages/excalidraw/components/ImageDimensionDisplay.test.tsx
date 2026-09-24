import React from "react";
import { act } from "@testing-library/react";

import { Excalidraw } from "../index";
import { API } from "../tests/helpers/api";
import { Pointer } from "../tests/helpers/ui";
import { render } from "../tests/test-utils";

import { clearImageNaturalSizeCache } from "../hooks/useImageNaturalSize";

const { h } = window;
const mouse = new Pointer("mouse");

const IMAGE_FILE_ID = "test-image-file";
const IMAGE_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

/**
 * jsdom never decodes images, so `onload` would never fire and the sidebar
 * would be stuck on the placeholder. Stub `Image` so assigning `src` resolves
 * with the natural size we want to assert.
 */
const stubImageDecoding = (naturalWidth: number, naturalHeight: number) => {
  const original = window.Image;

  class MockImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = naturalWidth;
    naturalHeight = naturalHeight;
    width = naturalWidth;
    height = naturalHeight;

    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }

  // @ts-ignore - test double for the DOM Image constructor
  window.Image = MockImage;

  return () => {
    window.Image = original;
  };
};

const createImageScene = (opts?: { excludeFile?: boolean }) => {
  const imageElement = API.createElement({
    type: "image",
    x: 100,
    y: 100,
    width: 200,
    height: 120,
    fileId: IMAGE_FILE_ID,
  });

  const textElement = API.createElement({
    type: "text",
    x: 400,
    y: 400,
    width: 80,
    height: 40,
    text: "hello",
  });

  return {
    imageElement,
    textElement,
    scene: {
      elements: [imageElement, textElement],
      files: opts?.excludeFile
        ? {}
        : {
            [IMAGE_FILE_ID]: {
              id: IMAGE_FILE_ID,
              mimeType: "image/png" as const,
              dataURL: IMAGE_DATA_URL as any,
              created: 1700000000000,
            },
          },
    },
  };
};

const getSidebar = () => document.querySelector(".selected-shape-actions");

const getDimensionDisplay = () =>
  document.querySelector(".image-dimension-display");

describe("image pixel dimensions in the properties sidebar", () => {
  let restoreImage: (() => void) | null = null;

  beforeEach(() => {
    clearImageNaturalSizeCache();
  });

  afterEach(() => {
    restoreImage?.();
    restoreImage = null;
  });

  it("shows the image pixel size for a single image selection", async () => {
    restoreImage = stubImageDecoding(1536, 1024);

    const { scene, imageElement } = createImageScene();
    await render(<Excalidraw initialData={scene as any} />);

    await act(async () => {
      await h.app.addFiles([scene.files[IMAGE_FILE_ID] as any]);
    });

    mouse.clickOn(h.elements.find((el) => el.id === imageElement.id)! as any);

    await act(async () => {
      await Promise.resolve();
    });

    const display = getDimensionDisplay();
    expect(display).not.toBeNull();
    expect(display!.textContent).toContain("1536");
    expect(display!.textContent).toContain("1024");

    // matches the sidebar typography baseline
    expect(
      display!.querySelector(".image-dimension-display__label")?.className,
    ).toContain("control-label");
  });

  it("renders as the last item in the sidebar", async () => {
    restoreImage = stubImageDecoding(1536, 1024);

    const { scene, imageElement } = createImageScene();
    await render(<Excalidraw initialData={scene as any} />);

    await act(async () => {
      await h.app.addFiles([scene.files[IMAGE_FILE_ID] as any]);
    });

    mouse.clickOn(h.elements.find((el) => el.id === imageElement.id)! as any);

    await act(async () => {
      await Promise.resolve();
    });

    const display = getDimensionDisplay()!;
    const container = display.parentElement!;

    // there are several elements carrying this class (Section wrapper + panel),
    // so assert against the actual parent of the readout
    expect(container.classList.contains("selected-shape-actions")).toBe(true);
    expect(container.lastElementChild).toBe(display);
  });

  it("hides the pixel size when several images are selected", async () => {
    restoreImage = stubImageDecoding(1536, 1024);

    const { scene } = createImageScene();
    const secondImage = API.createElement({
      type: "image",
      x: 500,
      y: 500,
      width: 100,
      height: 100,
      fileId: "second-image-file",
    });

    await render(
      <Excalidraw
        initialData={
          { ...scene, elements: [...scene.elements, secondImage] } as any
        }
      />,
    );

    await act(async () => {
      await h.app.addFiles([
        scene.files[IMAGE_FILE_ID] as any,
        {
          id: "second-image-file",
          mimeType: "image/png" as any,
          dataURL: IMAGE_DATA_URL as any,
          created: 1700000000000,
        } as any,
      ]);
    });

    // select both images
    act(() => {
      h.app.setState({
        selectedElementIds: {
          [scene.elements[0].id]: true,
          [secondImage.id]: true,
        },
      });
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(getSidebar()).not.toBeNull();
    expect(getDimensionDisplay()).toBeNull();
  });

  it("hides the pixel size when an image and text are selected together", async () => {
    restoreImage = stubImageDecoding(1536, 1024);

    const { scene, imageElement, textElement } = createImageScene();
    await render(<Excalidraw initialData={scene as any} />);

    await act(async () => {
      await h.app.addFiles([scene.files[IMAGE_FILE_ID] as any]);
    });

    act(() => {
      h.app.setState({
        selectedElementIds: {
          [imageElement.id]: true,
          [textElement.id]: true,
        },
      });
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(getSidebar()).not.toBeNull();
    expect(getDimensionDisplay()).toBeNull();
  });

  it("hides the pixel size when a non-image element is selected", async () => {
    restoreImage = stubImageDecoding(1536, 1024);

    const { scene, textElement } = createImageScene();
    await render(<Excalidraw initialData={scene as any} />);

    mouse.clickOn(h.elements.find((el) => el.id === textElement.id)! as any);

    await act(async () => {
      await Promise.resolve();
    });

    expect(getDimensionDisplay()).toBeNull();
  });

  it("keeps a stable placeholder while the image is still decoding", async () => {
    // no Image stub: decoding never resolves, mirroring a slow/broken source
    const { scene, imageElement } = createImageScene();
    await render(<Excalidraw initialData={scene as any} />);

    await act(async () => {
      await h.app.addFiles([scene.files[IMAGE_FILE_ID] as any]);
    });

    mouse.clickOn(h.elements.find((el) => el.id === imageElement.id)! as any);

    await act(async () => {
      await Promise.resolve();
    });

    const display = getDimensionDisplay();
    expect(display).not.toBeNull();
    // label is present, value falls back to a placeholder
    expect(display!.textContent).toContain("—");
  });
});
