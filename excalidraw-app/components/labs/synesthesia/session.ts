import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
} from "@excalidraw/excalidraw";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import { analyse } from "./analysis";

import { openAudio } from "./audio";

import { createMapper, MAX_DURATION, MAX_ELEMENTS } from "./mapping";

import type { AnalysisState } from "./analysis";
import type { AudioInput } from "./audio";

import type { Area, Style } from "./mapping";

export const commitArtwork = (
  api: ExcalidrawImperativeAPI,
  elements: readonly ExcalidrawElement[],
) => {
  const latest = api.getSceneElementsIncludingDeleted();
  const ids = new Set(latest.map((element) => element.id));
  const missing = elements.filter((element) => !ids.has(element.id));
  if (missing.length) {
    api.updateScene({
      elements: [...latest, ...missing],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  }
};
export type Snapshot = {
  elements: readonly ExcalidrawElement[];
  elapsed: number;
  rms: number;
};
export class SynesthesiaSession {
  private controller = new AbortController();
  private audio?: AudioInput;
  private timer?: ReturnType<typeof setInterval>;
  private watchdog?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private elements: ExcalidrawElement[] = [];
  private elapsed = 0;
  private state?: AnalysisState;
  constructor(
    private options: {
      file: File | null;
      style: Style;
      area: Area;
      dark: boolean;
      seed: number;
      preview: (snapshot: Snapshot) => void;
      finish: (elements: readonly ExcalidrawElement[], reason: string) => void;
    },
  ) {}
  async start() {
    try {
      this.audio = await openAudio(
        this.options.file,
        this.controller.signal,
        (reason) => this.stop(reason ?? "interrupted"),
      );
      if (this.stopped) {
        this.audio.dispose();
        return;
      }
      await this.audio.play();
      if (this.stopped) {
        return;
      }
      const started = performance.now();
      const audio = this.audio;
      const waveform = new Float32Array(audio.analyser.fftSize);
      const spectrum = new Uint8Array(audio.analyser.frequencyBinCount);
      const map = createMapper(
        this.options.seed,
        this.options.area,
        this.options.style,
        this.options.dark,
      );
      const group = `synesthesia-${crypto.randomUUID()}`;
      this.timer = setInterval(() => {
        this.elapsed = performance.now() - started;
        if (this.elapsed >= MAX_DURATION) {
          this.stop("timeLimit");
          return;
        }
        audio.analyser.getFloatTimeDomainData(waveform);
        audio.analyser.getByteFrequencyData(spectrum);
        const next = analyse(
          waveform,
          spectrum,
          audio.context.sampleRate,
          audio.analyser.fftSize,
          this.elapsed,
          this.state,
        );
        this.state = next.state;
        const generated = convertToExcalidrawElements(
          map(next.features, this.elapsed, audio.duration * 1000),
        );
        this.elements.push(
          ...generated.map((element) => ({ ...element, groupIds: [group] })),
        );
        this.options.preview({
          elements: [...this.elements],
          elapsed: this.elapsed,
          rms: next.features.rms,
        });
        if (this.elements.length >= MAX_ELEMENTS) {
          this.stop("elementLimit");
        }
      }, 150);
      this.watchdog = setTimeout(() => this.stop("timeLimit"), MAX_DURATION);
    } catch (error) {
      if (!this.stopped) {
        this.stop(
          error instanceof DOMException && error.name === "NotAllowedError"
            ? "permission"
            : error instanceof Error &&
              ["unsupported", "tooLarge", "fileError"].includes(error.message)
            ? error.message
            : "audioError",
        );
      }
    }
  }
  stop(reason = "completed") {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.watchdog);
    this.controller.abort();
    this.audio?.dispose();
    this.options.finish(this.elements, reason);
  }
}
