import { API } from "@excalidraw/excalidraw/tests/helpers/api";

import {
  clearEchoData,
  getEchoData,
  remapEchoAnchorIds,
  syncEchoChanges,
} from "../src/echo";

const echo = (anchorId = "anchor") => ({
  version: 1 as const,
  anchorId,
  name: "Card",
  status: null,
  revision: 0,
});

describe("Echo anchors", () => {
  it("requires an explicit valid anchorId", () => {
    expect(
      getEchoData(
        API.createElement({
          type: "rectangle",
          customData: { echo: { version: 1, name: "Card" } },
        }),
      ),
    ).toBeNull();
  });

  it("remaps imported groups while preserving batch grouping", () => {
    const items = [
      API.createElement({ type: "rectangle", customData: { echo: echo() } }),
      API.createElement({ type: "ellipse", customData: { echo: echo() } }),
    ];
    const remapped = remapEchoAnchorIds(items);
    expect(getEchoData(remapped[0])!.anchorId).toBe(
      getEchoData(remapped[1])!.anchorId,
    );
    expect(getEchoData(remapped[0])!.anchorId).not.toBe("anchor");
  });

  it("clears only Echo customData", () => {
    const item = API.createElement({
      type: "rectangle",
      customData: { echo: echo(), luminaMaterial: { material: "glass" } },
    });
    expect(clearEchoData(item).customData).toEqual({
      luminaMaterial: { material: "glass" },
    });
  });

  it("syncs only background and status, preserving geometry and Lumina", () => {
    const a = API.createElement({
      type: "rectangle",
      x: 0,
      backgroundColor: "#fff",
      customData: { echo: echo(), luminaMaterial: { material: "glass" } },
    });
    const b = API.createElement({
      type: "ellipse",
      x: 200,
      backgroundColor: "#000",
      customData: { echo: echo(), luminaLight: { intensity: 2 } },
    });
    const changed = {
      ...a,
      backgroundColor: "#ff0000",
      customData: {
        ...a.customData,
        echo: { ...echo(), status: "done" as const },
      },
    };
    const result = syncEchoChanges([a, b], [changed, b]);
    const synced = result.find((el) => el.id === b.id)!;
    expect(synced.backgroundColor).toBe("#ff0000");
    expect(getEchoData(synced)?.status).toBe("done");
    expect(synced.x).toBe(200);
    expect(synced.customData?.luminaLight).toEqual({ intensity: 2 });
  });

  it("does not rebroadcast an unchanged mutation", () => {
    const a = API.createElement({
      type: "rectangle",
      customData: { echo: { ...echo(), mutationId: "m1" } },
    });
    const b = API.createElement({
      type: "ellipse",
      customData: { echo: { ...echo(), mutationId: "m1" } },
    });
    expect(syncEchoChanges([a, b], [a, b])).toEqual([a, b]);
  });
});
