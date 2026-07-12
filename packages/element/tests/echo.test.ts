import { API } from "@excalidraw/excalidraw/tests/helpers/api";

import {
  clearEchoData,
  getEchoData,
  remapEchoAnchorIds,
  reconcileEchoElements,
  drainEchoConflicts,
  syncEchoChanges,
} from "../src/echo";

const echo = (anchorId = "anchor") => ({
  version: 1 as const,
  anchorId,
  name: "Card",
  status: null,
  revision: 0,
});

const echoV2 = (overrides: Record<string, any> = {}) => ({
  version: 2 as const,
  anchorId: "anchor",
  name: "Card",
  status: null,
  fields: {
    text: { revision: 0, mutationId: "text-0", updatedByElementId: "a" },
    status: { revision: 0, mutationId: "status-0", updatedByElementId: "a" },
    backgroundColor: {
      revision: 0,
      mutationId: "bg-0",
      updatedByElementId: "a",
    },
  },
  ...overrides,
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

  it("merges concurrent edits to different fields", () => {
    const local = API.createElement({
      type: "rectangle",
      backgroundColor: "#ff0000",
      customData: {
        echo: echoV2({
          fields: {
            ...echoV2().fields,
            backgroundColor: {
              revision: 2,
              mutationId: "bg-2",
              updatedByElementId: "local",
            },
          },
        }),
      },
    });
    const remote = {
      ...local,
      backgroundColor: "#000000",
      customData: {
        echo: echoV2({
          status: "done",
          fields: {
            ...echoV2().fields,
            status: {
              revision: 3,
              mutationId: "status-3",
              updatedByElementId: "remote",
            },
          },
        }),
      },
    };
    const [merged] = reconcileEchoElements([local], [remote], [remote]);
    expect(merged.backgroundColor).toBe("#ff0000");
    expect(getEchoData(merged)?.status).toBe("done");
  });

  it("rejects stale field updates without rejecting newer sibling fields", () => {
    const local = API.createElement({
      type: "rectangle",
      backgroundColor: "#ff0000",
      customData: {
        echo: echoV2({
          fields: {
            ...echoV2().fields,
            backgroundColor: {
              revision: 5,
              mutationId: "new",
              updatedByElementId: "local",
            },
          },
        }),
      },
    });
    const remote = {
      ...local,
      backgroundColor: "#000000",
      customData: {
        echo: echoV2({
          status: "blocked",
          fields: {
            ...echoV2().fields,
            backgroundColor: {
              revision: 4,
              mutationId: "old",
              updatedByElementId: "remote",
            },
            status: {
              revision: 6,
              mutationId: "status-new",
              updatedByElementId: "remote",
            },
          },
        }),
      },
    };
    const [merged] = reconcileEchoElements([local], [remote], [remote]);
    expect(merged.backgroundColor).toBe("#ff0000");
    expect(getEchoData(merged)?.status).toBe("blocked");
  });

  it("reports same-field concurrent conflicts once and converges deterministically", () => {
    const local = API.createElement({
      type: "rectangle",
      backgroundColor: "#ff0000",
      customData: {
        echo: echoV2({
          fields: {
            ...echoV2().fields,
            backgroundColor: {
              revision: 2,
              mutationId: "a",
              updatedByElementId: "local",
            },
          },
        }),
      },
    });
    const remote = {
      ...local,
      backgroundColor: "#00ff00",
      customData: {
        echo: echoV2({
          fields: {
            ...echoV2().fields,
            backgroundColor: {
              revision: 2,
              mutationId: "b",
              updatedByElementId: "remote",
            },
          },
        }),
      },
    };
    const [fromLocal] = reconcileEchoElements([local], [remote], [local]);
    const [fromRemote] = reconcileEchoElements([remote], [local], [remote]);
    expect(fromLocal.backgroundColor).toBe(fromRemote.backgroundColor);
    expect(drainEchoConflicts()).toHaveLength(1);
    reconcileEchoElements([local], [remote], [local]);
    expect(drainEchoConflicts()).toHaveLength(1);
  });
});
