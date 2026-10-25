import React from "react";

import { AUDIO_ELEMENT_HEIGHT, EDITOR_LS_KEYS, KEYS } from "@excalidraw/common";

import type { ExcalidrawAudioElement } from "@excalidraw/element/types";

import { Excalidraw } from "../index";
import { transcriptPopoverAtom } from "../voice/atoms";
import { editorJotaiStore } from "../editor-jotai";

import { API } from "./helpers/api";
import { FakeRecognition, installFakeSpeech } from "./helpers/fakeSpeech";
import { Keyboard, Pointer, UI } from "./helpers/ui";
import { getTextEditor } from "./queries/dom";
import { act, fireEvent, render, screen, waitFor, within } from "./test-utils";

import type { VoiceRecording } from "../voice/recorder";
import type { VoiceOptions } from "../types";

const { h } = window;

const mocks = vi.hoisted(() => ({
  micOpened: 0,
  micClosed: 0,
}));

vi.mock("../voice/recorder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../voice/recorder")>();
  const track = { readyState: "live" } as MediaStreamTrack;
  const recording: VoiceRecording = {
    blob: new Blob(["voice"], { type: "audio/webm" }),
    mimeType: "audio/webm",
    duration: 5000,
    peaks: new Array(96).fill(0.5),
  };
  return {
    ...actual,
    listMicrophones: async () => [],
    startVoiceRecorder: async () => ({
      track,
      deviceId: null,
      elapsed: () => 0,
      level: () => 0,
      stop: async () => recording,
      discard: () => {},
    }),
    openMicrophone: async () => {
      mocks.micOpened++;
      return {
        track,
        level: () => 0,
        close: () => {
          mocks.micClosed++;
        },
      };
    },
  };
});

const mouse = new Pointer("mouse");
const RECORDER = { name: "Recording voice message" };
const STOP = { name: "Stop and send" };

const renderVoice = async (voiceOptions: VoiceOptions = {}) => {
  await render(
    <Excalidraw
      handleKeyboardGlobally={true}
      voiceOptions={{ enabled: true, ...voiceOptions }}
    />,
  );
};

const startRecording = async () => {
  UI.clickTool("voice");
  mouse.clickAt(200, 150);
  await screen.findByRole("group", RECORDER);
  await waitFor(() =>
    expect(screen.getByRole("button", STOP)).not.toBeDisabled(),
  );
};

const recorderButton = (name: string) =>
  within(screen.getByRole("group", RECORDER)).getByRole("button", { name });

/** stops and lets the running recognizer deliver its last final */
const stopRecording = async (
  recognition?: FakeRecognition,
  lastFinal?: string,
) => {
  fireEvent.click(screen.getByRole("button", STOP));
  if (recognition) {
    await waitFor(() => expect(recognition.stopped).toBe(true));
    act(() => {
      if (lastFinal) {
        recognition.emit(lastFinal, true);
      }
      recognition.end();
    });
  }
  await waitFor(() => expect(h.elements).toHaveLength(1));
  return h.elements[0] as ExcalidrawAudioElement;
};

let restoreSpeech: () => void;

beforeEach(() => {
  restoreSpeech = installFakeSpeech();
  localStorage.removeItem(EDITOR_LS_KEYS.VOICE_TRANSCRIPTION_OFF);
  localStorage.removeItem(EDITOR_LS_KEYS.VOICE_TRANSCRIPTION_NOTICE_SEEN);
  localStorage.removeItem(EDITOR_LS_KEYS.VOICE_SPEECH_PATHS);
  mocks.micOpened = 0;
  mocks.micClosed = 0;
  mouse.reset();
});

afterEach(() => {
  restoreSpeech();
});

describe("live transcription while recording (ADR 0034 §7)", () => {
  it("asks once, then transcribes and stores the text on the bubble", async () => {
    await renderVoice();
    await startRecording();
    // nothing listens before the privacy notice was answered
    expect(screen.getByText(/may be sent to the browser vendor/)).toBeTruthy();
    expect(FakeRecognition.instances).toHaveLength(0);

    fireEvent.click(recorderButton("Transcribe"));
    await waitFor(() => expect(FakeRecognition.instances).toHaveLength(1));
    expect(FakeRecognition.last.lang).toBe("en-US");

    act(() => FakeRecognition.last.emit("hello", true));
    act(() => FakeRecognition.last.emit("wor", false));
    expect(screen.getByText("wor")).toBeTruthy();

    const element = await stopRecording(FakeRecognition.last, "world");
    expect(element.transcript).toEqual({
      text: "hello world",
      lang: "en-US",
      mode: "auto",
    });
    expect(
      localStorage.getItem(EDITOR_LS_KEYS.VOICE_TRANSCRIPTION_NOTICE_SEEN),
    ).toBe("true");
  });

  it("can be turned off, and stays off", async () => {
    localStorage.setItem(
      EDITOR_LS_KEYS.VOICE_TRANSCRIPTION_NOTICE_SEEN,
      "true",
    );
    await renderVoice();
    await startRecording();
    await waitFor(() => expect(FakeRecognition.instances).toHaveLength(1));
    act(() => FakeRecognition.last.emit("secret", true));

    fireEvent.click(recorderButton("Live transcription"));
    expect(FakeRecognition.last.aborted).toBe(true);
    expect(localStorage.getItem(EDITOR_LS_KEYS.VOICE_TRANSCRIPTION_OFF)).toBe(
      "true",
    );

    const element = await stopRecording();
    expect(element.transcript).toBeNull();
  });

  it("records without text when declining the notice", async () => {
    await renderVoice();
    await startRecording();
    fireEvent.click(recorderButton("Don't transcribe"));
    expect(FakeRecognition.instances).toHaveLength(0);
    const element = await stopRecording();
    expect(element.transcript).toBeNull();
    expect(element.fileId).toBeTruthy();
  });

  it("hides transcription when the host turns it off", async () => {
    await renderVoice({ transcription: "off" });
    await startRecording();
    expect(screen.queryByRole("button", { name: "Live transcription" })).toBe(
      null,
    );
    expect(FakeRecognition.instances).toHaveLength(0);
  });

  it("Vault: never uses the cloud when there is no on-device model", async () => {
    FakeRecognition.availability = "unavailable";
    await renderVoice({ transcription: "local-only" });
    await startRecording();
    await screen.findByText(/isn't supported in this mode/);
    expect(FakeRecognition.instances).toHaveLength(0);
    const element = await stopRecording();
    expect(element.transcript).toBeNull();
  });

  it("Vault: downloads the language pack only after consent", async () => {
    FakeRecognition.availability = "downloadable";
    await renderVoice({ transcription: "local-only" });
    await startRecording();
    await screen.findByText(/download a language pack once/);
    expect(FakeRecognition.installCalls).toBe(0);

    fireEvent.click(recorderButton("Download"));
    await waitFor(() => expect(FakeRecognition.instances).toHaveLength(1));
    expect(FakeRecognition.installCalls).toBe(1);
    expect(FakeRecognition.last.processLocally).toBe(true);

    act(() => FakeRecognition.last.emit("你 好", true));
    const element = await stopRecording(FakeRecognition.last);
    expect(element.transcript).toEqual({
      text: "你好",
      lang: "en-US",
      mode: "local-only",
    });
  });
});

describe("transcript popover (ADR 0034 §5)", () => {
  const setupBubble = async (viewModeEnabled = false) => {
    await render(
      <Excalidraw
        handleKeyboardGlobally={true}
        viewModeEnabled={viewModeEnabled}
        voiceOptions={{ enabled: true }}
      />,
    );
    const element = API.createElement({
      type: "audio",
      x: 0,
      y: 0,
      width: 300,
      duration: 4000,
      transcript: { text: "remember the milk", lang: "en-US", mode: "auto" },
    } as any) as unknown as ExcalidrawAudioElement;
    API.setElements([element]);
    return element;
  };

  const clickBadge = (element: ExcalidrawAudioElement) =>
    mouse.clickAt(
      element.x + element.width - 16,
      element.y + AUDIO_ELEMENT_HEIGHT / 2,
    );

  it("opens from the badge and inserts the text under the bubble", async () => {
    const element = await setupBubble();
    clickBadge(element);
    const dialog = await screen.findByRole("dialog", { name: "Transcript" });
    expect(dialog.textContent).toContain("remember the milk");
    // a click on the badge doesn't move the bubble
    expect(h.elements[0].x).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Insert as text" }));
    expect(screen.queryByRole("dialog", { name: "Transcript" })).toBeNull();
    expect(h.elements).toHaveLength(2);
    const text = h.elements[1];
    expect(text).toMatchObject({
      type: "text",
      originalText: "remember the milk",
      x: element.x,
    });
    expect(text.y).toBeGreaterThan(element.y + element.height);
    expect(h.state.selectedElementIds).toEqual({ [text.id]: true });

    Keyboard.undo();
    expect(h.elements[1].isDeleted).toBe(true);
  });

  it("closes on Esc and offers no insert in view mode", async () => {
    const element = await setupBubble(true);
    clickBadge(element);
    await screen.findByRole("dialog", { name: "Transcript" });
    expect(screen.queryByRole("button", { name: "Insert as text" })).toBe(null);
    Keyboard.keyPress(KEYS.ESCAPE);
    expect(editorJotaiStore.get(transcriptPopoverAtom)).toBeNull();
  });
});

describe("text-box voice input (ADR 0034 §8)", () => {
  const openTextEditor = async () => {
    UI.clickTool("text");
    mouse.clickAt(100, 100);
    return getTextEditor();
  };

  it("needs speech recognition", async () => {
    restoreSpeech();
    delete (window as any).SpeechRecognition;
    await renderVoice();
    await openTextEditor();
    expect(screen.queryByTestId("text-dictation")).toBeNull();
  });

  it("inserts finals at the caret and shows interim words greyed", async () => {
    await renderVoice();
    const editor = await openTextEditor();
    const mic = screen.getByTestId("text-dictation");

    fireEvent.click(mic);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(() => expect(FakeRecognition.instances).toHaveLength(1));
    expect(mocks.micOpened).toBe(1);
    expect(mic.getAttribute("aria-pressed")).toBe("true");

    act(() => FakeRecognition.last.emit("hello", false));
    const ghost = document.querySelector(".excalidraw-dictation__ghost")!;
    expect((ghost as HTMLElement).hidden).toBe(false);
    expect(
      ghost.querySelector(".excalidraw-dictation__interim")?.textContent,
    ).toBe("hello");
    expect(editor.value).toBe("");

    act(() => FakeRecognition.last.emit("hello", true));
    expect(editor.value).toBe("hello");
    expect((ghost as HTMLElement).hidden).toBe(true);
    act(() => FakeRecognition.last.emit("world", true));
    expect(editor.value).toBe("hello world");
    expect(h.elements[0]).toMatchObject({ originalText: "hello world" });

    // the editor is still open: the mic button doesn't steal focus
    fireEvent.click(mic);
    act(() => FakeRecognition.last.end());
    await waitFor(() => expect(mocks.micClosed).toBe(1));
    expect(mic.getAttribute("aria-pressed")).toBe("false");
    expect(editor.isConnected).toBe(true);
  });

  it("releases the microphone when the editor closes", async () => {
    localStorage.setItem(
      EDITOR_LS_KEYS.VOICE_TRANSCRIPTION_NOTICE_SEEN,
      "true",
    );
    await renderVoice();
    const editor = await openTextEditor();
    fireEvent.click(screen.getByTestId("text-dictation"));
    await waitFor(() => expect(FakeRecognition.instances).toHaveLength(1));
    act(() => FakeRecognition.last.emit("note", true));

    fireEvent.keyDown(editor, { key: KEYS.ESCAPE });
    await waitFor(() => expect(mocks.micClosed).toBe(1));
    expect(FakeRecognition.last.aborted).toBe(true);
    expect(screen.queryByTestId("text-dictation")).toBeNull();
    expect(h.elements[0]).toMatchObject({ originalText: "note" });
  });
});
