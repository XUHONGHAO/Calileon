import { newElementWith } from "@excalidraw/element";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import {
  buildAIVideoAssetLink,
  getAIVideoGenerationMetadataFromEmbeddable,
} from "./videoCanvas";

import type {
  AIVideoGenerationMetadata,
  AIVideoGenerationMetadataV2,
} from "./types";

export type AIVideoPortability =
  | { kind: "legacy-v1-url"; metadata: AIVideoGenerationMetadata }
  | { kind: "local-v2"; metadata: AIVideoGenerationMetadataV2 }
  | { kind: "portable-v2"; metadata: AIVideoGenerationMetadataV2 }
  | { kind: "invalid-marker" }
  | { kind: "not-ai-video" };

export const hasAIVideoGenerationMarker = (
  element: Pick<ExcalidrawElement, "customData">,
) =>
  !!element.customData &&
  typeof element.customData === "object" &&
  Object.prototype.hasOwnProperty.call(element.customData, "aiVideoGeneration");

export const classifyAIVideoPortability = (
  element: Pick<ExcalidrawElement, "type" | "link" | "customData">,
): AIVideoPortability => {
  if (!hasAIVideoGenerationMarker(element)) {
    return { kind: "not-ai-video" };
  }

  const metadata = getAIVideoGenerationMetadataFromEmbeddable(element);
  if (!metadata || !element.link) {
    return { kind: "invalid-marker" };
  }

  if (metadata.version === 1) {
    return element.link === metadata.videoURL
      ? { kind: "legacy-v1-url", metadata }
      : { kind: "invalid-marker" };
  }

  if (element.link !== buildAIVideoAssetLink(metadata.assetId)) {
    return { kind: "invalid-marker" };
  }

  return metadata.assetId.startsWith("local:")
    ? { kind: "local-v2", metadata }
    : { kind: "portable-v2", metadata };
};

export const hasNonPortableAIVideo = (
  elements: readonly Pick<ExcalidrawElement, "type" | "link" | "customData">[],
  { allowLocalAssets = false }: { allowLocalAssets?: boolean } = {},
) =>
  elements.some((element) => {
    const classification = classifyAIVideoPortability(element);
    return (
      classification.kind !== "not-ai-video" &&
      classification.kind !== "portable-v2" &&
      !(allowLocalAssets && classification.kind === "local-v2")
    );
  });

export const sanitizeDeletedAIVideoMarkersForPersistence = <
  T extends ExcalidrawElement,
>(
  elements: readonly T[],
): readonly T[] => {
  let didSanitize = false;
  const sanitizedElements = elements.map((element) => {
    if (!element.isDeleted || !hasAIVideoGenerationMarker(element)) {
      return element;
    }

    const { aiVideoGeneration: _marker, ...remainingCustomData } =
      element.customData || {};
    didSanitize = true;
    return {
      ...element,
      link: null,
      customData:
        Object.keys(remainingCustomData).length > 0
          ? remainingCustomData
          : undefined,
    } as T;
  });

  return didSanitize ? sanitizedElements : elements;
};

export const omitAIVideoMarkersForInitialCloudSave = <
  T extends Pick<ExcalidrawElement, "customData">,
>(
  elements: readonly T[],
): readonly T[] =>
  elements.filter((element) => !hasAIVideoGenerationMarker(element));
export type AIVideoMigrationSnapshot = {
  elementId: string;
  elementVersion: number;
  link: string;
  metadata: AIVideoGenerationMetadata;
  contextToken: string;
};

export const createAIVideoMigrationSnapshot = (
  element: ExcalidrawElement,
  contextToken: string,
): AIVideoMigrationSnapshot | null => {
  const classification = classifyAIVideoPortability(element);
  if (
    classification.kind === "not-ai-video" ||
    classification.kind === "invalid-marker" ||
    !element.link
  ) {
    return null;
  }

  return {
    elementId: element.id,
    elementVersion: element.version,
    link: element.link,
    metadata: classification.metadata,
    contextToken,
  };
};

export const replaceAIVideoAssetIfCurrent = ({
  elements,
  snapshot,
  currentContextToken,
  metadata,
}: {
  elements: readonly ExcalidrawElement[];
  snapshot: AIVideoMigrationSnapshot;
  currentContextToken: string;
  metadata: AIVideoGenerationMetadataV2;
}): { elements: readonly ExcalidrawElement[]; didReplace: boolean } => {
  if (currentContextToken !== snapshot.contextToken) {
    return { elements, didReplace: false };
  }

  let didReplace = false;
  const nextElements = elements.map((element) => {
    if (
      element.id !== snapshot.elementId ||
      element.version !== snapshot.elementVersion ||
      element.link !== snapshot.link
    ) {
      return element;
    }

    const currentMetadata = getAIVideoGenerationMetadataFromEmbeddable(element);
    if (
      !currentMetadata ||
      JSON.stringify(currentMetadata) !== JSON.stringify(snapshot.metadata)
    ) {
      return element;
    }

    didReplace = true;
    return newElementWith(element, {
      link: buildAIVideoAssetLink(metadata.assetId),
      customData: {
        ...(element.customData || {}),
        aiVideoGeneration: metadata,
      },
    });
  });

  return didReplace
    ? { elements: nextElements, didReplace }
    : { elements, didReplace };
};
