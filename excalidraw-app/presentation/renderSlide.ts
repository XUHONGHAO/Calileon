import { exportToCanvas } from "@excalidraw/excalidraw";

import type {
  ExcalidrawElement,
  ExcalidrawFrameElement,
  NonDeleted,
} from "@excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

export type SlideRenderOptions = {
  frame: ExcalidrawFrameElement;
  elements: readonly ExcalidrawElement[];
  files: BinaryFiles | null;
  viewBackgroundColor: string;
  darkMode: boolean;
  /** pixel length of the longer side of the output */
  longEdge: number;
};

/**
 * One slide as a bitmap: the export path's frame rendering (children plus
 * intersecting elements, clipped to the frame, no outline or name — ADR 0036
 * Q4), always with the canvas background so pages are never transparent.
 */
export const renderSlideToCanvas = ({
  frame,
  elements,
  files,
  viewBackgroundColor,
  darkMode,
  longEdge,
}: SlideRenderOptions) => {
  const scale = longEdge / Math.max(frame.width, frame.height, 1);
  return exportToCanvas({
    elements: elements.filter(
      (element): element is NonDeleted<ExcalidrawElement> => !element.isDeleted,
    ),
    appState: {
      exportBackground: true,
      exportWithDarkMode: darkMode,
      viewBackgroundColor,
    },
    files,
    exportingFrame: frame,
    getDimensions: (width, height) => ({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      scale,
    }),
  });
};
