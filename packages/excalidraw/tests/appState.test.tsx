import React from "react";

import { EXPORT_DATA_TYPES, MIME_TYPES } from "@excalidraw/common";

import type { ExcalidrawTextElement } from "@excalidraw/element/types";

import { getDefaultAppState } from "../appState";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { Pointer, UI } from "./helpers/ui";
import { fireEvent, queryByTestId, render, waitFor } from "./test-utils";

const { h } = window;

describe("appState", () => {
  it("drag&drop file doesn't reset non-persisted appState", async () => {
    const defaultAppState = getDefaultAppState();
    const exportBackground = !defaultAppState.exportBackground;

    await render(
      <Excalidraw
        initialData={{
          appState: {
            exportBackground,
            viewBackgroundColor: "#F00",
          },
        }}
      />,
      {},
    );

    await waitFor(() => {
      expect(h.state.exportBackground).toBe(exportBackground);
      expect(h.state.viewBackgroundColor).toBe("#F00");
    });

    await API.drop([
      {
        kind: "file",
        file: new Blob(
          [
            JSON.stringify({
              type: EXPORT_DATA_TYPES.excalidraw,
              appState: {
                viewBackgroundColor: "#000",
              },
              elements: [API.createElement({ type: "rectangle", id: "A" })],
            }),
          ],
          { type: MIME_TYPES.json },
        ),
      },
    ]);

    await waitFor(() => {
      expect(h.elements).toEqual([expect.objectContaining({ id: "A" })]);
      // non-imported prop → retain
      expect(h.state.exportBackground).toBe(exportBackground);
      // imported prop → overwrite
      expect(h.state.viewBackgroundColor).toBe("#000");
    });
  });

  it("has expected lumina (C1) defaults", () => {
    const defaultAppState = getDefaultAppState();
    // 光照默认关闭 → 对现有用户零影响。
    expect(defaultAppState.luminaEnabled).toBe(false);
    // 环境光默认压暗到 0.35：开启光照时画布立刻变暗，白色光源在暗背景上可辨识。
    // 若有人把它改回 1（不变暗），开启光照会「看起来没反应」——见开发日志。
    expect(defaultAppState.luminaAmbient).toBe(0.35);
    expect(defaultAppState.luminaCaustics).toBe(false);
    expect(defaultAppState.luminaGameMode).toBe(null);
  });

  it("changing fontSize with text tool selected (no element created yet)", async () => {
    const { container } = await render(
      <Excalidraw
        initialData={{
          appState: {
            currentItemFontSize: 30,
          },
        }}
      />,
    );

    UI.clickTool("text");

    expect(h.state.currentItemFontSize).toBe(30);
    fireEvent.click(queryByTestId(container, "fontSize-small")!);
    expect(h.state.currentItemFontSize).toBe(16);

    const mouse = new Pointer("mouse");

    mouse.clickAt(100, 100);

    expect((h.elements[0] as ExcalidrawTextElement).fontSize).toBe(16);
  });
});
