import type { ExcalidrawVideoElement, FileId } from "@excalidraw/element/types";

import { dataURLToFile } from "../data/blob";

import type { BinaryFileData } from "../types";

export type VideoPlaybackState = {
  elementId: ExcalidrawVideoElement["id"];
  /** object URL of the clip; owned and revoked by VideoPlayer */
  url: string;
};

/** video files are large, so keep only a couple of object URLs (ADR 0035 §6) */
const URL_CACHE_SIZE = 2;

/**
 * Plays one camera recording at a time in a DOM overlay. Playback state is
 * local and never written to the element. The overlay owns the <video>; this
 * class only decides which element plays and manages object URLs.
 */
export class VideoPlayer {
  private current: VideoPlaybackState | null = null;
  private currentFileId: FileId | null = null;
  private urls = new Map<FileId, string>();

  constructor(
    private readonly opts: {
      onChange: (state: VideoPlaybackState | null) => void;
    },
  ) {}

  getState(): VideoPlaybackState | null {
    return this.current;
  }

  /**
   * opens the overlay for `element` (or closes it when it is already open);
   * returns false when the file is not loaded
   */
  toggle(element: ExcalidrawVideoElement, file: BinaryFileData | undefined) {
    if (this.current?.elementId === element.id) {
      this.stop();
      return true;
    }
    if (!element.fileId || !file?.dataURL) {
      return false;
    }
    this.current = {
      elementId: element.id,
      url: this.getURL(element.fileId, file),
    };
    this.currentFileId = element.fileId;
    this.emit();
    return true;
  }

  stop() {
    if (!this.current) {
      return;
    }
    this.current = null;
    this.currentFileId = null;
    this.emit();
  }

  /** stops playback if the element is gone or its file changed */
  sync(element: ExcalidrawVideoElement | undefined) {
    if (
      this.current &&
      (!element ||
        element.isDeleted ||
        element.id !== this.current.elementId ||
        element.fileId !== this.currentFileId)
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
      // never revoke the URL that is on screen
      if (oldestId === this.currentFileId) {
        this.urls.delete(oldestId);
        this.urls.set(oldestId, oldestURL);
        continue;
      }
      this.urls.delete(oldestId);
      URL.revokeObjectURL(oldestURL);
    }
    return url;
  }

  private emit() {
    this.opts.onChange(this.current);
  }
}
