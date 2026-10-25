import type { ExcalidrawAudioElement, FileId } from "@excalidraw/element/types";

import { dataURLToFile } from "../data/blob";

import type { BinaryFileData } from "../types";

export type AudioPlaybackState = {
  elementId: ExcalidrawAudioElement["id"];
  status: "playing" | "paused";
};

/** most recently played clips keep their object URL (ADR 0034 §3) */
const URL_CACHE_SIZE = 8;

type MediaFactory = () => HTMLAudioElement;

/**
 * Plays one voice message at a time. Playback state is local and never
 * written to the element (ADR 0034 §5).
 */
export class AudioPlayer {
  private media: HTMLAudioElement | null = null;
  private current: {
    element: ExcalidrawAudioElement;
    status: AudioPlaybackState["status"];
  } | null = null;
  private urls = new Map<FileId, string>();

  constructor(
    private readonly opts: {
      onChange: (state: AudioPlaybackState | null) => void;
      onError: () => void;
      createMedia?: MediaFactory;
    },
  ) {}

  getState(): AudioPlaybackState | null {
    return this.current
      ? { elementId: this.current.element.id, status: this.current.status }
      : null;
  }

  /** 0..1 of the current clip */
  getProgress(): number {
    if (!this.media || !this.current) {
      return 0;
    }
    const mediaDuration = this.media.duration;
    const duration =
      Number.isFinite(mediaDuration) && mediaDuration > 0
        ? mediaDuration
        : this.current.element.duration / 1000;
    if (!duration) {
      return 0;
    }
    return Math.max(0, Math.min(1, this.media.currentTime / duration));
  }

  /** plays, pauses or resumes; returns false when the file is not loaded */
  toggle(element: ExcalidrawAudioElement, file: BinaryFileData | undefined) {
    if (this.current?.element.id === element.id && this.media) {
      if (this.current.status === "playing") {
        this.pause();
      } else {
        this.play();
      }
      return true;
    }
    if (!element.fileId || !file?.dataURL) {
      return false;
    }
    this.stop();
    const url = this.getURL(element.fileId, file);
    const media = (this.opts.createMedia ?? (() => new Audio()))();
    media.preload = "auto";
    media.src = url;
    media.onended = () => {
      if (this.media === media) {
        this.stop();
      }
    };
    media.onerror = () => {
      if (this.media === media) {
        this.stop();
        this.opts.onError();
      }
    };
    this.media = media;
    this.current = { element, status: "playing" };
    this.play();
    return true;
  }

  pause() {
    if (!this.media || !this.current || this.current.status === "paused") {
      return;
    }
    this.media.pause();
    this.current = { ...this.current, status: "paused" };
    this.emit();
  }

  stop() {
    if (!this.media && !this.current) {
      return;
    }
    if (this.media) {
      this.media.onended = null;
      this.media.onerror = null;
      this.media.pause();
    }
    this.media = null;
    this.current = null;
    this.emit();
  }

  /** stops playback if the element is gone or no longer playable */
  sync(element: ExcalidrawAudioElement | undefined) {
    if (
      this.current &&
      (!element ||
        element.isDeleted ||
        element.fileId !== this.current.element.fileId)
    ) {
      this.stop();
    }
  }

  destroy() {
    this.stop();
    for (const url of this.urls.values()) {
      URL.revokeObjectURL(url);
    }
    this.urls.clear();
  }

  private play() {
    if (!this.media || !this.current) {
      return;
    }
    const media = this.media;
    this.current = { ...this.current, status: "playing" };
    this.emit();
    const result = media.play();
    // autoplay policies or unsupported codecs reject the promise
    result?.catch?.((error: any) => {
      if (this.media === media && error?.name !== "AbortError") {
        this.stop();
        this.opts.onError();
      }
    });
  }

  private getURL(fileId: FileId, file: BinaryFileData) {
    const cached = this.urls.get(fileId);
    if (cached) {
      // refresh LRU position
      this.urls.delete(fileId);
      this.urls.set(fileId, cached);
      return cached;
    }
    const url = URL.createObjectURL(dataURLToFile(file.dataURL));
    this.urls.set(fileId, url);
    while (this.urls.size > URL_CACHE_SIZE) {
      const [oldestId, oldestURL] = this.urls.entries().next().value!;
      this.urls.delete(oldestId);
      URL.revokeObjectURL(oldestURL);
    }
    return url;
  }

  private emit() {
    this.opts.onChange(this.getState());
  }
}
