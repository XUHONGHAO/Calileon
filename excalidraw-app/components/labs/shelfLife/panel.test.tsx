import React from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import {
  act,
  render,
  screen,
  fireEvent,
} from "@excalidraw/excalidraw/tests/test-utils";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";
import { Keyboard } from "@excalidraw/excalidraw/tests/helpers/ui";
import {
  CaptureUpdateAction,
  planShelfLifeCleanup,
  setShelfLifeForSelection,
  syncInvalidIndices,
} from "@excalidraw/element";
import { t } from "@excalidraw/excalidraw/i18n";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { closeLabsFeature, openLabsFeature } from "../labsDialogs";

import { ShelfLifeHost } from ".";

const life = { version: 1 as const, setAt: 1, expiresAt: 2 };

it("sets, removes, and cleans up in single undoable steps without touching style", async () => {
  let api!: ExcalidrawImperativeAPI;
  await render(
    <Excalidraw
      handleKeyboardGlobally
      onExcalidrawAPI={(value) => {
        if (value) {
          api = value as ExcalidrawImperativeAPI;
        }
      }}
    />,
  );
  const fresh = API.createElement({
    type: "rectangle",
    opacity: 63,
    backgroundColor: "#ff0000",
  });
  const expired = API.createElement({
    id: "expired",
    customData: { shelfLife: life },
  });
  const locked = API.createElement({
    id: "locked",
    locked: true,
    customData: { shelfLife: life },
  });
  act(() =>
    api.updateScene({
      elements: syncInvalidIndices([fresh, expired, locked]),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    }),
  );
  const apply = (data: typeof life | null, selectedIds: Record<string, true>) =>
    act(() =>
      api.updateScene({
        elements: setShelfLifeForSelection(
          api.getSceneElementsIncludingDeleted(),
          selectedIds,
          data,
        ),
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      }),
    );

  apply(life, { [fresh.id]: true });
  expect(
    api.getSceneElements().find((el) => el.id === fresh.id)?.customData
      ?.shelfLife,
  ).toEqual(life);
  Keyboard.undo();
  expect(
    api.getSceneElements().find((el) => el.id === fresh.id)?.customData
      ?.shelfLife,
  ).toBeUndefined();
  expect(api.getSceneElements().find((el) => el.id === fresh.id)?.opacity).toBe(
    63,
  );

  apply(null, { [expired.id]: true });
  expect(
    api.getSceneElements().find((el) => el.id === expired.id)?.customData
      ?.shelfLife,
  ).toBeUndefined();
  Keyboard.undo();
  expect(
    api.getSceneElements().find((el) => el.id === expired.id)?.customData
      ?.shelfLife,
  ).toEqual(life);

  const plan = planShelfLifeCleanup(api.getSceneElementsIncludingDeleted());
  expect(plan.count).toBe(1);
  expect(plan.lockedCount).toBe(1);
  act(() =>
    api.updateScene({
      elements: plan.elements,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    }),
  );
  expect(
    api
      .getSceneElements()
      .map((el) => el.id)
      .sort(),
  ).toEqual([fresh.id, locked.id].sort());
  Keyboard.undo();
  expect(api.getSceneElements()).toHaveLength(3);
  expect(
    api.getSceneElements().find((el) => el.id === expired.id)?.customData
      ?.shelfLife,
  ).toEqual(life);
  expect(
    api.getSceneElements().find((el) => el.id === fresh.id)?.backgroundColor,
  ).toBe("#ff0000");
});

it("warns about past dates and reports locked notes separately", async () => {
  let api!: ExcalidrawImperativeAPI;
  const Wrapper = () => {
    const [value, setValue] = React.useState<ExcalidrawImperativeAPI | null>(
      null,
    );
    return (
      <Excalidraw
        onExcalidrawAPI={(next) => {
          if (next) {
            api = next as ExcalidrawImperativeAPI;
            setValue(api);
          }
        }}
      >
        <ShelfLifeHost excalidrawAPI={value} externalFeaturesDisabled />
      </Excalidraw>
    );
  };
  await render(<Wrapper />);
  const root = API.createElement({ type: "rectangle" });
  const locked = API.createElement({
    type: "rectangle",
    locked: true,
    customData: { shelfLife: life },
  });
  act(() => openLabsFeature("shelfLife"));
  act(() =>
    api.updateScene({
      elements: syncInvalidIndices([root, locked]),
      appState: { selectedElementIds: { [root.id]: true } },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    }),
  );
  fireEvent.change(screen.getByLabelText(t("labs.shelfLife.customDate")), {
    target: { value: "2020-01-01" },
  });
  expect(screen.getByText(t("labs.shelfLife.immediate"))).toBeInTheDocument();
  expect(
    screen.getByText(t("labs.shelfLife.locked", { count: 1 })),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByText(t("labs.shelfLife.apply")));
  expect(
    api.getSceneElements().find((el) => el.id === root.id)?.customData
      ?.shelfLife,
  ).toBeTruthy();
  act(() => closeLabsFeature("shelfLife"));
});
