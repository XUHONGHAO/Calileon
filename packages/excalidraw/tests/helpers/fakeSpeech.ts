import type {
  LocalSpeechAvailability,
  SpeechRecognitionCtor,
  SpeechRecognitionLike,
} from "../../speech/transcriber";

type FakeResult = { text: string; isFinal: boolean };

/** A scriptable Web Speech API recognizer for tests (ADR 0034 §7). */
export class FakeRecognition implements SpeechRecognitionLike {
  static instances: FakeRecognition[] = [];
  static availability: LocalSpeechAvailability = "unavailable";
  static installResult = true;
  static installCalls = 0;
  /** make `start(track)` throw, like older browsers that take no argument */
  static rejectTrack = false;

  static reset() {
    FakeRecognition.instances = [];
    FakeRecognition.availability = "unavailable";
    FakeRecognition.installResult = true;
    FakeRecognition.installCalls = 0;
    FakeRecognition.rejectTrack = false;
  }

  static get last() {
    return FakeRecognition.instances[FakeRecognition.instances.length - 1];
  }

  static available = async () => FakeRecognition.availability;

  static install = async () => {
    FakeRecognition.installCalls++;
    return FakeRecognition.installResult;
  };

  lang = "";
  continuous = false;
  interimResults = false;
  processLocally?: boolean;
  onresult: SpeechRecognitionLike["onresult"] = null;
  onerror: SpeechRecognitionLike["onerror"] = null;
  onend: SpeechRecognitionLike["onend"] = null;
  startedWith: MediaStreamTrack | undefined | null = null;
  stopped = false;
  aborted = false;
  private results: FakeResult[] = [];

  constructor() {
    FakeRecognition.instances.push(this);
  }

  start(track?: MediaStreamTrack) {
    if (track && FakeRecognition.rejectTrack) {
      throw new TypeError("start() takes no arguments");
    }
    this.startedWith = track;
  }

  stop() {
    this.stopped = true;
  }

  abort() {
    this.aborted = true;
  }

  /** replaces the current (interim) tail and emits the cumulative list */
  emit(text: string, isFinal: boolean) {
    const firstInterim = this.results.findIndex((result) => !result.isFinal);
    const resultIndex =
      firstInterim === -1 ? this.results.length : firstInterim;
    this.results = [...this.results.slice(0, resultIndex), { text, isFinal }];
    const list = this.results.map((result) =>
      Object.assign([{ transcript: result.text }], {
        isFinal: result.isFinal,
      }),
    );
    this.onresult?.({
      resultIndex,
      results: Object.assign(list, { length: list.length }),
    });
  }

  fail(error: string) {
    this.onerror?.({ error });
  }

  end() {
    this.onend?.();
  }
}

export const fakeRecognitionCtor =
  FakeRecognition as unknown as SpeechRecognitionCtor;

/** installs the fake as `window.SpeechRecognition`; returns the restorer */
export const installFakeSpeech = () => {
  const w = window as any;
  const previous = w.SpeechRecognition;
  w.SpeechRecognition = FakeRecognition;
  FakeRecognition.reset();
  return () => {
    if (previous === undefined) {
      delete w.SpeechRecognition;
    } else {
      w.SpeechRecognition = previous;
    }
  };
};
