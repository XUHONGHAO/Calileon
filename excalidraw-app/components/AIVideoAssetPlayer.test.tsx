import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { __clearVideoPlaybackURLCacheForTests } from "../ai/videoPlaybackURLCache";

import { AIVideoAssetPlayer } from "./AIVideoAssetPlayer";

describe("AIVideoAssetPlayer", () => {
  beforeEach(() => {
    __clearVideoPlaybackURLCacheForTests();
  });

  it("renders loading state before resolving a runtime-only URL", async () => {
    const resolveAsset = vi.fn().mockResolvedValue({
      url: "https://signed.example/video?token=runtime",
      expiresAt: Date.now() + 300_000,
      mimeType: "video/mp4",
    });

    const { container } = render(
      <AIVideoAssetPlayer
        assetId="asset-1"
        contextId="owner:scene-1"
        resolveAsset={resolveAsset}
      />,
    );

    expect(screen.getByText("Loading video…")).toBeInTheDocument();
    await waitFor(() => {
      expect(container.querySelector("video")?.getAttribute("src")).toContain(
        "runtime",
      );
    });
    expect(resolveAsset).toHaveBeenCalledTimes(1);
  });

  it("invalidates once on playback error and then shows a safe failure state", async () => {
    const resolveAsset = vi
      .fn()
      .mockResolvedValueOnce({
        url: "https://signed.example/first",
        expiresAt: Date.now() + 300_000,
        mimeType: "video/mp4",
      })
      .mockResolvedValueOnce({
        url: "https://signed.example/second",
        expiresAt: Date.now() + 300_000,
        mimeType: "video/mp4",
      });
    const { container } = render(
      <AIVideoAssetPlayer
        assetId="asset-1"
        contextId="share:token-1"
        resolveAsset={resolveAsset}
      />,
    );

    await waitFor(() => {
      expect(container.querySelector("video")).not.toBeNull();
    });
    const first = container.querySelector("video")!;
    fireEvent.error(first);
    await waitFor(() => {
      expect(container.querySelector("video")?.getAttribute("src")).toContain(
        "second",
      );
    });
    fireEvent.error(container.querySelector("video")!);

    expect(
      await screen.findByText("Video is temporarily unavailable."),
    ).toBeInTheDocument();
    expect(resolveAsset).toHaveBeenCalledTimes(2);
  });
});
