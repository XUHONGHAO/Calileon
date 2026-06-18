import type { FileId } from "@excalidraw/element/types";
import type { DataURL } from "@excalidraw/excalidraw/types";

import {
  appendSelectedImageSources,
  clearReferenceWeight,
  markMissingReferenceElements,
  reindexReferenceImages,
  validatePromptReferences,
} from "./AIImageWorkbenchReferences";

import type { AIImageSourceEnhanced } from "../ai/types";

const createReferenceSource = (
  overrides: Partial<AIImageSourceEnhanced> = {},
): AIImageSourceEnhanced => ({
  index: 1,
  elementId: "element-1",
  elementIds: ["element-1"],
  fileId: "file-1" as FileId,
  file: new File(["image"], "reference-1.png", { type: "image/png" }),
  dataURL: "data:image/png;base64,cmVm" as DataURL,
  width: 320,
  height: 240,
  sourceType: "canvas",
  createdAt: 1,
  ...overrides,
});

describe("AIImageWorkbenchReferences", () => {
  it("reindexes reference sources after list operations", () => {
    expect(
      reindexReferenceImages([
        createReferenceSource({ index: 8, elementId: "a" }),
        createReferenceSource({ index: 2, elementId: "b" }),
      ]).map((source) => source.index),
    ).toEqual([1, 2]);
  });

  it("appends new selected sources and deduplicates existing canvas sources", () => {
    const current = createReferenceSource({
      index: 3,
      elementId: "element-1",
      missingElement: true,
      sourceType: "canvas",
    });
    const selectedExisting = createReferenceSource({
      index: 99,
      elementId: "element-1",
      dataURL: "data:image/png;base64,bmV3" as DataURL,
    });
    const selectedNew = createReferenceSource({
      index: 99,
      elementId: "element-2",
      elementIds: ["element-2"],
      fileId: "file-2" as FileId,
    });

    const nextSources = appendSelectedImageSources(
      [current],
      [selectedExisting, selectedNew],
    );

    expect(nextSources).toHaveLength(2);
    expect(nextSources[0]).toMatchObject({
      elementId: "element-1",
      index: 1,
      missingElement: false,
      dataURL: "data:image/png;base64,cmVm",
    });
    expect(nextSources[1]).toMatchObject({
      elementId: "element-2",
      index: 2,
    });
  });

  it("refreshes imported reference image data when the same element is selected", () => {
    const imported = createReferenceSource({
      sourceType: "imported",
      missingElement: true,
      width: 320,
      height: 240,
    });
    const selected = createReferenceSource({
      dataURL: "data:image/png;base64,dXBkYXRlZA==" as DataURL,
      file: new File(["updated"], "updated.webp", { type: "image/webp" }),
      fileId: "updated-file" as FileId,
      width: 800,
      height: 600,
    });

    const [updated] = appendSelectedImageSources([imported], [selected]);

    expect(updated).toMatchObject({
      dataURL: "data:image/png;base64,dXBkYXRlZA==",
      fileId: "updated-file",
      width: 800,
      height: 600,
      missingElement: false,
    });
    expect(updated.file.name).toBe("updated.webp");
  });

  it("marks missing reference elements and clears reference weights", () => {
    const weighted = createReferenceSource({
      elementId: "missing",
      elementIds: ["missing", "fallback"],
      weight: 0.8,
    });

    expect(
      markMissingReferenceElements([weighted], [{ id: "fallback" }])[0],
    ).toMatchObject({
      missingElement: false,
    });
    expect(
      markMissingReferenceElements(
        [weighted],
        [{ id: "fallback", isDeleted: true }],
      )[0],
    ).toMatchObject({
      missingElement: true,
    });
    expect(clearReferenceWeight(weighted).weight).toBeUndefined();
  });

  it("warns when prompt reference indexes are outside the reference tray", () => {
    expect(validatePromptReferences("use #1 and image 4", 2)).toEqual([
      "Warning: #4 not found (2 references).",
    ]);
    expect(validatePromptReferences("use #2 twice #2", 1)).toEqual([
      "Warning: #2 not found (1 reference).",
    ]);
    expect(validatePromptReferences("use 图 3", 2)).toEqual([
      "Warning: #3 not found (2 references).",
    ]);
  });
});
