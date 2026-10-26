// Decoded inline posters (ADR 0035 §3). Kept apart from `imageCache`, which
// is keyed by fileId and only accepts image files. Keyed by the poster
// dataURL itself, so identical posters (copies, undo) share one decode.

type PosterEntry =
  | { status: "loading"; promise: Promise<HTMLImageElement | null> }
  | { status: "loaded"; image: HTMLImageElement }
  | { status: "error" };

const MAX_ENTRIES = 200;

const cache = new Map<string, PosterEntry>();
const listeners = new Set<(dataURL: string) => void>();

const decode = (dataURL: string): Promise<HTMLImageElement | null> =>
  new Promise((resolve) => {
    if (typeof Image === "undefined") {
      resolve(null);
      return;
    }
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = dataURL;
  });

const evictOldest = () => {
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    cache.delete(oldest);
  }
};

const startDecode = (dataURL: string) => {
  const promise = decode(dataURL).then((image) => {
    // the entry may have been evicted meanwhile; keep the result anyway
    cache.set(
      dataURL,
      image ? { status: "loaded", image } : { status: "error" },
    );
    if (image) {
      listeners.forEach((listener) => listener(dataURL));
    }
    return image;
  });
  cache.set(dataURL, { status: "loading", promise });
  evictOldest();
  return promise;
};

/**
 * The decoded poster, or null while it is decoding (decoding starts on the
 * first call) or when it failed. Renderers draw a placeholder for null and
 * redraw once `subscribeToVideoPosters` fires.
 */
export const getVideoPoster = (dataURL: string): HTMLImageElement | null => {
  const entry = cache.get(dataURL);
  if (!entry) {
    startDecode(dataURL);
    return null;
  }
  return entry.status === "loaded" ? entry.image : null;
};

/** resolves once the poster is decoded (or failed); used before exports */
export const loadVideoPoster = (
  dataURL: string,
): Promise<HTMLImageElement | null> => {
  const entry = cache.get(dataURL);
  if (!entry) {
    return startDecode(dataURL);
  }
  if (entry.status === "loading") {
    return entry.promise;
  }
  return Promise.resolve(entry.status === "loaded" ? entry.image : null);
};

export const isVideoPosterReady = (dataURL: string | null) =>
  !!dataURL && cache.get(dataURL)?.status === "loaded";

/** called with the poster dataURL whenever a poster finishes decoding */
export const subscribeToVideoPosters = (
  listener: (dataURL: string) => void,
) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** test-only */
export const __resetVideoPosterCache = () => {
  cache.clear();
};
