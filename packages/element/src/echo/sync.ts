import { randomId } from "@excalidraw/common";

import { newElementWith } from "../mutateElement";
import { getBoundTextElement } from "../textElement";
import { isTextElement } from "../typeChecks";

import { getEchoData, setEchoData } from "./helpers";

import type { ExcalidrawElement } from "../types";
import type { EchoStatus } from "./types";

/* eslint-disable no-loop-func */

export const syncEchoChanges = (
  previous: readonly ExcalidrawElement[],
  next: readonly ExcalidrawElement[],
): readonly ExcalidrawElement[] => {
  const prev = new Map(previous.map((e) => [e.id, e]));
  const nextMap = new Map(next.map((e) => [e.id, e]));
  let result = next.slice();
  for (const source of next) {
    const echo = getEchoData(source);
    const old = prev.get(source.id);
    if (!echo || !old || source.isDeleted) {
      continue;
    }
    const oldEcho = getEchoData(old);
    const bgChanged = old.backgroundColor !== source.backgroundColor;
    const statusChanged = oldEcho?.status !== echo.status;
    const sourceText = isTextElement(source)
      ? source
      : getBoundTextElement(source, nextMap as any);
    const oldText = isTextElement(old)
      ? old
      : getBoundTextElement(old, prev as any);
    const textChanged = sourceText?.originalText !== oldText?.originalText;
    if (!bgChanged && !statusChanged && !textChanged) {
      continue;
    }
    const mutationId = randomId();
    const revision = Math.max(echo.revision, oldEcho?.revision ?? 0) + 1;
    result = result.map((target) => {
      const targetEcho = getEchoData(target);
      if (
        !targetEcho ||
        targetEcho.anchorId !== echo.anchorId ||
        target.isDeleted
      ) {
        return target;
      }
      const updated = newElementWith(target, {
        ...(bgChanged ? { backgroundColor: source.backgroundColor } : {}),
        customData: {
          ...target.customData,
          echo: {
            ...targetEcho,
            status: statusChanged ? echo.status : targetEcho.status,
            revision,
            mutationId,
            updatedByElementId: source.id,
          },
        },
      });
      if (textChanged) {
        const targetText = isTextElement(updated)
          ? updated
          : getBoundTextElement(
              updated,
              new Map(result.map((e) => [e.id, e])) as any,
            );
        if (targetText && sourceText && targetText.id !== sourceText.id) {
          result = result.map((e) =>
            e.id === targetText.id
              ? newElementWith(targetText, {
                  originalText: sourceText.originalText,
                  text: sourceText.text,
                })
              : e,
          );
        }
      }
      return updated;
    });
    break;
  }
  return result;
};

export const setEchoStatus = (
  elements: readonly ExcalidrawElement[],
  anchorId: string,
  status: EchoStatus,
  sourceId: string,
) => {
  const mutationId = randomId();
  const revision =
    Math.max(
      0,
      ...elements.map((e) =>
        getEchoData(e)?.anchorId === anchorId ? getEchoData(e)!.revision : 0,
      ),
    ) + 1;
  return elements.map((e) => {
    const echo = getEchoData(e);
    return echo?.anchorId === anchorId
      ? newElementWith(e, {
          customData: setEchoData(e, {
            ...echo,
            status,
            revision,
            mutationId,
            updatedByElementId: sourceId,
          }).customData,
        })
      : e;
  });
};
