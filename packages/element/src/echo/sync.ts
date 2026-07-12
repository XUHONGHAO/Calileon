import { randomId } from "@excalidraw/common";

import { newElementWith } from "../mutateElement";
import { getBoundTextElement } from "../textElement";
import { isTextElement } from "../typeChecks";

import { bumpEchoField, getEchoData } from "./helpers";

import type { ExcalidrawElement } from "../types";
import type { EchoData, EchoField, EchoStatus } from "./types";

const getText = (
  element: ExcalidrawElement,
  elementsMap: Map<string, ExcalidrawElement>,
) =>
  isTextElement(element)
    ? element
    : getBoundTextElement(element, elementsMap as any);

const updateEchoFields = (
  echo: EchoData,
  fields: readonly EchoField[],
  sourceId: string,
) => {
  const mutationId = randomId();
  return fields.reduce(
    (next, field) => bumpEchoField(next, field, sourceId, mutationId),
    echo,
  );
};

export const syncEchoChanges = (
  previous: readonly ExcalidrawElement[],
  next: readonly ExcalidrawElement[],
): readonly ExcalidrawElement[] => {
  const previousMap = new Map(previous.map((element) => [element.id, element]));
  const nextMap = new Map(next.map((element) => [element.id, element]));
  const source = next.find((element) => {
    const old = previousMap.get(element.id);
    const echo = getEchoData(element);
    if (!old || !echo || element.isDeleted) {
      return false;
    }
    return (
      old.backgroundColor !== element.backgroundColor ||
      getEchoData(old)?.status !== echo.status ||
      getText(old, previousMap)?.originalText !==
        getText(element, nextMap)?.originalText
    );
  });
  if (!source) {
    return next;
  }
  const sourceEcho = getEchoData(source)!;
  const oldSource = previousMap.get(source.id)!;
  const sourceText = getText(source, nextMap);
  const changedFields: EchoField[] = [];
  if (oldSource.backgroundColor !== source.backgroundColor) {
    changedFields.push("backgroundColor");
  }
  if (getEchoData(oldSource)?.status !== sourceEcho.status) {
    changedFields.push("status");
  }
  if (
    getText(oldSource, previousMap)?.originalText !== sourceText?.originalText
  ) {
    changedFields.push("text");
  }
  const updatedEcho = updateEchoFields(sourceEcho, changedFields, source.id);
  let result = next.map((element) => {
    const echo = getEchoData(element);
    if (!echo || echo.anchorId !== sourceEcho.anchorId || element.isDeleted) {
      return element;
    }
    return newElementWith(element, {
      ...(changedFields.includes("backgroundColor")
        ? { backgroundColor: source.backgroundColor }
        : {}),
      customData: {
        ...element.customData,
        echo: {
          ...echo,
          status: changedFields.includes("status")
            ? sourceEcho.status
            : echo.status,
          fields: changedFields.reduce(
            (fields, field) => ({
              ...fields,
              [field]: updatedEcho.fields[field],
            }),
            echo.fields,
          ),
        },
      },
    });
  });
  if (changedFields.includes("text") && sourceText) {
    const resultMap = new Map(result.map((element) => [element.id, element]));
    const textIds = new Set(
      result
        .filter(
          (element) => getEchoData(element)?.anchorId === sourceEcho.anchorId,
        )
        .map((element) => getText(element, resultMap)?.id)
        .filter(Boolean),
    );
    result = result.map((element) =>
      textIds.has(element.id) &&
      element.id !== sourceText.id &&
      isTextElement(element)
        ? newElementWith(element, {
            originalText: sourceText.originalText,
            text: sourceText.text,
          })
        : element,
    );
  }
  return result;
};

export const setEchoStatus = (
  elements: readonly ExcalidrawElement[],
  anchorId: string,
  status: EchoStatus,
  sourceId: string,
) => {
  const sourceEcho = elements
    .map(getEchoData)
    .find((echo) => echo?.anchorId === anchorId);
  if (!sourceEcho) {
    return elements;
  }
  const updated = bumpEchoField(sourceEcho, "status", sourceId);
  return elements.map((element) => {
    const echo = getEchoData(element);
    return echo?.anchorId === anchorId
      ? newElementWith(element, {
          customData: {
            ...element.customData,
            echo: {
              ...echo,
              status,
              fields: { ...echo.fields, status: updated.fields.status },
            },
          },
        })
      : element;
  });
};
