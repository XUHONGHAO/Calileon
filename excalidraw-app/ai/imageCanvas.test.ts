import { describe, expect, it } from "vitest";

import { getGeneratedImagePosition } from "./imageCanvas";

describe("getGeneratedImagePosition", () => {
  it("places reference-mode output to the right of the reference with top edges aligned", () => {
    const position = getGeneratedImagePosition(
      { width: 320, height: 240 },
      [],
      [
        {
          id: "reference-1",
          type: "image",
          x: 40,
          y: 42,
          width: 160,
          height: 90,
          isDeleted: false,
        } as any,
      ],
      {
        width: 1000,
        height: 700,
        scrollX: 0,
        scrollY: 0,
        zoom: { value: 1 },
      } as any,
      {
        kind: "reference",
        elementIds: ["reference-1"],
      },
    );

    expect(position).toEqual({
      x: 216,
      y: 42,
    });
  });
});
