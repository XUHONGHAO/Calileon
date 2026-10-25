import { arrayToMap } from "@excalidraw/common";

import { mutateElement } from "../mutateElement";
import {
  isAudioElement,
  isBoundToContainer,
  isFrameLikeElement,
} from "../typeChecks";

import type { Scene } from "../Scene";

import type {
  ElementsMap,
  ElementsMapOrArray,
  ExcalidrawAudioElement,
  ExcalidrawElement,
  NonDeleted,
} from "../types";

// Voice notes attached to another element (ADR 0034 R5). The link is one-way,
// like `frameId`: only the bubble stores `hostId`, so the host's schema and
// every `boundElements` consumer stay untouched.

/** elements a voice note can be attached to */
export const isAudioHostElement = (
  element: ExcalidrawElement | null | undefined,
): element is NonDeleted<ExcalidrawElement> =>
  !!element &&
  !element.isDeleted &&
  !isAudioElement(element) &&
  !isFrameLikeElement(element) &&
  // bound text resolves to its container before reaching here
  !isBoundToContainer(element) &&
  element.type !== "selection";

/** the live host of a voice note, or null when it's free or the host is gone */
export const getAudioHost = (
  element: ExcalidrawAudioElement,
  elementsMap: ElementsMap,
) => {
  if (!element.hostId) {
    return null;
  }
  const host = elementsMap.get(element.hostId);
  return isAudioHostElement(host) ? host : null;
};

/** non-deleted voice notes attached to any of `hostIds` */
export const getAttachedAudioElements = (
  elements: ElementsMapOrArray,
  hostIds: ReadonlySet<ExcalidrawElement["id"]>,
) => {
  const attached: NonDeleted<ExcalidrawAudioElement>[] = [];
  if (!hostIds.size) {
    return attached;
  }
  for (const element of elements.values()) {
    if (
      isAudioElement(element) &&
      !element.isDeleted &&
      element.hostId &&
      hostIds.has(element.hostId)
    ) {
      attached.push(element as NonDeleted<ExcalidrawAudioElement>);
    }
  }
  return attached;
};

/**
 * Voice notes that must follow `movedElements` but aren't among them, so a
 * caller translating the moved set by one delta can translate these by the
 * same delta without moving anything twice.
 */
export const getAudioToFollowHosts = (
  elements: ElementsMapOrArray,
  movedElements: readonly ExcalidrawElement[],
) => {
  const movedIds = new Set(movedElements.map((element) => element.id));
  return getAttachedAudioElements(elements, movedIds).filter(
    (element) => !movedIds.has(element.id),
  );
};

/**
 * Translates the voice notes attached to `hosts` by the hosts' own delta.
 * Notes in `skipIds` (e.g. the rest of the selection, which moves itself)
 * are left alone so nothing moves twice.
 */
export const moveAttachedAudio = (
  scene: Scene,
  hosts: readonly ExcalidrawElement[],
  delta: { x: number; y: number },
  skipIds: ReadonlySet<ExcalidrawElement["id"]> = new Set(),
  opts?: { informMutation?: boolean },
) => {
  if (!delta.x && !delta.y) {
    return;
  }
  for (const audio of getAudioToFollowHosts(
    scene.getNonDeletedElements(),
    hosts,
  )) {
    if (!skipIds.has(audio.id)) {
      scene.mutateElement(
        audio,
        { x: audio.x + delta.x, y: audio.y + delta.y },
        { informMutation: opts?.informMutation ?? true, isDragging: false },
      );
    }
  }
};

/**
 * Gives attached voice notes their host's frame after the host was moved
 * into or out of one, so frame clipping and frame moves treat them alike.
 * Mutates in place like `addElementsToFrame`.
 */
export const syncAttachedAudioFrames = <T extends ElementsMapOrArray>(
  allElements: T,
): T => {
  const elementsMap = arrayToMap(allElements);
  for (const element of allElements.values()) {
    if (isAudioElement(element) && !element.isDeleted && element.hostId) {
      const host = elementsMap.get(element.hostId);
      if (isAudioHostElement(host) && host.frameId !== element.frameId) {
        mutateElement(element, elementsMap, { frameId: host.frameId });
      }
    }
  }
  return allElements;
};

/**
 * Drops voice notes whose host is also in `elements`, e.g. so duplicating a
 * shape selects the copy only and the copied note just follows it.
 */
export const omitAttachedAudio = <T extends ExcalidrawElement>(
  elements: readonly T[],
): T[] => {
  const ids = new Set(elements.map((element) => element.id));
  return elements.filter(
    (element) =>
      !(isAudioElement(element) && element.hostId && ids.has(element.hostId)),
  );
};
