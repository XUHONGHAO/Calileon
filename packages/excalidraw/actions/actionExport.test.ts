import { describe, expect, it, vi } from "vitest";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { getDefaultAppState } from "../appState";

import { prepareDataForJSONExport } from "./actionExport";

import type { AppClassProperties, BinaryFiles } from "../types";

const createAppState = () => ({
  ...getDefaultAppState(),
  width: 1000,
  height: 800,
  offsetTop: 0,
  offsetLeft: 0,
});

const createApp = (
  onExport: NonNullable<AppClassProperties["props"]["onExport"]>,
  files: BinaryFiles = {},
) =>
  ({
    files,
    props: { onExport },
    state: { isLoading: false },
  } as AppClassProperties);

describe("prepareDataForJSONExport", () => {
  it("rejects with AbortError when the host cancels the export", async () => {
    const appState = createAppState();
    const files = {};
    const { data } = prepareDataForJSONExport(
      [],
      appState,
      files,
      createApp(() => ({ cancel: true })),
    );

    await expect(data).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses the data override returned by an async generator", async () => {
    const originalElements: readonly ExcalidrawElement[] = [];
    const overriddenElements = [{ id: "overridden" }] as ExcalidrawElement[];
    const originalAppState = createAppState();
    const overriddenAppState = {
      ...originalAppState,
      name: "overridden",
    };
    const originalFiles = {};
    const overriddenFiles = { overridden: {} } as unknown as BinaryFiles;
    const app = createApp(async function* () {
      yield { type: "progress" as const, progress: 0.5 };
      return {
        elements: overriddenElements,
        appState: overriddenAppState,
        files: overriddenFiles,
      };
    });
    app.setAppState = vi.fn();

    const { data } = prepareDataForJSONExport(
      originalElements,
      originalAppState,
      originalFiles,
      app,
    );

    await expect(data).resolves.toEqual({
      elements: overriddenElements,
      appState: overriddenAppState,
      files: overriddenFiles,
    });
  });

  it("preserves the original export data when onExport throws", async () => {
    const elements = [{ id: "original" }] as ExcalidrawElement[];
    const appState = createAppState();
    const files = { original: {} } as unknown as BinaryFiles;
    const error = new Error("host failed");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const { data } = prepareDataForJSONExport(
      elements,
      appState,
      files,
      createApp(() => {
        throw error;
      }, files),
    );

    await expect(data).resolves.toEqual({ elements, appState, files });
    expect(consoleError).toHaveBeenCalledWith(
      "Error during props.onExport() handling",
      error,
    );
    consoleError.mockRestore();
  });
});
