import { randomId } from "@excalidraw/common";
import {
  CaptureUpdateAction,
  clearEchoData,
  createEchoData,
  duplicateElements,
  getEchoData,
  isEchoSupportedElement,
  newElementWith,
  setEchoData,
  setEchoStatus,
} from "@excalidraw/element";

import { arrayToMap } from "@excalidraw/common";
import {
  getSelectedElements,
  getSelectionStateForElements,
} from "@excalidraw/element";

import type { EchoStatus } from "@excalidraw/element";

import { register } from "./register";

export const actionCreateEchoAnchor = register<string>({
  name: "createEchoAnchor",
  label: "labels.echo.createAnchor",
  trackEvent: false,
  perform: (elements, appState, name, app) => {
    const selected = app.scene
      .getSelectedElements(appState)
      .filter(isEchoSupportedElement);
    if (selected.length !== 1 || !name?.trim()) {
      return false;
    }
    const source = selected[0];
    return {
      elements: elements.map((e) =>
        e.id === source.id
          ? newElementWith(e, {
              customData: setEchoData(e, createEchoData(name.trim(), e.id))
                .customData,
            })
          : e,
      ),
      appState,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
});

export const actionBindEchoSelection = register({
  name: "bindEchoSelection",
  label: "labels.echo.bindSelection",
  trackEvent: false,
  perform: (elements, appState, _value, app) => {
    const selected = app.scene
      .getSelectedElements(appState)
      .filter(isEchoSupportedElement);
    const source = selected.find((e) => getEchoData(e));
    const echo = source && getEchoData(source);
    if (!source || !echo || selected.length < 2) {
      return false;
    }
    return {
      elements: elements.map((e) =>
        selected.some((s) => s.id === e.id)
          ? newElementWith(e, {
              backgroundColor: source.backgroundColor,
              customData: setEchoData(e, {
                ...echo,
                mutationId: randomId(),
                updatedByElementId: source.id,
              }).customData,
            })
          : e,
      ),
      appState,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
});

export const actionUnbindEchoSelection = register({
  name: "unbindEchoSelection",
  label: "labels.echo.unbind",
  trackEvent: false,
  perform: (elements, appState, _v, app) => ({
    elements: elements.map((e) =>
      appState.selectedElementIds[e.id]
        ? newElementWith(e, { customData: clearEchoData(e).customData })
        : e,
    ),
    appState,
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  }),
});

export const actionSetEchoStatus = register<EchoStatus>({
  name: "setEchoStatus",
  label: "labels.echo.status.label",
  trackEvent: false,
  perform: (elements, appState, status, app) => {
    const source = app.scene
      .getSelectedElements(appState)
      .find((e) => getEchoData(e));
    const echo = source && getEchoData(source);
    return source && echo && status !== undefined
      ? {
          elements: setEchoStatus(elements, echo.anchorId, status, source.id),
          appState,
          captureUpdate: CaptureUpdateAction.IMMEDIATELY,
        }
      : false;
  },
});

export const actionDuplicateEchoIndependent = register({
  name: "duplicateEchoIndependent",
  label: "labels.echo.duplicateIndependent",
  trackEvent: false,
  perform: (elements, appState, _v, app) => {
    const selected = getSelectedElements(elements, appState, {
      includeBoundTextElement: true,
      includeElementsInFrames: true,
    });
    if (!selected.length) {
      return false;
    }
    const { duplicatedElements, elementsWithDuplicates } = duplicateElements({
      type: "in-place",
      elements,
      idsOfElementsToDuplicate: arrayToMap(selected),
      appState,
      randomizeSeed: true,
      overrides: ({ duplicateElement }) => ({
        customData: clearEchoData(duplicateElement).customData,
      }),
    });
    return {
      elements: elementsWithDuplicates,
      appState: {
        ...appState,
        ...getSelectionStateForElements(
          duplicatedElements,
          elementsWithDuplicates.filter((e) => !e.isDeleted),
          appState,
        ),
      },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
});
