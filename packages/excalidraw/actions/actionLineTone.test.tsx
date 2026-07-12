import { fireEvent, getByTestId } from "@testing-library/react";

import { CaptureUpdateAction, getLineTone } from "@excalidraw/element";

import { Excalidraw } from "../index";
import { API } from "../tests/helpers/api";
import { act, render } from "../tests/test-utils";

import { actionChangeLineTone } from "./actionLineTone";

const { h } = window;

describe("actionChangeLineTone", () => {
  beforeEach(async () => {
    await render(<Excalidraw />);
  });

  it("updates line, arrow, and elbow arrow with an immediate history capture", () => {
    const line = API.createElement({ type: "line", strokeColor: "#e03131" });
    const arrow = API.createElement({ type: "arrow", strokeWidth: 4 });
    const elbowArrow = API.createElement({ type: "arrow", elbowed: true });
    const rectangle = API.createElement({ type: "rectangle" });
    API.setElements([line, arrow, elbowArrow, rectangle]);
    API.setSelectedElements([line, arrow, elbowArrow, rectangle]);

    act(() => {
      h.app.actionManager.executeAction(actionChangeLineTone, "ui", "certain");
    });

    expect(h.elements.slice(0, 3).map(getLineTone)).toEqual([
      "certain",
      "certain",
      "certain",
    ]);
    expect(getLineTone(h.elements[3])).toBe(null);
    expect(h.elements[0]).toMatchObject({
      strokeColor: "#e03131",
      strokeWidth: line.strokeWidth,
    });
    expect(h.elements[1].strokeWidth).toBe(4);
    expect(h.elements[0].version).toBeGreaterThan(line.version);
    expect(h.elements[1].version).toBeGreaterThan(arrow.version);
    expect(h.elements[2].version).toBeGreaterThan(elbowArrow.version);

    const result = actionChangeLineTone.perform(
      h.app.scene.getElementsIncludingDeleted(),
      h.state,
      "possible",
      h.app,
    );
    expect(result).toMatchObject({
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  });

  it("shows a mixed value and applies one tone to the supported selection", () => {
    const line = API.createElement({
      type: "line",
      customData: { lineTone: { version: 1, tone: "certain" } },
    });
    const arrow = API.createElement({
      type: "arrow",
      customData: { lineTone: { version: 1, tone: "possible" } },
    });
    API.setElements([line, arrow]);
    API.setSelectedElements([line, arrow]);

    const normal = getByTestId(document.body, "line-tone-normal");
    const certain = getByTestId(document.body, "line-tone-certain");
    const possible = getByTestId(document.body, "line-tone-possible");
    expect(normal).not.toHaveClass("active");
    expect(certain).not.toHaveClass("active");
    expect(possible).not.toHaveClass("active");

    fireEvent.click(getByTestId(document.body, "line-tone-blocked"));
    expect(h.elements.map(getLineTone)).toEqual(["blocked", "blocked"]);
  });

  it("clears only lineTone custom data", () => {
    const line = API.createElement({
      type: "line",
      customData: {
        lineTone: { version: 1, tone: "questioned" },
        productMetadata: { owner: "team-a" },
      },
    });
    API.setElements([line]);
    API.setSelectedElements([line]);

    act(() => {
      h.app.actionManager.executeAction(actionChangeLineTone, "ui", null);
    });

    expect(getLineTone(h.elements[0])).toBe(null);
    expect(h.elements[0].customData).toEqual({
      productMetadata: { owner: "team-a" },
    });
  });
});
