import { useEffect, useRef, useState } from "react";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";

import { renderSlideToCanvas } from "./renderSlide";

import type { Slide } from "./slides";

/**
 * Lazily generated slide thumbnails, cached per frame + width. A thumbnail is
 * stale when the frame, one of its children, the theme or the background
 * changes; intersecting non-child elements do not invalidate it (cheap key).
 */

type CacheEntry = { key: string; url: string };

const cache = new Map<string, CacheEntry>();

const getContentKey = (
  slide: Slide,
  elements: readonly ExcalidrawElement[],
  darkMode: boolean,
  viewBackgroundColor: string,
  filesCount: number,
) => {
  let version = slide.frame.version;
  let count = 0;
  for (const element of elements) {
    if (element.frameId === slide.frame.id) {
      version += element.version + (element.isDeleted ? 1 : 0);
      count++;
    }
  }
  return [
    slide.frame.width,
    slide.frame.height,
    version,
    count,
    darkMode ? "d" : "l",
    viewBackgroundColor,
    filesCount,
  ].join(":");
};

const scheduleIdle = (callback: () => void) => {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(callback, { timeout: 500 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(callback, 16);
  return () => window.clearTimeout(id);
};

export const useSlideThumbnails = ({
  slides,
  elements,
  files,
  darkMode,
  viewBackgroundColor,
  width,
  sceneVersion,
}: {
  slides: readonly Slide[];
  elements: readonly ExcalidrawElement[];
  files: BinaryFiles | null;
  darkMode: boolean;
  viewBackgroundColor: string;
  /** CSS pixel width of the thumbnail */
  width: number;
  /** changes whenever elements or files change */
  sceneVersion: number;
}) => {
  const [, setTick] = useState(0);
  const latest = useRef({ slides, elements, files });
  latest.current = { slides, elements, files };
  // which slides are wanted (the presenter view asks for a moving "next" one)
  const slideIds = slides.map((slide) => slide.frame.id).join(",");

  useEffect(() => {
    let cancelled = false;
    let cancelIdle: (() => void) | null = null;
    const longEdge = Math.round(width * (window.devicePixelRatio || 1));
    const filesCount = Object.keys(latest.current.files ?? {}).length;

    const next = () => {
      if (cancelled) {
        return;
      }
      const { slides, elements, files } = latest.current;
      const stale = slides.find((slide) => {
        const entry = cache.get(`${slide.frame.id}@${width}`);
        return (
          entry?.key !==
          getContentKey(
            slide,
            elements,
            darkMode,
            viewBackgroundColor,
            filesCount,
          )
        );
      });
      if (!stale) {
        return;
      }
      const key = getContentKey(
        stale,
        elements,
        darkMode,
        viewBackgroundColor,
        filesCount,
      );
      cancelIdle = scheduleIdle(async () => {
        try {
          const canvas = await renderSlideToCanvas({
            frame: stale.frame,
            elements,
            files,
            viewBackgroundColor,
            darkMode,
            longEdge,
          });
          cache.set(`${stale.frame.id}@${width}`, {
            key,
            url: canvas.toDataURL("image/png"),
          });
        } catch {
          // keep the previous thumbnail (or the placeholder); retry later
          cache.set(`${stale.frame.id}@${width}`, {
            key,
            url: cache.get(`${stale.frame.id}@${width}`)?.url ?? "",
          });
        }
        if (!cancelled) {
          setTick((tick) => tick + 1);
          next();
        }
      });
    };

    // debounce bursts of edits (dragging, typing in a frame)
    const timer = window.setTimeout(next, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      cancelIdle?.();
    };
  }, [sceneVersion, darkMode, viewBackgroundColor, width, slideIds]);

  return (frameId: string) => cache.get(`${frameId}@${width}`)?.url || null;
};
