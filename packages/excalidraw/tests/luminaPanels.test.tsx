import { fireEvent, queryByTestId } from "@testing-library/react";

import { getLuminaGameData } from "@excalidraw/element/lumina";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { act, render } from "./test-utils";

const { h } = window;

const editMode = {
  luminaEnabled: true,
  luminaGameMode: { style: "laser", phase: "edit" } as const,
};

const selectTarget = () => {
  const rect = API.createElement({
    type: "rectangle",
    id: "target",
    customData: { luminaGame: { role: "target" } },
  });
  API.setElements([rect]);
  API.setSelectedElements([rect]);
  API.setAppState(editMode);
  return rect;
};

const puzzleId = () => getLuminaGameData(h.elements[0])?.puzzleId;

describe("Lumina game constraint text inputs", () => {
  beforeEach(async () => {
    await render(<Excalidraw />);
  });

  it("keeps spaces while typing and commits once on blur", () => {
    selectTarget();
    const input = queryByTestId(
      document.body,
      "lumina-game-puzzle-id",
    ) as HTMLInputElement;
    const undoDepth = () => h.history.undoStack.length;
    const before = undoDepth();

    fireEvent.change(input, { target: { value: "level " } });
    fireEvent.change(input, { target: { value: "level 1 " } });
    // Nothing is written (and nothing trimmed) while typing.
    expect(input.value).toBe("level 1 ");
    expect(puzzleId()).toBeUndefined();
    expect(undoDepth()).toBe(before);

    fireEvent.blur(input);
    expect(puzzleId()).toBe("level 1");
    expect(undoDepth()).toBe(before + 1);
    expect(input.value).toBe("level 1");
  });

  it("commits on Enter and restores the committed value on Escape", () => {
    selectTarget();
    const input = queryByTestId(
      document.body,
      "lumina-game-label",
    ) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "main gate" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(getLuminaGameData(h.elements[0])?.label).toBe("main gate");

    fireEvent.change(input, { target: { value: "oops" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("main gate");
    expect(getLuminaGameData(h.elements[0])?.label).toBe("main gate");
  });
});

describe("Lumina panels in the compact (tablet) shape actions", () => {
  beforeAll(() => {
    // Radix popovers measure themselves; jsdom has no ResizeObserver.
    if (!("ResizeObserver" in window)) {
      (window as any).ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    }
  });

  beforeEach(async () => {
    await render(<Excalidraw UIOptions={{ getFormFactor: () => "tablet" }} />);
    // The editor reads the form factor on resize (no ResizeObserver here).
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
  });

  it("offers material, role and constraints in the actions popover", () => {
    selectTarget();
    expect(document.querySelector(".compact-shape-actions")).not.toBeNull();
    expect(queryByTestId(document.body, "lumina-material-glass")).toBeNull();

    const trigger = document.querySelector<HTMLButtonElement>(
      `.compact-shape-actions .properties-trigger[title="Actions"]`,
    )!;
    act(() => {
      fireEvent.click(trigger);
    });

    expect(
      queryByTestId(document.body, "lumina-material-glass"),
    ).not.toBeNull();
    expect(
      queryByTestId(document.body, "lumina-game-role-target"),
    ).not.toBeNull();
    expect(
      queryByTestId(document.body, "lumina-game-puzzle-id"),
    ).not.toBeNull();
  });

  it("shows light swatches inline instead of a nested color popover", () => {
    const light = API.createElement({
      type: "ellipse",
      id: "light",
      customData: {
        luminaLight: {
          light: "point",
          color: "#ffffff",
          intensity: 1,
          castShadows: true,
        },
      },
    });
    API.setElements([light]);
    API.setSelectedElements([light]);
    API.setAppState({ luminaEnabled: true, luminaGameMode: null });

    act(() => {
      fireEvent.click(
        document.querySelector<HTMLButtonElement>(
          `.compact-shape-actions .properties-trigger[title="Actions"]`,
        )!,
      );
    });

    const swatches = document.querySelector(".lumina-light-color");
    expect(swatches).not.toBeNull();
    const pick = swatches!.querySelector<HTMLButtonElement>(
      ".color-picker__button",
    )!;
    act(() => {
      fireEvent.click(pick);
    });
    // The popover stayed open and the light took the colour.
    expect(document.querySelector(".lumina-light-color")).not.toBeNull();
    expect(h.elements[0].customData?.luminaLight?.color).toBe(pick.title);
  });

  it("offers line tone in the compact stroke popover", () => {
    const arrow = API.createElement({ type: "arrow" });
    API.setElements([arrow]);
    API.setSelectedElements([arrow]);

    act(() => {
      fireEvent.click(
        document.querySelector<HTMLButtonElement>(
          `.compact-shape-actions .properties-trigger[title="Stroke"]`,
        )!,
      );
    });
    expect(queryByTestId(document.body, "line-tone-certain")).not.toBeNull();
  });
});
