import { t } from "@excalidraw/excalidraw/i18n";

import type { FileId } from "@excalidraw/element/types";
import type { BinaryFiles, DataURL } from "@excalidraw/excalidraw/types";

import { dataURLToFile } from "../ai/imageCanvas";

import type { AIImageSourceEnhanced } from "../ai/types";

const MAX_PERSISTED_REFERENCE_IMAGES = 24;
// Reference images now persist their base64 dataURL so they survive a refresh
// even when their source element is gone (e.g. an exported-selection reference
// has no scene file to rehydrate from). base64 PNGs are large, so the cap is
// generous; the trim loop below drops the oldest images if we'd blow the quota.
const MAX_PERSISTED_REFERENCE_STATE_BYTES = 4 * 1024 * 1024;

export const reindexReferenceImages = (
  sources: readonly AIImageSourceEnhanced[],
): AIImageSourceEnhanced[] => {
  return sources.map((source, index) => ({
    ...source,
    index: index + 1,
  }));
};

export const appendSelectedImageSources = (
  currentSources: readonly AIImageSourceEnhanced[],
  selectedImageSources: readonly AIImageSourceEnhanced[],
) => {
  if (!selectedImageSources.length) {
    return reindexReferenceImages(currentSources);
  }

  const nextSources = [...currentSources];

  for (const selectedSource of selectedImageSources) {
    const existingIndex = nextSources.findIndex((source) =>
      referenceSourceContainsElement(source, selectedSource.elementId),
    );

    if (existingIndex < 0) {
      nextSources.push(selectedSource);
      continue;
    }

    const existingSource = nextSources[existingIndex];

    nextSources[existingIndex] =
      existingSource.sourceType === "imported"
        ? {
            ...existingSource,
            dataURL: selectedSource.dataURL,
            file: selectedSource.file,
            fileId: selectedSource.fileId,
            width: selectedSource.width,
            height: selectedSource.height,
            missingElement: false,
          }
        : {
            ...existingSource,
            missingElement: false,
          };
  }

  return reindexReferenceImages(nextSources);
};

export const referenceSourceContainsElement = (
  source: AIImageSourceEnhanced,
  elementId: string,
) => {
  return (
    source.elementId === elementId || source.elementIds?.includes(elementId)
  );
};

export const clearReferenceWeight = (
  source: AIImageSourceEnhanced,
): AIImageSourceEnhanced => {
  const nextSource = { ...source };

  delete nextSource.weight;

  return nextSource;
};

export const markMissingReferenceElements = (
  sources: readonly AIImageSourceEnhanced[],
  elements: readonly { id: string; isDeleted?: boolean }[],
) => {
  const existingElementIds = new Set(
    elements
      .filter((element) => !element.isDeleted)
      .map((element) => element.id),
  );

  return sources.map((source) => {
    const sourceElementIds = source.elementIds?.length
      ? source.elementIds
      : [source.elementId];

    return {
      ...source,
      missingElement: !sourceElementIds.some((elementId) =>
        existingElementIds.has(elementId),
      ),
    };
  });
};

// Shared matcher for reference tokens (`#1`, `图 2`, `image 3`). Kept in one
// place so validation warnings and the inline highlight layer always agree on
// what counts as a reference.
const PROMPT_REFERENCE_PATTERN = /#(\d+)|图\s*(\d+)|image\s+(\d+)/gi;

export type PromptReferenceSegment = {
  text: string;
  type: "text" | "reference" | "invalid-reference";
};

// Splits a prompt into plain-text runs and reference tokens so the editor can
// paint each token: valid references (1..imageCount) in the brand color,
// out-of-range references in red. Concatenating every segment's `text` returns
// the original prompt unchanged, which the mirror highlight layer relies on to
// stay pixel-aligned with the textarea.
export const tokenizePromptReferences = (
  prompt: string,
  imageCount: number,
): PromptReferenceSegment[] => {
  const segments: PromptReferenceSegment[] = [];
  let lastIndex = 0;

  for (const match of prompt.matchAll(PROMPT_REFERENCE_PATTERN)) {
    const start = match.index ?? 0;
    const token = match[0];

    if (start > lastIndex) {
      segments.push({ text: prompt.slice(lastIndex, start), type: "text" });
    }

    const value = match[1] || match[2] || match[3];
    const referenceIndex = Number(value);
    const isValid =
      Number.isFinite(referenceIndex) &&
      referenceIndex >= 1 &&
      referenceIndex <= imageCount;

    segments.push({
      text: token,
      type: isValid ? "reference" : "invalid-reference",
    });
    lastIndex = start + token.length;
  }

  if (lastIndex < prompt.length) {
    segments.push({ text: prompt.slice(lastIndex), type: "text" });
  }

  return segments;
};

export const validatePromptReferences = (
  prompt: string,
  imageCount: number,
) => {
  const warnings = new Set<string>();
  const matches = prompt.matchAll(PROMPT_REFERENCE_PATTERN);

  for (const match of matches) {
    const value = match[1] || match[2] || match[3];
    const referenceIndex = Number(value);

    if (
      Number.isFinite(referenceIndex) &&
      (referenceIndex < 1 || referenceIndex > imageCount)
    ) {
      warnings.add(
        imageCount === 1
          ? t("ai.workbench.referenceNotFoundWarningSingular", {
              index: referenceIndex,
            })
          : t("ai.workbench.referenceNotFoundWarningPlural", {
              index: referenceIndex,
              count: imageCount,
            }),
      );
    }
  }

  return Array.from(warnings);
};

export const persistReferenceState = (
  key: string,
  state: { locked: boolean; images: readonly AIImageSourceEnhanced[] },
) => {
  try {
    const persistedImages = state.images
      .slice(0, MAX_PERSISTED_REFERENCE_IMAGES)
      .map((source) => ({
        index: source.index,
        elementId: source.elementId,
        elementIds: source.elementIds,
        fileId: source.fileId,
        sourceType: source.sourceType,
        weight: source.weight,
        locked: source.locked,
        createdAt: source.createdAt,
        width: source.width,
        height: source.height,
        fileName: source.file.name,
        mimeType: source.file.type,
        // Persist the pixel data itself. Restoring previously depended on the
        // scene still containing files[fileId], which fails for
        // exported-selection references (no fileId) — so refreshes silently
        // dropped them. normalizePersistedReferenceImage() reads this back.
        dataURL: source.dataURL,
      }));
    const payload = {
      version: 3,
      locked: state.locked,
      images: persistedImages,
    };
    let serialized = JSON.stringify(payload);

    while (
      serialized.length > MAX_PERSISTED_REFERENCE_STATE_BYTES &&
      payload.images.length > 0
    ) {
      payload.images.pop();
      serialized = JSON.stringify(payload);
    }

    localStorage.setItem(key, serialized);
  } catch (error) {
    console.error("Could not persist AI reference images", error);
  }
};

export const loadPersistedReferenceState = (
  key: string,
  files: BinaryFiles,
): { locked: boolean; images: AIImageSourceEnhanced[] } | null => {
  try {
    const rawValue = localStorage.getItem(key);

    if (!rawValue) {
      return null;
    }

    const parsed = JSON.parse(rawValue);
    const images = Array.isArray(parsed?.images)
      ? parsed.images
          .map((value: unknown, index: number) =>
            normalizePersistedReferenceImage(value, index, files),
          )
          .filter(
            (
              source: AIImageSourceEnhanced | null,
            ): source is AIImageSourceEnhanced => !!source,
          )
      : [];

    return {
      locked: parsed?.locked === true,
      images,
    };
  } catch (error) {
    console.error("Could not restore AI reference images", error);
    return null;
  }
};

const normalizePersistedReferenceImage = (
  value: unknown,
  fallbackIndex: number,
  files: BinaryFiles,
): AIImageSourceEnhanced | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const elementId = readString(candidate.elementId);
  const sourceType = readString(candidate.sourceType);
  const fileId = readString(candidate.fileId);
  const legacyDataURL = readString(candidate.dataURL);

  if (!elementId || !isReferenceSourceType(sourceType)) {
    return null;
  }

  const typedFileId = fileId as FileId | "";
  const fileData = typedFileId ? files[typedFileId] : null;
  const dataURL = (fileData?.dataURL || legacyDataURL) as DataURL | "";

  if (!dataURL) {
    return null;
  }

  const mimeType =
    fileData?.mimeType || readString(candidate.mimeType) || "image/png";
  const fileName =
    readString(candidate.fileName) || `reference-${Date.now()}.png`;
  const createdAt =
    typeof candidate.createdAt === "number"
      ? candidate.createdAt
      : Date.now() + fallbackIndex;
  const elementIds = Array.isArray(candidate.elementIds)
    ? candidate.elementIds.filter(
        (elementId): elementId is string => typeof elementId === "string",
      )
    : [elementId];

  return {
    index:
      typeof candidate.index === "number" ? candidate.index : fallbackIndex + 1,
    elementId,
    elementIds,
    fileId: typedFileId || undefined,
    sourceType,
    weight: typeof candidate.weight === "number" ? candidate.weight : undefined,
    locked: candidate.locked === true,
    createdAt,
    dataURL,
    width: typeof candidate.width === "number" ? candidate.width : undefined,
    height: typeof candidate.height === "number" ? candidate.height : undefined,
    file: dataURLToFile(dataURL, fileName, mimeType),
  };
};

const readString = (value: unknown) => {
  return typeof value === "string" ? value : "";
};

const isReferenceSourceType = (
  value: string,
): value is AIImageSourceEnhanced["sourceType"] => {
  return value === "imported" || value === "canvas" || value === "mixed";
};
