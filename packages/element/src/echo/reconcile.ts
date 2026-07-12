import { newElementWith } from "../mutateElement";
import { getBoundTextElement } from "../textElement";
import { isTextElement } from "../typeChecks";

import { ECHO_FIELDS, getEchoData } from "./helpers";

import type { ExcalidrawElement } from "../types";
import type { EchoConflict, EchoField, EchoFieldRevision } from "./types";

const pendingConflicts = new Map<string, EchoConflict>();

const compareFieldRevision = (
  local: EchoFieldRevision,
  remote: EchoFieldRevision,
) =>
  local.revision !== remote.revision
    ? local.revision - remote.revision
    : local.mutationId !== remote.mutationId
    ? local.mutationId < remote.mutationId
      ? -1
      : 1
    : local.updatedByElementId === remote.updatedByElementId
    ? 0
    : local.updatedByElementId < remote.updatedByElementId
    ? -1
    : 1;

const getText = (
  element: ExcalidrawElement,
  elementsMap: Map<string, ExcalidrawElement>,
) =>
  isTextElement(element)
    ? element
    : getBoundTextElement(element, elementsMap as any);

const valueForField = (
  field: EchoField,
  element: ExcalidrawElement,
  elementsMap: Map<string, ExcalidrawElement>,
) => {
  if (field === "backgroundColor") {
    return element.backgroundColor;
  }
  if (field === "status") {
    return getEchoData(element)?.status;
  }
  return getText(element, elementsMap)?.originalText;
};

const recordConflict = (
  anchorId: string,
  field: EchoField,
  local: EchoFieldRevision,
  remote: EchoFieldRevision,
) => {
  const conflict = {
    anchorId,
    field,
    revision: local.revision,
    localMutationId: local.mutationId,
    remoteMutationId: remote.mutationId,
  };
  pendingConflicts.set(
    `${anchorId}:${field}:${[local.mutationId, remote.mutationId]
      .sort()
      .join(":")}`,
    conflict,
  );
};

export const drainEchoConflicts = (): EchoConflict[] => {
  const conflicts = [...pendingConflicts.values()];
  pendingConflicts.clear();
  return conflicts;
};

export const reconcileEchoElements = (
  localElements: readonly ExcalidrawElement[],
  remoteElements: readonly ExcalidrawElement[],
  reconciledElements: readonly ExcalidrawElement[],
) => {
  const localMap = new Map(
    localElements.map((element) => [element.id, element]),
  );
  const remoteMap = new Map(
    remoteElements.map((element) => [element.id, element]),
  );
  let result = reconciledElements.slice();
  const fieldWinners = new Map<
    string,
    { source: ExcalidrawElement; field: EchoField; revision: EchoFieldRevision }
  >();
  for (const local of localElements) {
    const remote = remoteMap.get(local.id);
    const localEcho = getEchoData(local);
    const remoteEcho = remote && getEchoData(remote);
    if (
      !remote ||
      !localEcho ||
      !remoteEcho ||
      localEcho.anchorId !== remoteEcho.anchorId
    ) {
      continue;
    }
    for (const field of ECHO_FIELDS) {
      const localRevision = localEcho.fields[field];
      const remoteRevision = remoteEcho.fields[field];
      const comparison = compareFieldRevision(localRevision, remoteRevision);
      const source = comparison >= 0 ? local : remote;
      const revision = comparison >= 0 ? localRevision : remoteRevision;
      fieldWinners.set(`${local.id}:${field}`, { source, field, revision });
      if (
        localRevision.revision === remoteRevision.revision &&
        localRevision.mutationId !== remoteRevision.mutationId &&
        valueForField(field, local, localMap) !==
          valueForField(field, remote, remoteMap)
      ) {
        recordConflict(
          localEcho.anchorId,
          field,
          localRevision,
          remoteRevision,
        );
      }
    }
  }
  result = result.map((element) => {
    const echo = getEchoData(element);
    if (!echo) {
      return element;
    }
    const winners = ECHO_FIELDS.map((field) =>
      fieldWinners.get(`${element.id}:${field}`),
    ).filter(Boolean) as Array<{
      source: ExcalidrawElement;
      field: EchoField;
      revision: EchoFieldRevision;
    }>;
    if (!winners.length) {
      return element;
    }
    const background = winners.find(
      (winner) => winner.field === "backgroundColor",
    );
    const status = winners.find((winner) => winner.field === "status");
    const nextBackgroundColor = background
      ? background.source.backgroundColor
      : element.backgroundColor;
    const nextStatus = status
      ? getEchoData(status.source)!.status
      : echo.status;
    const nextFields = winners.reduce(
      (fields, winner) => ({
        ...fields,
        [winner.field]: winner.revision,
      }),
      echo.fields,
    );
    const fieldsChanged = ECHO_FIELDS.some((field) => {
      const current = echo.fields[field];
      const next = nextFields[field];
      return (
        current.revision !== next.revision ||
        current.mutationId !== next.mutationId ||
        current.updatedByElementId !== next.updatedByElementId
      );
    });
    if (
      nextBackgroundColor === element.backgroundColor &&
      nextStatus === echo.status &&
      !fieldsChanged
    ) {
      return element;
    }
    return newElementWith(element, {
      backgroundColor: nextBackgroundColor,
      customData: {
        ...element.customData,
        echo: {
          ...echo,
          status: nextStatus,
          fields: nextFields,
        },
      },
    });
  });
  const resultMap = new Map(result.map((element) => [element.id, element]));
  for (const [key, winner] of fieldWinners) {
    if (winner.field !== "text") {
      continue;
    }
    const hostId = key.slice(0, key.lastIndexOf(":"));
    const targetHost = resultMap.get(hostId);
    const sourceMap =
      localMap.get(hostId) === winner.source ? localMap : remoteMap;
    if (!targetHost) {
      continue;
    }
    const targetText = getText(targetHost, resultMap);
    const sourceText = getText(winner.source, sourceMap);
    if (
      targetText &&
      sourceText &&
      targetText.originalText !== sourceText.originalText
    ) {
      result = result.map((element) =>
        element.id === targetText.id && isTextElement(element)
          ? newElementWith(element, {
              originalText: sourceText.originalText,
              text: sourceText.text,
            })
          : element,
      );
    }
  }
  return result;
};
