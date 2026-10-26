/**
 * Test helpers for the presentation modules (not imported by production code).
 */
import { newElement, newFrameElement } from "@excalidraw/element";

import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
} from "@excalidraw/element/types";

import type { SlideData } from "./slideData";

export const makeFrame = ({
  id,
  x = 0,
  y = 0,
  width = 160,
  height = 90,
  name,
  slide,
  isDeleted = false,
}: {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  name?: string;
  slide?: SlideData;
  isDeleted?: boolean;
}): ExcalidrawFrameElement => ({
  ...newFrameElement({ x, y, width, height, name }),
  id,
  isDeleted,
  customData: slide ? { slide } : undefined,
});

export const makeChild = (
  id: string,
  frameId: string | null,
  x = 0,
  y = 0,
): ExcalidrawElement => ({
  ...newElement({ type: "rectangle", x, y, width: 20, height: 20, frameId }),
  id,
});

export const ids = (items: readonly { frame: { id: string } }[]) =>
  items.map((item) => item.frame.id);
