import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __clearVideoPlaybackURLCacheForTests,
  clearVideoPlaybackURLContext,
  invalidateVideoPlaybackURLCache,
  resolveCachedVideoPlaybackURL,
  seedVideoPlaybackURLCache,
} from "./videoPlaybackURLCache";

const resolution = (url: string, expiresAt = 1_000_000) => ({
  url,
  expiresAt,
  mimeType: "video/mp4",
});

describe("video playback URL cache", () => {
  beforeEach(() => {
    __clearVideoPlaybackURLCacheForTests();
  });

  it("deduplicates concurrent resolves in one access context", async () => {
    let finish!: (value: ReturnType<typeof resolution>) => void;
    const resolver = vi.fn(
      () =>
        new Promise<ReturnType<typeof resolution>>((resolve) => {
          finish = resolve;
        }),
    );

    const first = resolveCachedVideoPlaybackURL({
      contextId: "owner:scene-1",
      assetId: "asset-1",
      resolver,
      now: 0,
    });
    const second = resolveCachedVideoPlaybackURL({
      contextId: "owner:scene-1",
      assetId: "asset-1",
      resolver,
      now: 0,
    });
    finish(resolution("https://signed.example/one"));

    await expect(first).resolves.toEqual(await second);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("isolates identical assets across owner and share contexts", async () => {
    const ownerResolver = vi
      .fn()
      .mockResolvedValue(resolution("https://signed.example/owner"));
    const shareResolver = vi
      .fn()
      .mockResolvedValue(resolution("https://signed.example/share"));

    const owner = await resolveCachedVideoPlaybackURL({
      contextId: "owner:scene-1",
      assetId: "asset-1",
      resolver: ownerResolver,
      now: 0,
    });
    const share = await resolveCachedVideoPlaybackURL({
      contextId: "share:token-1",
      assetId: "asset-1",
      resolver: shareResolver,
      now: 0,
    });

    expect(owner.url).not.toBe(share.url);
    expect(ownerResolver).toHaveBeenCalledTimes(1);
    expect(shareResolver).toHaveBeenCalledTimes(1);
  });

  it("refreshes near expiry and supports explicit invalidation", async () => {
    seedVideoPlaybackURLCache(
      "owner:scene-1",
      "asset-1",
      resolution("https://signed.example/old", 70_000),
    );
    const resolver = vi
      .fn()
      .mockResolvedValue(resolution("https://signed.example/new"));

    expect(
      (
        await resolveCachedVideoPlaybackURL({
          contextId: "owner:scene-1",
          assetId: "asset-1",
          resolver,
          now: 20_000,
        })
      ).url,
    ).toContain("new");

    invalidateVideoPlaybackURLCache("owner:scene-1", "asset-1");
    await resolveCachedVideoPlaybackURL({
      contextId: "owner:scene-1",
      assetId: "asset-1",
      resolver,
      now: 0,
    });
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it("clears only the selected access context", async () => {
    seedVideoPlaybackURLCache(
      "owner:scene-1",
      "asset-1",
      resolution("https://signed.example/owner"),
    );
    seedVideoPlaybackURLCache(
      "share:token-1",
      "asset-1",
      resolution("https://signed.example/share"),
    );
    clearVideoPlaybackURLContext("owner:scene-1");

    const ownerResolver = vi
      .fn()
      .mockResolvedValue(resolution("https://signed.example/owner-new"));
    const shareResolver = vi.fn();
    await resolveCachedVideoPlaybackURL({
      contextId: "owner:scene-1",
      assetId: "asset-1",
      resolver: ownerResolver,
      now: 0,
    });
    await resolveCachedVideoPlaybackURL({
      contextId: "share:token-1",
      assetId: "asset-1",
      resolver: shareResolver,
      now: 0,
    });

    expect(ownerResolver).toHaveBeenCalledTimes(1);
    expect(shareResolver).not.toHaveBeenCalled();
  });
});
