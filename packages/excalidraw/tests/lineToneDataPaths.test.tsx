import React from "react";

import { resolvablePromise } from "@excalidraw/common";
import { getLineTone, syncInvalidIndices } from "@excalidraw/element";

import { reconcileElements } from "../data/reconcile";

import { CaptureUpdateAction, Excalidraw } from "../index";

import { API } from "./helpers/api";
import { act, render } from "./test-utils";

import type { ExcalidrawImperativeAPI } from "../types";
import type { RemoteExcalidrawElement } from "../data/reconcile";

describe("line tone portable data paths", () => {
  it("is available through the public scene API used by controlled embeds", async () => {
    const apiPromise = resolvablePromise<ExcalidrawImperativeAPI>();
    await render(
      <Excalidraw
        onExcalidrawAPI={(api) => api && apiPromise.resolve(api as any)}
      />,
    );
    const api = await apiPromise;
    const arrow = API.createElement({
      type: "arrow",
      customData: { lineTone: { version: 1, tone: "certain" } },
    });

    act(() => {
      api.updateScene({
        elements: [arrow],
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    });

    const sceneArrow = api.getSceneElements()[0];
    expect(sceneArrow.customData?.lineTone).toEqual({
      version: 1,
      tone: "certain",
    });
    expect(getLineTone(sceneArrow)).toBe("certain");
  });

  it("keeps the winning remote tone during collaboration reconciliation", () => {
    const local = syncInvalidIndices([
      API.createElement({
        type: "line",
        id: "shared-line",
        customData: { lineTone: { version: 1, tone: "possible" } },
      }),
    ])[0];
    const remote = syncInvalidIndices([
      {
        ...local,
        version: local.version + 1,
        versionNonce: local.versionNonce + 1,
        customData: {
          ...local.customData,
          lineTone: { version: 1, tone: "blocked" },
        },
      },
    ])[0] as RemoteExcalidrawElement;

    const reconciled = reconcileElements([local], [remote], {} as any);

    expect(reconciled).toHaveLength(1);
    expect(getLineTone(reconciled[0])).toBe("blocked");
  });
});
