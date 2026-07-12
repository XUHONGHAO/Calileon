export type VideoPlaybackURLResolution = {
  url: string;
  expiresAt: number;
  mimeType: string;
};

type CacheEntry = {
  resolution?: VideoPlaybackURLResolution;
  inFlight?: Promise<VideoPlaybackURLResolution>;
};

const REFRESH_AHEAD_MS = 60_000;
const cache = new Map<string, CacheEntry>();

const getKey = (contextId: string, assetId: string) =>
  `${contextId}\u0000${assetId}`;

export const seedVideoPlaybackURLCache = (
  contextId: string,
  assetId: string,
  resolution: VideoPlaybackURLResolution,
) => {
  cache.set(getKey(contextId, assetId), { resolution });
};

export const resolveCachedVideoPlaybackURL = async (input: {
  contextId: string;
  assetId: string;
  resolver: () => Promise<VideoPlaybackURLResolution>;
  now?: number;
}) => {
  const key = getKey(input.contextId, input.assetId);
  const now = input.now ?? Date.now();
  const existing = cache.get(key);
  if (
    existing?.resolution &&
    existing.resolution.expiresAt > now + REFRESH_AHEAD_MS
  ) {
    return existing.resolution;
  }
  if (existing?.inFlight) {
    return existing.inFlight;
  }

  const inFlight = input
    .resolver()
    .then((resolution) => {
      cache.set(key, { resolution });
      return resolution;
    })
    .catch((error) => {
      cache.delete(key);
      throw error;
    });
  cache.set(key, { resolution: existing?.resolution, inFlight });
  return inFlight;
};

export const invalidateVideoPlaybackURLCache = (
  contextId: string,
  assetId: string,
) => {
  cache.delete(getKey(contextId, assetId));
};

export const clearVideoPlaybackURLContext = (contextId: string) => {
  const prefix = `${contextId}\u0000`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
};

export const __clearVideoPlaybackURLCacheForTests = () => cache.clear();
