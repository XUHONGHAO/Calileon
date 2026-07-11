import { randomId } from "@excalidraw/common";

import type { ExcalidrawElement } from "../types";
import type { EchoDataV1, EchoStatus } from "./types";

const statuses = new Set<EchoStatus>([
  null,
  "todo",
  "in-progress",
  "blocked",
  "done",
]);

export const getEchoData = (element: ExcalidrawElement): EchoDataV1 | null => {
  const value = element.customData?.echo;
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== 1 ||
    typeof value.anchorId !== "string" ||
    !value.anchorId
  ) {
    return null;
  }
  return {
    version: 1,
    anchorId: value.anchorId,
    name: typeof value.name === "string" ? value.name : "",
    status: statuses.has(value.status) ? value.status : null,
    revision:
      Number.isFinite(value.revision) && value.revision >= 0
        ? Math.floor(value.revision)
        : 0,
    ...(typeof value.mutationId === "string"
      ? { mutationId: value.mutationId }
      : {}),
    ...(typeof value.updatedByElementId === "string"
      ? { updatedByElementId: value.updatedByElementId }
      : {}),
  };
};

export const isEchoSupportedElement = (element: ExcalidrawElement) =>
  element.type === "text" ||
  element.type === "rectangle" ||
  element.type === "diamond" ||
  element.type === "ellipse";

export const setEchoData = (element: ExcalidrawElement, echo: EchoDataV1) => ({
  ...element,
  customData: { ...element.customData, echo },
});

export const clearEchoData = (element: ExcalidrawElement) => {
  if (!element.customData || !("echo" in element.customData)) {
    return element;
  }
  const { echo: _echo, ...customData } = element.customData;
  return {
    ...element,
    customData: Object.keys(customData).length ? customData : undefined,
  };
};

export const createEchoData = (
  name: string,
  elementId: string,
): EchoDataV1 => ({
  version: 1,
  anchorId: randomId(),
  name,
  status: null,
  revision: 0,
  mutationId: randomId(),
  updatedByElementId: elementId,
});

export const remapEchoAnchorIds = (elements: readonly ExcalidrawElement[]) => {
  const ids = new Map<string, string>();
  return elements.map((element) => {
    const echo = getEchoData(element);
    if (!echo) {
      return element;
    }
    const anchorId = ids.get(echo.anchorId) ?? randomId();
    ids.set(echo.anchorId, anchorId);
    return setEchoData(element, { ...echo, anchorId, mutationId: randomId() });
  });
};
