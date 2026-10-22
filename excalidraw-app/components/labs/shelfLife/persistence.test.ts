import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { getDefaultAppState } from "@excalidraw/excalidraw/appState";
import {
  createShelfLifeScheduler,
  getSceneVersion,
  syncInvalidIndices,
} from "@excalidraw/element";

import Collab from "../../../collab/Collab";
import { LocalData } from "../../../data/LocalData";
import { STORAGE_KEYS } from "../../../app_constants";
import { prepareVaultAutosaveSnapshot } from "../../../App";

/** Exercises the real downstream gates, not substitutes for their dedup logic. */
describe("Shelf Life visual ticks and app persistence", () => {
  afterEach(() => {
    LocalData.flushSave();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  it("does not broadcast or schedule Vault saves; performs one local debounced save per crossed boundary and none while idle", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const elements = syncInvalidIndices([
      API.createElement({
        type: "rectangle",
        customData: { shelfLife: { version: 1, setAt: 0, expiresAt: 60_000 } },
      }),
    ]);
    const appState = {
      ...getDefaultAppState(),
      width: 800,
      height: 600,
      offsetTop: 0,
      offsetLeft: 0,
    };
    const collab = new Collab({
      excalidrawAPI: { getSceneElementsIncludingDeleted: () => elements },
    } as never);
    collab.setLastBroadcastedOrReceivedSceneVersion(getSceneVersion(elements));
    const broadcast = vi
      .spyOn(collab.portal, "broadcastScene")
      .mockResolvedValue(undefined);
    const persistence = vi
      .spyOn(collab, "queueSaveToPersistence")
      .mockImplementation(() => {});
    const saveFiles = vi
      .spyOn(LocalData.fileStorage, "saveFiles")
      .mockResolvedValue({
        savedFiles: new Map(),
        erroredFiles: new Map(),
      } as never);
    const setItem = vi.spyOn(localStorage, "setItem");
    const initial = prepareVaultAutosaveSnapshot(null, elements, appState, {})!;
    const vaultSchedule = vi.fn();
    const redraw = vi.fn(() => {
      collab.syncElements(elements);
      const prepared = prepareVaultAutosaveSnapshot(
        initial.serializedSnapshot,
        elements,
        appState,
        {},
      );
      if (prepared) {
        vaultSchedule(prepared.snapshot);
      }
      LocalData.save(elements, appState, {}, () => {});
    });
    const before = JSON.stringify(elements);
    const stop = createShelfLifeScheduler({
      getElements: () => elements,
      subscribe: () => () => {},
      redraw,
    });
    await vi.advanceTimersByTimeAsync(70_000);
    expect(redraw).toHaveBeenCalledTimes(1);
    expect(broadcast).not.toHaveBeenCalled();
    expect(vaultSchedule).not.toHaveBeenCalled();
    expect(
      setItem.mock.calls.filter(
        ([key]) => key === STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
      ),
    ).toHaveLength(1);
    expect(saveFiles).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(redraw).toHaveBeenCalledTimes(1);
    expect(
      setItem.mock.calls.filter(
        ([key]) => key === STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(elements)).toBe(before);
    stop();
    persistence.mockRestore();
  });
});
