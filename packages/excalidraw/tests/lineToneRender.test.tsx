import { exportToCanvas, exportToSvg } from "@excalidraw/utils";
import { pointFrom, type LocalPoint } from "@excalidraw/math";

import {
  getLineTonePathAnchor,
  LINE_TONE_MARKER_OFFSET,
  renderLineToneMarker,
} from "@excalidraw/element";

import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import { API } from "./helpers/api";

describe("line tone SVG rendering", () => {
  it.each(["certain", "possible", "blocked", "questioned"] as const)(
    "exports %s as a vector marker using the user's color",
    async (tone) => {
      const element = API.createElement({
        type: "arrow",
        width: 160,
        height: 60,
        points: [
          pointFrom<LocalPoint>(0, 0),
          pointFrom<LocalPoint>(80, 0),
          pointFrom<LocalPoint>(160, 60),
        ],
        strokeColor: "#e03131",
        customData: { lineTone: { version: 1, tone } },
      });

      const svg = await exportToSvg({
        elements: [element] as NonDeletedExcalidrawElement[],
        files: null,
        exportPadding: 20,
      });
      const marker = svg.querySelector(`[data-line-tone="${tone}"]`);

      expect(marker).not.toBeNull();
      expect(marker).toHaveAttribute("stroke", "#e03131");
      expect(marker?.querySelector("path")).not.toBeNull();
      expect(marker?.querySelector("image")).toBeNull();
    },
  );

  it("keeps the possible tone dash override out of persisted element style", async () => {
    const element = API.createElement({
      type: "line",
      width: 160,
      height: 0,
      points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(160, 0)],
      strokeStyle: "solid",
      customData: { lineTone: { version: 1, tone: "possible" } },
    });

    const svg = await exportToSvg({
      elements: [element] as NonDeletedExcalidrawElement[],
      files: null,
      exportPadding: 20,
    });

    expect(svg.innerHTML).toContain("stroke-dasharray");
    expect(element.strokeStyle).toBe("solid");
  });

  it("hides the canvas marker below the minimum zoom", () => {
    const element = API.createElement({
      type: "line",
      width: 160,
      height: 0,
      points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(160, 0)],
      customData: { lineTone: { version: 1, tone: "certain" } },
    });
    const elementsMap = new Map([[element.id, element]]);
    const context = document.createElement("canvas").getContext("2d")!;
    const translate = vi.spyOn(context, "translate");
    const renderConfig = {
      isExporting: false,
      theme: "light",
      canvasBackgroundColor: "#ffffff",
    } as any;

    renderLineToneMarker(element, elementsMap, context, renderConfig, {
      zoom: { value: 0.39 },
      scrollX: 0,
      scrollY: 0,
    } as any);
    expect(translate).not.toHaveBeenCalled();

    renderLineToneMarker(element, elementsMap, context, renderConfig, {
      zoom: { value: 0.4 },
      scrollX: 0,
      scrollY: 0,
    } as any);
    expect(translate).toHaveBeenCalledTimes(1);
  });

  it("places an unlabeled marker directly at the visible path midpoint", () => {
    const element = API.createElement({
      type: "line",
      width: 160,
      height: 0,
      points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(160, 0)],
      customData: { lineTone: { version: 1, tone: "certain" } },
    });
    const elementsMap = new Map([[element.id, element]]);
    const anchor = getLineTonePathAnchor(element, elementsMap)!;
    const context = document.createElement("canvas").getContext("2d")!;
    const translate = vi.spyOn(context, "translate");
    const arc = vi.spyOn(context, "arc");

    renderLineToneMarker(
      element,
      elementsMap,
      context,
      {
        isExporting: false,
        theme: "light",
        canvasBackgroundColor: "#ffffff",
      } as any,
      { zoom: { value: 1 }, scrollX: 0, scrollY: 0 } as any,
    );

    expect(translate.mock.calls[0][0]).toBeCloseTo(anchor.point[0]);
    expect(translate.mock.calls[0][1]).toBeCloseTo(anchor.point[1]);
    expect(arc).toHaveBeenCalledWith(0, 0, 9, 0, Math.PI * 2);
  });

  it("moves the marker to the preferred side when the midpoint has a label", () => {
    const element = API.createElement({
      type: "arrow",
      id: "labeled-arrow",
      width: 160,
      height: 0,
      points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(160, 0)],
      boundElements: [{ type: "text", id: "line-label" }],
      customData: { lineTone: { version: 1, tone: "questioned" } },
    });
    const label = API.createElement({
      type: "text",
      id: "line-label",
      containerId: element.id,
      text: "Why?",
    });
    const elementsMap = new Map<string, ExcalidrawElement>([
      [element.id, element],
      [label.id, label],
    ]);
    const anchor = getLineTonePathAnchor(element, elementsMap)!;
    const context = document.createElement("canvas").getContext("2d")!;
    const translate = vi.spyOn(context, "translate");

    renderLineToneMarker(
      element,
      elementsMap,
      context,
      {
        isExporting: false,
        theme: "light",
        canvasBackgroundColor: "#ffffff",
      } as any,
      { zoom: { value: 1 }, scrollX: 0, scrollY: 0 } as any,
    );

    expect(translate.mock.calls[0][0]).toBeCloseTo(
      anchor.point[0] + anchor.normal[0] * LINE_TONE_MARKER_OFFSET,
    );
    expect(translate.mock.calls[0][1]).toBeCloseTo(
      anchor.point[1] + anchor.normal[1] * LINE_TONE_MARKER_OFFSET,
    );
    expect(anchor.normal[1]).toBeLessThan(0);
  });

  it("includes the marker in canvas/PNG export while an ordinary line does not", async () => {
    const ordinary = API.createElement({
      type: "line",
      width: 160,
      height: 0,
      points: [pointFrom<LocalPoint>(0, 0), pointFrom<LocalPoint>(160, 0)],
    });
    const toned = {
      ...ordinary,
      customData: { lineTone: { version: 1, tone: "certain" as const } },
    };
    const translate = vi.spyOn(CanvasRenderingContext2D.prototype, "translate");

    await exportToCanvas({ elements: [ordinary], files: null });
    const ordinaryTranslateCount = translate.mock.calls.length;
    translate.mockClear();

    await exportToCanvas({ elements: [toned], files: null });

    // The extra translation positions the vector glyph at its path anchor.
    expect(translate.mock.calls.length).toBe(ordinaryTranslateCount + 1);
  });
});
