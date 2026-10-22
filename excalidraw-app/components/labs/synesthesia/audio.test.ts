import { afterEach, describe, expect, it, vi } from "vitest";

import { openAudio } from "./audio";

afterEach(() => {
  vi.unstubAllGlobals();
});
describe("audio resource ownership", () => {
  const setup = () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const node = () => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      gain: { value: 1 },
    });
    vi.stubGlobal(
      "AudioContext",
      class {
        state = "running";
        destination = {};
        resume = vi.fn().mockResolvedValue(undefined);
        close = close;
        createAnalyser = node;
        createMediaStreamSource = node;
        createGain = node;
      },
    );
    return close;
  };
  it("releases microphone tracks and context on stop, only once", async () => {
    const close = setup();
    const stop = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi
          .fn()
          .mockResolvedValue({ getTracks: () => [{ stop, onended: null }] }),
      },
    });
    const controller = new AbortController();
    const audio = await openAudio(null, controller.signal, vi.fn());
    controller.abort();
    audio.dispose();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("stops a microphone arriving after cancellation", async () => {
    const close = setup();
    const stop = vi.fn();
    let resolve!: (value: unknown) => void;
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: () =>
          new Promise((r) => {
            resolve = r;
          }),
      },
    });
    const controller = new AbortController();
    const promise = openAudio(null, controller.signal, vi.fn());
    await Promise.resolve();
    controller.abort();
    resolve({ getTracks: () => [{ stop }] });
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("cleans context after permission rejection", async () => {
    const close = setup();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi
          .fn()
          .mockRejectedValue(new DOMException("denied", "NotAllowedError")),
      },
    });
    await expect(
      openAudio(null, new AbortController().signal, vi.fn()),
    ).rejects.toMatchObject({ name: "NotAllowedError" });
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized audio before constructing a context", async () => {
    setup();
    await expect(
      openAudio(
        { size: 50 * 1024 * 1024 + 1 } as File,
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow("tooLarge");
  });
});
