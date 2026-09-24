import { useEffect, useState } from "react";

import type { ExcalidrawImageElement } from "@excalidraw/element/types";

import type { BinaryFiles } from "../types";

export type ImagePixelSize = {
  width: number;
  height: number;
};

/**
 * Decoding a data URL to read its intrinsic pixel size is async, so results are
 * memoized by data URL to avoid re-decoding the same image whenever the sidebar
 * re-renders on selection or app state changes.
 */
const naturalSizeCache = new Map<string, ImagePixelSize>();

const pendingDecodes = new Map<string, Promise<ImagePixelSize | null>>();

const decodeNaturalSize = (dataURL: string) => {
  const cached = naturalSizeCache.get(dataURL);

  if (cached) {
    return Promise.resolve(cached);
  }

  const pending = pendingDecodes.get(dataURL);

  if (pending) {
    return pending;
  }

  const decode = new Promise<ImagePixelSize | null>((resolve) => {
    // Guard non-browser contexts and unsupported sources.
    if (typeof window === "undefined" || typeof window.Image === "undefined") {
      resolve(null);
      return;
    }

    const image = new window.Image();

    image.onload = () => {
      const width = image.naturalWidth || image.width;
      const height = image.naturalHeight || image.height;

      if (width > 0 && height > 0) {
        const size = { width, height };
        naturalSizeCache.set(dataURL, size);
        resolve(size);
        return;
      }

      resolve(null);
    };

    image.onerror = () => resolve(null);
    image.src = dataURL;
  }).finally(() => {
    pendingDecodes.delete(dataURL);
  });

  pendingDecodes.set(dataURL, decode);

  return decode;
};

const getCachedNaturalSize = (dataURL: string | undefined) =>
  dataURL ? naturalSizeCache.get(dataURL) ?? null : null;

/**
 * Resolves the source pixel dimensions of an image element's file.
 *
 * Returns `null` while decoding, or when the file is missing or the image
 * cannot be decoded. Only pass an element when it is the sole selection.
 */
export const useImageNaturalSize = (
  element: ExcalidrawImageElement | null,
  files: BinaryFiles,
): ImagePixelSize | null => {
  const fileId = element?.fileId;
  const dataURL = fileId ? files[fileId]?.dataURL : undefined;

  const [size, setSize] = useState<ImagePixelSize | null>(() =>
    getCachedNaturalSize(dataURL),
  );

  useEffect(() => {
    if (!dataURL) {
      setSize(null);
      return;
    }

    const cached = naturalSizeCache.get(dataURL);

    if (cached) {
      setSize(cached);
      return;
    }

    let cancelled = false;

    setSize(null);

    decodeNaturalSize(dataURL).then((decoded) => {
      if (!cancelled) {
        setSize(decoded);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [dataURL]);

  return size;
};

/**
 * Clears the decode cache. Exposed for tests and to release memory when a scene
 * is closed.
 */
export const clearImageNaturalSizeCache = () => {
  naturalSizeCache.clear();
  pendingDecodes.clear();
};
