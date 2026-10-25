import React from "react";

import { AUDIO_ELEMENT_HEIGHT, KEYS } from "@excalidraw/common";

import type { ExcalidrawAudioElement, FileId } from "@excalidraw/element/types";

import { Excalidraw } from "../index";
import { audioPlaybackAtom } from "../voice/atoms";
import { editorJotaiStore } from "../editor-jotai";

import { API } from "./helpers/api";
import { Keyboard, Pointer, UI } from "./helpers/ui";
import { act, fireEvent, render, screen, waitFor } from "./test-utils";

import type { VoiceRecording } from "../voice/recorder";
import type { Collaborator, DataURL, SocketId } from "../types";

const { h } = window;

const mocks = vi.hoisted(() => ({
  recording: null as VoiceRecording | null,
  started: 0,
  discarded: 0,
}));

vi.mock("../voice/recorder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../voice/recorder")>();
  return {
    ...actual,
    listMicrophones: async () => [],
    startVoiceRecorder: async () => {
      mocks.started++;
      return {
        track: {} as MediaStreamTrack,
        deviceId: null,
        elapsed: () => 0,
        level: () => 0.5,
        stop: async () => mocks.recording!,
        discard: () => {
          mocks.discarded++;
        },
      };
    },
  };
});

const mouse = new Pointer("mouse");

const recording = (duration: number): VoiceRecording => ({
  blob: new Blob(["voice"], { type: "audio/webm" }),
  mimeType: "audio/webm",
  duration,
  peaks: new Array(96).fill(0.5),
});

const author = { name: "Ann", avatar: null };

const renderVoice = async (
  props: Partial<React.ComponentProps<typeof Excalidraw>> = {},
) => {
  await render(
    <Excalidraw
      handleKeyboardGlobally={true}
      voiceOptions={{ enabled: true, getAuthor: () => author }}
      {...props}
    />,
  );
};

const RECORDER = { name: "Recording voice message" };
const STOP = { name: "Stop and send" };

const startRecordingAt = async (x: number, y: number) => {
  UI.clickTool("voice");
  mouse.clickAt(x, y);
  await screen.findByRole("group", RECORDER);
  // wait for the mocked microphone to open
  await waitFor(() =>
    expect(screen.getByRole("button", STOP)).not.toBeDisabled(),
  );
};

describe("voice tool (ADR 0034 §4)", () => {
  beforeEach(() => {
    mocks.recording = recording(5000);
    mocks.started = 0;
    mocks.discarded = 0;
    mouse.reset();
  });

  it("is hidden unless the host enables voice", async () => {
    await render(<Excalidraw />);
    expect(screen.queryByTestId("toolbar-voice")).toBeNull();
  });

  it("records on canvas click and inserts one undoable audio bubble", async () => {
    await renderVoice();
    // sits between the hand and selection tools
    const toolbarIds = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".App-toolbar [data-testid^='toolbar-']",
      ),
    ).map((node) => node.dataset.testid);
    const voiceIndex = toolbarIds.indexOf("toolbar-voice");
    expect(toolbarIds[voiceIndex - 1]).toBe("toolbar-hand");
    expect(toolbarIds[voiceIndex + 1]).toBe("toolbar-selection");

    await startRecordingAt(200, 150);
    // nothing is added to the scene while recording
    expect(h.elements).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", STOP));
    await waitFor(() => expect(h.elements).toHaveLength(1));

    const [element] = h.elements as ExcalidrawAudioElement[];
    expect(element).toMatchObject({
      type: "audio",
      source: "recording",
      duration: 5000,
      status: "pending",
      author,
      x: 200 - AUDIO_ELEMENT_HEIGHT / 2,
      y: 150 - AUDIO_ELEMENT_HEIGHT / 2,
      // thin, solid, architect regardless of the current item style
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 0,
    });
    expect(element.fileId).toBeTruthy();
    expect(h.app.files[element.fileId!]).toMatchObject({
      mimeType: "audio/webm",
    });
    expect(h.state.activeTool.type).toBe("selection");
    expect(h.state.selectedElementIds).toEqual({ [element.id]: true });
    expect(screen.queryByRole("group", RECORDER)).toBeNull();

    Keyboard.undo();
    expect(h.elements[0].isDeleted).toBe(true);
  });

  it("drops recordings shorter than a second", async () => {
    mocks.recording = recording(600);
    await renderVoice();
    await startRecordingAt(100, 100);
    fireEvent.click(screen.getByRole("button", STOP));
    await waitFor(() => expect(h.state.toast?.message).toMatch(/Too short/));
    expect(h.elements).toHaveLength(0);
  });

  it("discards on Esc and on tool switch without creating anything", async () => {
    await renderVoice();
    await startRecordingAt(100, 100);
    Keyboard.keyPress(KEYS.ESCAPE);
    await waitFor(() =>
      expect(screen.queryByRole("group", RECORDER)).toBeNull(),
    );
    expect(mocks.discarded).toBe(1);

    await startRecordingAt(100, 100);
    UI.clickTool("rectangle");
    await waitFor(() =>
      expect(screen.queryByRole("group", RECORDER)).toBeNull(),
    );
    expect(mocks.discarded).toBe(2);
    expect(h.state.toast?.message).toBe("Recording discarded");
    expect(h.elements).toHaveLength(0);
  });

  it("refuses to record while an outdated client is in the room", async () => {
    await renderVoice({ isCollaborating: true });
    API.updateScene({
      collaborators: new Map([
        ["old" as SocketId, { username: "old" } as Collaborator],
      ]),
    });
    UI.clickTool("voice");
    mouse.clickAt(100, 100);
    expect(h.state.toast?.message).toMatch(/older version/);
    expect(screen.queryByRole("group", RECORDER)).toBeNull();
    expect(mocks.started).toBe(0);
  });

  it("shows the host's reason instead of recording", async () => {
    await renderVoice({
      voiceOptions: { enabled: true, disabledReason: "Not in this vault" },
    });
    UI.clickTool("voice");
    mouse.clickAt(100, 100);
    expect(h.state.toast?.message).toBe("Not in this vault");
    expect(mocks.started).toBe(0);
  });
});

describe("voice playback (ADR 0034 §5)", () => {
  // jsdom has no media playback; keep the stubs until after the final unmount
  const originalPlay = HTMLMediaElement.prototype.play;
  const originalPause = HTMLMediaElement.prototype.pause;
  const { createObjectURL, revokeObjectURL } = URL;

  beforeAll(() => {
    HTMLMediaElement.prototype.play = async () => {};
    HTMLMediaElement.prototype.pause = () => {};
    URL.createObjectURL = () => "blob:voice";
    URL.revokeObjectURL = () => {};
  });

  afterAll(() => {
    HTMLMediaElement.prototype.play = originalPlay;
    HTMLMediaElement.prototype.pause = originalPause;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
  });

  beforeEach(() => {
    mouse.reset();
  });

  const setupBubble = async () => {
    await renderVoice();
    const element = API.createElement({
      type: "audio",
      x: 0,
      y: 0,
      fileId: "voice-1",
      status: "saved",
      duration: 4000,
    } as any) as unknown as ExcalidrawAudioElement;
    API.setElements([element]);
    h.app.addFiles([
      {
        id: "voice-1" as FileId,
        mimeType: "audio/webm",
        dataURL: "data:audio/webm;base64,dm9pY2U=" as DataURL,
        created: 1,
      },
    ]);
    return element;
  };

  it("toggles playback from the play button and with Enter", async () => {
    const element = await setupBubble();
    // the play button sits just right of the avatar
    mouse.clickAt(element.x + 64, element.y + AUDIO_ELEMENT_HEIGHT / 2);
    expect(editorJotaiStore.get(audioPlaybackAtom)).toEqual({
      elementId: element.id,
      status: "playing",
    });

    API.setSelectedElements([element]);
    Keyboard.keyPress(KEYS.ENTER);
    expect(editorJotaiStore.get(audioPlaybackAtom)?.status).toBe("paused");
  });

  it("doesn't play when the bubble is dragged from the play button", async () => {
    const element = await setupBubble();
    mouse.downAt(element.x + 64, element.y + AUDIO_ELEMENT_HEIGHT / 2);
    mouse.moveTo(element.x + 164, element.y + 100);
    mouse.upAt();
    expect(editorJotaiStore.get(audioPlaybackAtom)).toBeNull();
    expect(h.elements[0].x).toBe(100);
  });

  it("stops when the playing bubble is deleted", async () => {
    const element = await setupBubble();
    mouse.clickAt(element.x + 64, element.y + AUDIO_ELEMENT_HEIGHT / 2);
    expect(editorJotaiStore.get(audioPlaybackAtom)).not.toBeNull();
    act(() => {
      API.setElements([{ ...h.elements[0], isDeleted: true }]);
    });
    expect(editorJotaiStore.get(audioPlaybackAtom)).toBeNull();
  });
});
