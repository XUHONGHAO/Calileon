import React from "react";
import { EXPORT_DATA_TYPES, MIME_TYPES } from "@excalidraw/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import { actionClearCanvas, actionLoadScene } from "../actions";
import * as filesystemModule from "../data/filesystem";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { act, render, unmountComponent, waitFor } from "./test-utils";

const { h } = window;

const createSceneFile = (id: string) =>
  new File(
    [
      JSON.stringify({
        type: EXPORT_DATA_TYPES.excalidraw,
        elements: [API.createElement({ type: "rectangle", id })],
        appState: {},
      }),
    ],
    `${id}.excalidraw`,
    { type: MIME_TYPES.json },
  );

describe("onSceneReplace", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    unmountComponent();
  });

  it("fires for explicit clear and reset, but not ordinary scene updates", async () => {
    const onSceneReplace = vi.fn();
    await render(<Excalidraw onSceneReplace={onSceneReplace} />);

    API.updateScene({
      elements: [API.createElement({ type: "rectangle", id: "ordinary" })],
    });
    expect(onSceneReplace).not.toHaveBeenCalled();

    act(() => {
      (h.app as any).actionManager.executeAction(actionClearCanvas);
    });
    expect(onSceneReplace).toHaveBeenCalledTimes(1);

    act(() => {
      (h.app as any).resetScene();
    });
    expect(onSceneReplace).toHaveBeenCalledTimes(2);
  });

  it("fires after loading a scene through the load action", async () => {
    const onSceneReplace = vi.fn();
    vi.spyOn(filesystemModule, "fileOpen").mockResolvedValue(
      createSceneFile("loaded") as File & { handle?: FileSystemFileHandle },
    );
    await render(<Excalidraw onSceneReplace={onSceneReplace} />);

    await act(async () => {
      await (h.app as any).actionManager.executeAction(actionLoadScene);
    });

    await waitFor(() => {
      expect(h.elements).toEqual([expect.objectContaining({ id: "loaded" })]);
    });
    expect(onSceneReplace).toHaveBeenCalledTimes(1);
  });

  it("does not fire when loading a scene is cancelled", async () => {
    const onSceneReplace = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(filesystemModule, "fileOpen").mockRejectedValue(
      new DOMException("Cancelled", "AbortError"),
    );
    await render(<Excalidraw onSceneReplace={onSceneReplace} />);

    await act(async () => {
      await (h.app as any).actionManager.executeAction(actionLoadScene);
    });

    expect(onSceneReplace).not.toHaveBeenCalled();
  });

  it("fires after replacing the scene through file drop", async () => {
    const onSceneReplace = vi.fn();
    await render(<Excalidraw onSceneReplace={onSceneReplace} />);

    await API.drop([{ kind: "file", file: createSceneFile("dropped") }]);

    await waitFor(() => {
      expect(h.elements).toEqual([expect.objectContaining({ id: "dropped" })]);
    });
    expect(onSceneReplace).toHaveBeenCalledTimes(1);
  });
});
