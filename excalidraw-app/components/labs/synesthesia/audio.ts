export const MAX_FILE_SIZE = 50 * 1024 * 1024;
export type AudioInput = {
  context: AudioContext;
  analyser: AnalyserNode;
  duration: number;
  play: () => Promise<void>;
  dispose: () => void;
};

/** The abort listener exists before any asynchronous permission prompt. */
export const openAudio = async (
  file: File | null,
  signal: AbortSignal,
  ended: (reason?: string) => void,
): Promise<AudioInput> => {
  if (
    !globalThis.AudioContext ||
    (!file && !navigator.mediaDevices?.getUserMedia)
  ) {
    throw new Error("unsupported");
  }
  if (file && file.size > MAX_FILE_SIZE) {
    throw new Error("tooLarge");
  }
  const context = new AudioContext();
  let stream: MediaStream | undefined;
  let media: HTMLAudioElement | undefined;
  let url: string | undefined;
  let disposed = false;
  const nodes: AudioNode[] = [];
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    signal.removeEventListener("abort", dispose);
    stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    if (media) {
      media.onended = null;
      media.onerror = null;
      media.pause();
      media.removeAttribute("src");
      media.load();
    }
    nodes.forEach((node) => node.disconnect());
    if (url) {
      URL.revokeObjectURL(url);
    }
    context.onstatechange = null;
    void context.close().catch(() => {});
  };
  signal.addEventListener("abort", dispose, { once: true });
  const check = () => {
    if (signal.aborted || disposed) {
      throw new DOMException("", "AbortError");
    }
  };
  try {
    check();
    await context.resume();
    check();
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    nodes.push(analyser);
    let duration = 300;
    if (file) {
      media = new Audio();
      url = URL.createObjectURL(file);
      media.src = url;
      const element = media;
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          element.removeEventListener("loadedmetadata", loaded);
          element.removeEventListener("error", failed);
          signal.removeEventListener("abort", cancelled);
          error ? reject(error) : resolve();
        };
        const loaded = () => finish();
        const failed = () => finish(new Error("fileError"));
        const cancelled = () => finish(new DOMException("", "AbortError"));
        const timer = setTimeout(failed, 15000);
        element.addEventListener("loadedmetadata", loaded);
        element.addEventListener("error", failed);
        signal.addEventListener("abort", cancelled, { once: true });
        element.load();
      });
      check();
      duration =
        Number.isFinite(media.duration) && media.duration > 0
          ? Math.min(300, media.duration)
          : 300;
      const source = context.createMediaElementSource(media);
      nodes.push(source);
      source.connect(analyser);
      analyser.connect(context.destination);
      media.onended = () => ended("completed");
      media.onerror = () => ended("fileError");
    } else {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (disposed || signal.aborted) {
        stream.getTracks().forEach((track) => track.stop());
        check();
      }
      const source = context.createMediaStreamSource(stream);
      const mute = context.createGain();
      mute.gain.value = 0;
      nodes.push(source, mute);
      source.connect(analyser);
      analyser.connect(mute);
      mute.connect(context.destination);
      stream.getTracks().forEach((track) => {
        track.onended = () => ended("interrupted");
      });
    }
    context.onstatechange = () => {
      if (!disposed && context.state !== "running") {
        ended();
      }
    };
    return {
      context,
      analyser,
      duration,
      play: async () => {
        check();
        await media?.play();
        check();
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
};
