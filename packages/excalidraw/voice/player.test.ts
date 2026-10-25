import type { ExcalidrawAudioElement, FileId } from "@excalidraw/element/types";

import { getVoiceRecordingBlock } from "./gate";
import { AudioPlayer } from "./player";

import type { BinaryFileData, Collaborator, DataURL, SocketId } from "../types";

const audio = (id: string) =>
  ({
    id,
    type: "audio",
    fileId: `file-${id}`,
    duration: 4000,
    isDeleted: false,
  } as unknown as ExcalidrawAudioElement);

const file = (id: string): BinaryFileData => ({
  id: `file-${id}` as FileId,
  mimeType: "audio/webm",
  dataURL: "data:audio/webm;base64,dm9pY2U=" as DataURL,
  created: 1,
});

const createMedia = () => {
  const media = {
    src: "",
    preload: "",
    currentTime: 0,
    duration: Infinity,
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    onended: null as null | (() => void),
    onerror: null as null | (() => void),
  };
  return media;
};

describe("AudioPlayer (ADR 0034 §5)", () => {
  let medias: ReturnType<typeof createMedia>[];
  let urls: string[];

  beforeEach(() => {
    medias = [];
    urls = [];
    let n = 0;
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => {
        const url = `blob:${++n}`;
        urls.push(url);
        return url;
      }),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const createPlayer = () => {
    const onChange = vi.fn();
    const onError = vi.fn();
    const player = new AudioPlayer({
      onChange,
      onError,
      createMedia: () => {
        const media = createMedia();
        medias.push(media);
        return media as unknown as HTMLAudioElement;
      },
    });
    return { player, onChange, onError };
  };

  it("plays, pauses and resumes the same clip", () => {
    const { player, onChange } = createPlayer();
    expect(player.toggle(audio("a"), file("a"))).toBe(true);
    expect(player.getState()).toEqual({ elementId: "a", status: "playing" });
    player.toggle(audio("a"), file("a"));
    expect(player.getState()).toEqual({ elementId: "a", status: "paused" });
    expect(medias[0].pause).toHaveBeenCalled();
    player.toggle(audio("a"), file("a"));
    expect(medias).toHaveLength(1);
    expect(medias[0].play).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith({
      elementId: "a",
      status: "playing",
    });
  });

  it("plays one clip at a time and clears state when it ends", () => {
    const { player, onChange } = createPlayer();
    player.toggle(audio("a"), file("a"));
    player.toggle(audio("b"), file("b"));
    expect(medias[0].pause).toHaveBeenCalled();
    expect(player.getState()?.elementId).toBe("b");
    medias[1].onended?.();
    expect(player.getState()).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("refuses clips whose file isn't loaded", () => {
    const { player } = createPlayer();
    expect(player.toggle(audio("a"), undefined)).toBe(false);
    expect(medias).toHaveLength(0);
  });

  it("falls back to the element duration when the media has none", () => {
    const { player } = createPlayer();
    player.toggle(audio("a"), file("a"));
    medias[0].currentTime = 1;
    expect(player.getProgress()).toBe(0.25);
  });

  it("stops when the element is deleted and reports media errors", () => {
    const { player, onError } = createPlayer();
    player.toggle(audio("a"), file("a"));
    player.sync({ ...audio("a"), isDeleted: true } as ExcalidrawAudioElement);
    expect(player.getState()).toBeNull();
    player.toggle(audio("b"), file("b"));
    medias[1].onerror?.();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(player.getState()).toBeNull();
  });

  it("keeps a bounded cache of object URLs", () => {
    const { player } = createPlayer();
    for (let i = 0; i < 10; i++) {
      player.toggle(audio(`${i}`), file(`${i}`));
    }
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(urls[0]);
    player.destroy();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(10);
  });
});

describe("voice recording gate (ADR 0034 §10)", () => {
  const collaborators = (entries: [string, Collaborator][]) =>
    new Map(entries as [SocketId, Collaborator][]);

  it("is off unless the host enables it", () => {
    expect(getVoiceRecordingBlock(undefined, false, new Map())).toEqual({
      kind: "disabled",
    });
    expect(getVoiceRecordingBlock({ enabled: true }, false, new Map())).toBe(
      null,
    );
  });

  it("passes a host reason through", () => {
    expect(
      getVoiceRecordingBlock(
        { enabled: true, disabledReason: "nope" },
        false,
        new Map(),
      ),
    ).toEqual({ kind: "host", message: "nope" });
  });

  it("blocks while a collaborator hasn't announced audio support", () => {
    const room = collaborators([
      ["me", { isCurrentUser: true }],
      ["new", { elementTypes: ["audio"] }],
      ["old", { username: "old client" }],
    ]);
    expect(getVoiceRecordingBlock({ enabled: true }, true, room)).toEqual({
      kind: "outdatedCollaborators",
    });
    room.set("old" as SocketId, { elementTypes: ["audio"] });
    expect(getVoiceRecordingBlock({ enabled: true }, true, room)).toBe(null);
    // the gate only applies while collaborating
    room.set("old" as SocketId, {});
    expect(getVoiceRecordingBlock({ enabled: true }, false, room)).toBe(null);
  });
});
