import { act, queryByTestId } from "@testing-library/react";
import React from "react";

import { Excalidraw } from "../index";
import { API } from "../tests/helpers/api";
import { Pointer, UI } from "../tests/helpers/ui";
import { render } from "../tests/test-utils";

import {
  downloadImageDataURL,
  getImageDownloadExtension,
  getImageDownloadFileName,
} from "./actionDownloadImage";

const { h } = window;
const mouse = new Pointer("mouse");

const IMAGE_FILE_ID = "test-image-file";

const createImageScene = () => {
  const imageElement = API.createElement({
    type: "image",
    x: 100,
    y: 100,
    width: 100,
    height: 100,
    fileId: IMAGE_FILE_ID,
  });

  return {
    elements: [imageElement],
    files: {
      [IMAGE_FILE_ID]: {
        id: IMAGE_FILE_ID,
        mimeType: "image/png" as const,
        dataURL: "data:image/png;base64,iVBORw0KGgo=" as any,
        created: 1700000000000,
      },
    },
  };
};

describe("download image action", () => {
  describe("getImageDownloadExtension", () => {
    it("maps known mime types to file extensions", () => {
      expect(getImageDownloadExtension("image/png")).toBe("png");
      expect(getImageDownloadExtension("image/jpeg")).toBe("jpg");
      expect(getImageDownloadExtension("image/webp")).toBe("webp");
      expect(getImageDownloadExtension("image/svg+xml")).toBe("svg");
    });

    it("ignores charset parameters and case", () => {
      expect(getImageDownloadExtension("image/PNG; charset=binary")).toBe(
        "png",
      );
    });

    it("falls back to png for unknown or missing mime types", () => {
      expect(getImageDownloadExtension(undefined)).toBe("png");
      expect(getImageDownloadExtension("application/octet-stream")).toBe("png");
    });
  });

  describe("getImageDownloadFileName", () => {
    it("builds a stable file name from the mime type and timestamp", () => {
      expect(getImageDownloadFileName("image/png", 1700000000000)).toBe(
        "image-1700000000000.png",
      );
      expect(getImageDownloadFileName("image/jpeg", 42)).toBe("image-42.jpg");
    });
  });

  describe("downloadImageDataURL", () => {
    it("clicks a temporary anchor carrying the download attribute", () => {
      const clicked: HTMLAnchorElement[] = [];
      const originalClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        clicked.push(this);
      };

      try {
        downloadImageDataURL(
          "data:image/png;base64,iVBORw0KGgo=" as any,
          "image-1.png",
        );
      } finally {
        HTMLAnchorElement.prototype.click = originalClick;
      }

      expect(clicked).toHaveLength(1);
      expect(clicked[0].download).toBe("image-1.png");
      expect(clicked[0].href).toContain("data:image/png");
      // the anchor must not leak into the DOM
      expect(document.querySelectorAll("a[download]")).toHaveLength(0);
    });
  });

  describe("context menu entry", () => {
    it("shows the download action for a selected image, right below lock", async () => {
      const scene = createImageScene();
      await render(<Excalidraw initialData={scene as any} />);

      await act(async () => {
        await h.app.addFiles([scene.files[IMAGE_FILE_ID] as any]);
      });

      mouse.clickOn(h.elements[0] as any);

      mouse.rightClickAt(200, 200);
      const contextMenu = UI.queryContextMenu()!;
      const download = queryByTestId(contextMenu, "downloadImage");
      const lock = queryByTestId(contextMenu, "toggleElementLock");

      expect(download).not.toBe(null);
      expect(lock).not.toBe(null);

      // sits immediately after the lock entry
      const items = Array.from(contextMenu.querySelectorAll("[data-testid]"));
      const ids = items.map((item) => item.getAttribute("data-testid"));
      expect(ids.indexOf("downloadImage")).toBe(
        ids.indexOf("toggleElementLock") + 1,
      );
    });

    it("does not offer the download action for non-image selections", async () => {
      await render(
        <Excalidraw
          initialData={{
            elements: [
              API.createElement({
                type: "rectangle",
                x: 0,
                y: 0,
                width: 100,
                height: 100,
              }),
            ],
          }}
        />,
      );

      mouse.clickOn(h.elements[0] as any);

      mouse.rightClickAt(50, 50);

      expect(queryByTestId(UI.queryContextMenu()!, "downloadImage")).toBe(null);
    });
  });

  describe("properties sidebar", () => {
    it("renders a download button in the actions section for a selected image", async () => {
      const scene = createImageScene();
      await render(<Excalidraw initialData={scene as any} />);

      await act(async () => {
        await h.app.addFiles([scene.files[IMAGE_FILE_ID] as any]);
      });

      mouse.clickOn(h.elements[0] as any);

      const labels = Array.from(
        document.querySelectorAll(".selected-shape-actions button"),
      ).map((button) => button.getAttribute("aria-label"));

      expect(labels).toContain("Download image");
    });
  });
});
