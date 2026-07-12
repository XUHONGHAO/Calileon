import type {
  ExcalidrawEmbeddableElement,
  NonDeleted,
} from "@excalidraw/element/types";

import { Excalidraw } from "../index";
import { createPasteEvent } from "../clipboard";

import { API } from "./helpers/api";
import {
  fireEvent,
  GlobalTestState,
  mockBoundingClientRect,
  render,
  restoreOriginalGetBoundingClientRect,
  waitFor,
} from "./test-utils";

const pasteEmbeddable = async (link: string, expectedLink = link) => {
  document.dispatchEvent(
    createPasteEvent({
      types: {
        "text/plain": link,
      },
    }),
  );

  await waitFor(() => {
    expect(window.h.elements).toEqual([
      expect.objectContaining({
        type: "embeddable",
        link: expectedLink,
      }),
    ]);
  });

  return window.h.elements[0];
};

const expectBilibiliIframeLoaded = async () => {
  const iframe = await waitFor(() => {
    const embeddableIframe = document.querySelector(
      "iframe.excalidraw__embeddable",
    );
    expect(embeddableIframe).not.toBe(null);
    return embeddableIframe as HTMLIFrameElement;
  });

  expect(iframe.getAttribute("src")).toContain("player.bilibili.com");
  expect(iframe.getAttribute("src")).toContain("autoplay=0");
  expect(iframe.getAttribute("src")).toContain("high_quality=1");
  expect(
    document.querySelector("[data-testid='video-embed-placeholder']"),
  ).toBe(null);
};

describe("embeddables", () => {
  const bilibiliIframe = `<iframe src="//player.bilibili.com/player.html?isOutside=true&amp;aid=116738217745712&amp;bvid=BV1zBJV6pEcf&amp;cid=39071777011&amp;p=1" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true"></iframe>`;
  const bilibiliPlayerLink =
    "https://player.bilibili.com/player.html?isOutside=true&aid=116738217745712&bvid=BV1zBJV6pEcf&cid=39071777011&p=1";

  beforeEach(() => {
    mockBoundingClientRect({ width: 1000, height: 800 });
    Object.assign(document, {
      elementFromPoint: () => GlobalTestState.canvas,
    });
  });

  afterEach(() => {
    restoreOriginalGetBoundingClientRect();
  });

  it("loads video iframes only after clicking the placeholder", async () => {
    await render(<Excalidraw autoFocus={true} handleKeyboardGlobally={true} />);

    await pasteEmbeddable("https://www.youtube.com/watch?v=gkGMXY0wekg");

    const placeholder = await waitFor(() => {
      const videoPlaceholder = document.querySelector(
        "[data-testid='video-embed-placeholder']",
      ) as HTMLElement | null;
      expect(videoPlaceholder).not.toBe(null);
      return videoPlaceholder!;
    });
    expect(placeholder.style.backgroundImage).toContain(
      "https://i.ytimg.com/vi/gkGMXY0wekg/hqdefault.jpg",
    );
    expect(document.querySelector("iframe.excalidraw__embeddable")).toBe(null);

    fireEvent.click(
      document.querySelector("[data-testid='video-embed-placeholder']")!,
    );

    await waitFor(() => {
      expect(document.querySelector("iframe.excalidraw__embeddable")).not.toBe(
        null,
      );
    });
    expect(
      document.querySelector("[data-testid='video-embed-placeholder']"),
    ).toBe(null);
  });

  it("resets video embeds to placeholders after remount", async () => {
    const { unmount } = await render(
      <Excalidraw autoFocus={true} handleKeyboardGlobally={true} />,
    );

    const embeddable = await pasteEmbeddable(
      "https://www.youtube.com/watch?v=gkGMXY0wekg",
    );

    await waitFor(() => {
      expect(
        document.querySelector("[data-testid='video-embed-placeholder']"),
      ).not.toBe(null);
    });

    fireEvent.click(
      document.querySelector("[data-testid='video-embed-placeholder']")!,
    );

    await waitFor(() => {
      expect(document.querySelector("iframe.excalidraw__embeddable")).not.toBe(
        null,
      );
    });

    unmount();

    await render(<Excalidraw initialData={{ elements: [embeddable] }} />);

    await waitFor(() => {
      expect(
        document.querySelector("[data-testid='video-embed-placeholder']"),
      ).not.toBe(null);
    });
    expect(document.querySelector("iframe.excalidraw__embeddable")).toBe(null);
  });

  it("keeps non-video embeddables eager", async () => {
    await render(<Excalidraw autoFocus={true} handleKeyboardGlobally={true} />);

    await pasteEmbeddable("https://www.figma.com/file/test-id/test-file");

    await waitFor(() => {
      expect(document.querySelector("iframe.excalidraw__embeddable")).not.toBe(
        null,
      );
    });
    expect(
      document.querySelector("[data-testid='video-embed-placeholder']"),
    ).toBe(null);
  });

  it("accepts official Bilibili iframe code in the embeddable link editor", async () => {
    await render(<Excalidraw autoFocus={true} handleKeyboardGlobally={true} />);

    const embeddable = API.createElement({
      type: "embeddable",
      x: 0,
      y: 0,
      width: 560,
      height: 315,
    });

    API.setElements([embeddable]);
    API.setAppState({
      selectedElementIds: { [embeddable.id]: true },
      showHyperlinkPopup: "editor",
    });

    const input = await waitFor(() => {
      const linkInput = document.querySelector(
        ".excalidraw-hyperlinkContainer-input",
      );
      expect(linkInput).not.toBe(null);
      return linkInput as HTMLInputElement;
    });

    fireEvent.change(input, { target: { value: bilibiliIframe } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(window.h.elements[0]).toEqual(
        expect.objectContaining({
          type: "embeddable",
          link: bilibiliPlayerLink,
        }),
      );
    });

    expect(window.h.state.toast).toBe(null);
    await expectBilibiliIframeLoaded();
  });

  it("accepts official Bilibili iframe code on paste", async () => {
    await render(<Excalidraw autoFocus={true} handleKeyboardGlobally={true} />);

    await pasteEmbeddable(bilibiliIframe, bilibiliPlayerLink);

    await expectBilibiliIframeLoaded();
  });

  it("keeps a custom-validated embeddable valid after submitting its unchanged link", async () => {
    const opaqueVideoLink =
      "https://cdn.example.com/opaque?X-Amz-Signature=keep";
    const embeddable = {
      ...API.createElement({
        type: "embeddable",
        x: 0,
        y: 0,
        width: 560,
        height: 315,
      }),
      link: opaqueVideoLink,
      customData: { aiVideoGeneration: { version: 1 } },
    } as unknown as NonDeleted<ExcalidrawEmbeddableElement>;
    const validateEmbeddable = vi.fn(
      (_link: string, element?: NonDeleted<ExcalidrawEmbeddableElement>) =>
        element ? true : undefined,
    );

    await render(<Excalidraw validateEmbeddable={validateEmbeddable} />);
    API.setElements([embeddable]);

    API.setAppState({
      selectedElementIds: { [embeddable.id]: true },
      showHyperlinkPopup: "editor",
    });
    const input = await waitFor(() => {
      const linkInput = document.querySelector(
        ".excalidraw-hyperlinkContainer-input",
      );
      expect(linkInput).not.toBe(null);
      return linkInput as HTMLInputElement;
    });

    fireEvent.change(input, { target: { value: opaqueVideoLink } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(window.h.state.toast).toBe(null);
      expect(validateEmbeddable).toHaveBeenLastCalledWith(
        opaqueVideoLink,
        expect.objectContaining({ id: embeddable.id }),
      );
    });
  });
});
