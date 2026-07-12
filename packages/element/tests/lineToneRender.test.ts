import { pointFrom, type LocalPoint } from "@excalidraw/math";
import { API } from "@excalidraw/excalidraw/tests/helpers/api";

import {
  getLineTonePathAnchor,
  getLineToneRenderElement,
} from "../src/lineTone";

import type { ExcalidrawLinearElement, ElementsMap } from "../src/types";

describe("line tone rendering helpers", () => {
  it.each([
    ["certain", "dotted", 2, "solid", 2],
    ["possible", "solid", 2, "dashed", 2],
    ["blocked", "dashed", 2, "solid", 3],
    ["questioned", "solid", 4, "dotted", 4],
  ] as const)(
    "derives %s visuals without mutating persisted style",
    (tone, strokeStyle, strokeWidth, renderedStyle, renderedWidth) => {
      const element = API.createElement({
        type: "arrow",
        strokeColor: "#e03131",
        strokeStyle,
        strokeWidth,
        opacity: 63,
        startArrowhead: "circle",
        endArrowhead: "triangle",
        customData: { lineTone: { version: 1, tone } },
      }) as ExcalidrawLinearElement;

      const rendered = getLineToneRenderElement(element);

      expect(rendered.strokeStyle).toBe(renderedStyle);
      expect(rendered.strokeWidth).toBe(renderedWidth);
      expect(rendered.strokeColor).toBe(element.strokeColor);
      expect(rendered.opacity).toBe(element.opacity);
      expect(rendered.startArrowhead).toBe(element.startArrowhead);
      expect(rendered.endArrowhead).toBe(element.endArrowhead);
      expect(element.strokeStyle).toBe(strokeStyle);
      expect(element.strokeWidth).toBe(strokeWidth);
    },
  );

  it("uses the elbow arrow's visible path midpoint instead of its bounds center", () => {
    const element = API.createElement({
      type: "arrow",
      elbowed: true,
      width: 100,
      height: 100,
      points: [
        pointFrom<LocalPoint>(0, 0),
        pointFrom<LocalPoint>(100, 0),
        pointFrom<LocalPoint>(100, 100),
      ],
      customData: { lineTone: { version: 1, tone: "blocked" } },
    }) as ExcalidrawLinearElement;
    const elementsMap = new Map([[element.id, element]]) as ElementsMap;

    const anchor = getLineTonePathAnchor(element, elementsMap);

    expect(anchor).not.toBeNull();
    expect(anchor!.point[0]).toBeGreaterThan(80);
    expect(anchor!.point[1]).toBeLessThan(20);
    expect(anchor!.point).not.toEqual([50, 50]);
  });

  it.each([
    {
      name: "left-to-right horizontal line",
      points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(100, 0)],
      expectedSide: "above",
    },
    {
      name: "right-to-left horizontal line",
      points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(-100, 0)],
      expectedSide: "above",
    },
    {
      name: "top-to-bottom vertical line",
      points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(0, 100)],
      expectedSide: "left",
    },
    {
      name: "bottom-to-top vertical line",
      points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(0, -100)],
      expectedSide: "left",
    },
  ])(
    "places the marker on the preferred side for $name",
    ({ points, expectedSide }) => {
      const element = API.createElement({
        type: "line",
        points,
        customData: { lineTone: { version: 1, tone: "certain" } },
      }) as ExcalidrawLinearElement;
      const elementsMap = new Map([[element.id, element]]) as ElementsMap;

      const anchor = getLineTonePathAnchor(element, elementsMap);

      expect(anchor).not.toBeNull();
      if (expectedSide === "above") {
        expect(anchor!.normal[1]).toBeLessThan(0);
      } else {
        expect(anchor!.normal[0]).toBeLessThan(0);
      }
    },
  );
});
