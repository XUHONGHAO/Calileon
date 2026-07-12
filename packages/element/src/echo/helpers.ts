import { randomId } from "@excalidraw/common";

import type { ExcalidrawElement } from "../types";
import type {
  EchoData,
  EchoDataV1,
  EchoDataV2,
  EchoField,
  EchoFieldRevision,
  EchoStatus,
} from "./types";

const statuses = new Set<EchoStatus>([
  null,
  "todo",
  "in-progress",
  "blocked",
  "done",
]);
export const ECHO_FIELDS: readonly EchoField[] = [
  "text",
  "status",
  "backgroundColor",
];

const normalizeRevision = (value: unknown) =>
  Number.isFinite(value) && Number(value) >= 0 ? Math.floor(Number(value)) : 0;

const normalizeFieldRevision = (
  value: unknown,
  fallback: EchoFieldRevision,
): EchoFieldRevision => {
  if (!value || typeof value !== "object") {
    return fallback;
  }
  const field = value as Partial<EchoFieldRevision>;
  return {
    revision: normalizeRevision(field.revision),
    mutationId:
      typeof field.mutationId === "string"
        ? field.mutationId
        : fallback.mutationId,
    updatedByElementId:
      typeof field.updatedByElementId === "string"
        ? field.updatedByElementId
        : fallback.updatedByElementId,
  };
};

export const normalizeEchoData = (value: unknown): EchoData | null => {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as any).anchorId !== "string" ||
    !(value as any).anchorId
  ) {
    return null;
  }
  const raw = value as EchoDataV1 | EchoDataV2;
  const name = typeof raw.name === "string" ? raw.name : "";
  const status = statuses.has(raw.status) ? raw.status : null;
  if (raw.version === 1) {
    const revision = normalizeRevision(raw.revision);
    const fallback = {
      revision,
      mutationId: raw.mutationId ?? `v1-${raw.anchorId}-${revision}`,
      updatedByElementId: raw.updatedByElementId ?? "",
    };
    return {
      version: 2,
      anchorId: raw.anchorId,
      name,
      status,
      fields: {
        text: fallback,
        status: fallback,
        backgroundColor: fallback,
      },
    };
  }
  if (raw.version !== 2) {
    return null;
  }
  const fallback = { revision: 0, mutationId: "", updatedByElementId: "" };
  return {
    version: 2,
    anchorId: raw.anchorId,
    name,
    status,
    fields: {
      text: normalizeFieldRevision(raw.fields?.text, fallback),
      status: normalizeFieldRevision(raw.fields?.status, fallback),
      backgroundColor: normalizeFieldRevision(
        raw.fields?.backgroundColor,
        fallback,
      ),
    },
  };
};

export const getEchoData = (element: ExcalidrawElement): EchoData | null =>
  normalizeEchoData(element.customData?.echo);

export const isEchoSupportedElement = (element: ExcalidrawElement) =>
  element.type === "text" ||
  element.type === "rectangle" ||
  element.type === "diamond" ||
  element.type === "ellipse";

export const setEchoData = (element: ExcalidrawElement, echo: EchoData) => ({
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

export const createEchoData = (name: string, elementId: string): EchoData => {
  const mutationId = randomId();
  const field = { revision: 0, mutationId, updatedByElementId: elementId };
  return {
    version: 2,
    anchorId: randomId(),
    name,
    status: null,
    fields: { text: field, status: field, backgroundColor: field },
  };
};

export const bumpEchoField = (
  echo: EchoData,
  field: EchoField,
  sourceId: string,
  mutationId = randomId(),
): EchoData => ({
  ...echo,
  fields: {
    ...echo.fields,
    [field]: {
      revision: echo.fields[field].revision + 1,
      mutationId,
      updatedByElementId: sourceId,
    },
  },
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
    return setEchoData(element, { ...echo, anchorId });
  });
};
