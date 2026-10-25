import React from "react";

import { AUDIO_ELEMENT_HEIGHT, KEYS } from "@excalidraw/common";
import { CaptureUpdateAction } from "@excalidraw/element";

import type {
  ExcalidrawAudioElement,
  ExcalidrawElement,
} from "@excalidraw/element/types";

import {
  actionAlignLeft,
  actionDeleteSelected,
  actionDetachAudio,
  actionDuplicateSelection,
} from "../actions";
import { createPasteEvent, serializeAsClipboardJSON } from "../clipboard";
import { restoreElements } from "../data/restore";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { Keyboard, Pointer, UI } from "./helpers/ui";
import {
  GlobalTestState,
  fireEvent,
  render,
  screen,
  waitFor,
} from "./test-utils";

import type { VoiceRecording } from "../voice/recorder";

const { h } = window;

vi.mock("../voice/recorder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../voice/recorder")>();
  return {
    ...actual,
    listMicrophones: async () => [],
    startVoiceRecorder: async () => ({
      track: {} as MediaStreamTrack,
      deviceId: null,
      elapsed: () => 0,
      level: () => 0.5,
      stop: async (): Promise<VoiceRecording> => ({
        blob: new Blob(["voice"], { type: "audio/webm" }),
        mimeType: "audio/webm",
        duration: 5000,
        peaks: new Array(96).fill(0.5),
      }),
      discard: () => {},
    }),
  };
});

const mouse = new Pointer("mouse");

const RECORDER = { name: "Recording voice message" };
const STOP = { name: "Stop and send" };

const renderVoice = () =>
  render(
    <Excalidraw
      autoFocus={true}
      handleKeyboardGlobally={true}
      voiceOptions={{ enabled: true }}
    />,
  );

const getAudio = () =>
  h.elements.filter(
    (element): element is ExcalidrawAudioElement => element.type === "audio",
  );

const recordAt = async (x: number, y: number) => {
  UI.clickTool("voice");
  mouse.clickAt(x, y);
  await screen.findByRole("group", RECORDER);
  await waitFor(() =>
    expect(screen.getByRole("button", STOP)).not.toBeDisabled(),
  );
  fireEvent.click(screen.getByRole("button", STOP));
  await waitFor(() => expect(screen.queryByRole("group", RECORDER)).toBeNull());
};

/** a transparent rectangle with a voice note attached in its top-left area */
const setupAttached = () => {
  const host = API.createElement({
    type: "rectangle",
    x: 100,
    y: 100,
    width: 300,
    height: 200,
  });
  const audio = API.createElement({
    type: "audio",
    x: 120,
    y: 120,
    hostId: host.id,
  });
  // seeds history, so the cascade can be undone in one step
  API.updateScene({
    elements: [host, audio],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  return { host, audio };
};

const get = (id: string) =>
  h.app.scene.getElementsMapIncludingDeleted().get(id) as ExcalidrawElement;

const highlightedIds = () =>
  h.app.getAudioAttachmentHighlight().map((element) => element.id);

describe("voice notes attached to a host (ADR 0034 R5)", () => {
  beforeEach(async () => {
    mouse.reset();
    await renderVoice();
    // paste only lands when the cursor is over the canvas
    Object.assign(document, {
      elementFromPoint: () => GlobalTestState.canvas,
    });
  });

  it("attaches at the click point inside a transparent shape, outlining it", async () => {
    const host = API.createElement({
      type: "rectangle",
      x: 100,
      y: 100,
      width: 300,
      height: 200,
    });
    API.setElements([host]);

    UI.clickTool("voice");
    mouse.moveTo(250, 200);
    expect(highlightedIds()).toEqual([host.id]);
    mouse.moveTo(600, 600);
    expect(highlightedIds()).toEqual([]);

    await recordAt(250, 200);
    const [audio] = getAudio();
    expect(audio).toMatchObject({
      hostId: host.id,
      x: 250 - AUDIO_ELEMENT_HEIGHT / 2,
      y: 200 - AUDIO_ELEMENT_HEIGHT / 2,
    });
    // the selected bubble shows what it's attached to
    expect(highlightedIds()).toEqual([host.id]);
  });

  it("outlines the bubbles of a selected host, but not selected ones", () => {
    const { host, audio } = setupAttached();
    const other = API.createElement({
      type: "audio",
      x: 200,
      y: 200,
      hostId: host.id,
    });
    API.setElements([get(host.id), get(audio.id), other]);

    API.setSelectedElements([get(host.id)]);
    expect(highlightedIds().sort()).toEqual([audio.id, other.id].sort());

    // a bubble that moves with the selection is outlined as selected already
    API.setSelectedElements([get(host.id), get(audio.id)]);
    expect(highlightedIds()).toEqual([other.id]);

    API.setSelectedElements([]);
    expect(highlightedIds()).toEqual([]);
  });

  it("stays free on empty canvas", async () => {
    await recordAt(300, 300);
    expect(getAudio()[0].hostId).toBeNull();
  });

  it("follows the host on drag and arrow keys, but moves alone", () => {
    const { host, audio } = setupAttached();

    mouse.select(host);
    mouse.downAt(300, 250);
    mouse.moveTo(350, 280);
    mouse.upAt(350, 280);
    expect(get(host.id)).toMatchObject({ x: 150, y: 130 });
    expect(get(audio.id)).toMatchObject({ x: 170, y: 150 });

    Keyboard.keyPress(KEYS.ARROW_RIGHT);
    expect(get(audio.id).x).toBe(get(host.id).x + 20);

    // moving the bubble keeps the host where it is
    API.setSelectedElements([get(audio.id)]);
    Keyboard.keyPress(KEYS.ARROW_DOWN);
    expect(get(host.id).y).toBe(130);
    expect(get(audio.id).y).toBe(151);
    expect((get(audio.id) as ExcalidrawAudioElement).hostId).toBe(host.id);
  });

  it("follows the host when aligned without moving twice", () => {
    const { host, audio } = setupAttached();
    const other = API.createElement({ type: "rectangle", x: 0, y: 500 });
    API.setElements([...h.elements, other]);

    API.setSelectedElements([host, other]);
    API.executeAction(actionAlignLeft);
    expect(get(host.id).x).toBe(0);
    expect(get(audio.id).x).toBe(20);

    // bubble also selected: it is aligned once, as its own element
    API.setSelectedElements([get(host.id), get(audio.id), other]);
    API.executeAction(actionAlignLeft);
    expect(get(audio.id).x).toBe(0);
  });

  it("is deleted with its host and restored by one undo", () => {
    const { host, audio } = setupAttached();
    const free = API.createElement({ type: "audio", x: 600, y: 600 });
    API.updateScene({
      elements: [...h.elements, free],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });

    API.setSelectedElements([host]);
    API.executeAction(actionDeleteSelected);
    expect(get(host.id).isDeleted).toBe(true);
    expect(get(audio.id).isDeleted).toBe(true);
    expect(get(free.id).isDeleted).toBe(false);

    Keyboard.undo();
    expect(get(host.id).isDeleted).toBe(false);
    expect(get(audio.id).isDeleted).toBe(false);
  });

  it("is erased with its host", () => {
    const { host, audio } = setupAttached();
    UI.clickTool("eraser");
    // click the host's left edge, away from the bubble
    mouse.clickAt(100, 280);
    expect(get(host.id).isDeleted).toBe(true);
    expect(get(audio.id).isDeleted).toBe(true);
  });

  it("is duplicated with its host and re-attached to the copy", () => {
    const { host } = setupAttached();
    API.setSelectedElements([host]);
    API.executeAction(actionDuplicateSelection);

    const audio = getAudio();
    expect(audio).toHaveLength(2);
    const copy = h.elements.find(
      (element) => element.type === "rectangle" && element.id !== host.id,
    )!;
    expect(audio.map((element) => element.hostId).sort()).toEqual(
      [host.id, copy.id].sort(),
    );
    // only the copied shape is selected; its note just follows
    expect(Object.keys(h.state.selectedElementIds)).toEqual([copy.id]);
  });

  it("pastes attached with its host, and free without it", async () => {
    const { host, audio } = setupAttached();

    const paste = async (elements: ExcalidrawElement[]) => {
      const json = await serializeAsClipboardJSON({ elements, files: null });
      Keyboard.withModifierKeys({ ctrl: true }, () => {
        Keyboard.keyPress(KEYS.V);
        document.dispatchEvent(
          createPasteEvent({ types: { "text/plain": json } }),
        );
      });
    };

    await paste([host, audio]);
    await waitFor(() => expect(getAudio()).toHaveLength(2));
    const pastedHost = h.elements.find(
      (element) => element.type === "rectangle" && element.id !== host.id,
    )!;
    expect(getAudio()[1].hostId).toBe(pastedHost.id);

    await paste([audio]);
    await waitFor(() => expect(getAudio()).toHaveLength(3));
    expect(getAudio()[2].hostId).toBeNull();
  });

  it("detaches into a free bubble", () => {
    const { host, audio } = setupAttached();
    API.setSelectedElements([audio]);
    expect(screen.getByTestId("detach-audio")).toBeVisible();

    API.executeAction(actionDetachAudio);
    expect((get(audio.id) as ExcalidrawAudioElement).hostId).toBeNull();

    API.setSelectedElements([host]);
    Keyboard.keyPress(KEYS.ARROW_RIGHT);
    expect(get(audio.id).x).toBe(120);

    Keyboard.undo();
    Keyboard.undo();
    expect((get(audio.id) as ExcalidrawAudioElement).hostId).toBe(host.id);
  });
});

describe("restoring attached voice notes", () => {
  it("frees notes whose host is missing", () => {
    const host = API.createElement({ type: "rectangle" });
    const attached = API.createElement({ type: "audio", hostId: host.id });
    const orphan = API.createElement({ type: "audio", hostId: "gone" });

    const [, restoredAttached, restoredOrphan] = restoreElements(
      [host, attached, orphan],
      null,
      { repairBindings: true },
    ) as ExcalidrawAudioElement[];
    expect(restoredAttached.hostId).toBe(host.id);
    expect(restoredOrphan.hostId).toBeNull();

    // invalid values never survive
    const [bad] = restoreElements(
      [{ ...attached, hostId: 42 } as unknown as ExcalidrawElement],
      null,
    ) as ExcalidrawAudioElement[];
    expect(bad.hostId).toBeNull();
  });
});
