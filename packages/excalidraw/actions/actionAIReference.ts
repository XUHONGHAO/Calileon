import { CODES, KEYS } from "@excalidraw/common";
import { CaptureUpdateAction, getSelectedElements } from "@excalidraw/element";

import { register } from "./register";

const AI_REFERENCE_ADD_SELECTION_EVENT =
  "excalidraw:add-selection-to-ai-reference";

export const actionAddSelectionToAIReference = register({
  name: "addSelectionToAIReference",
  label: "labels.addSelectionToAIReference",
  keywords: ["ai", "reference", "image"],
  trackEvent: false,
  predicate: (elements, appState) => {
    return (
      !appState.viewModeEnabled &&
      getSelectedElements(elements, appState).length > 0
    );
  },
  keyTest: (event, appState, elements) => {
    return (
      !appState.viewModeEnabled &&
      event[KEYS.CTRL_OR_CMD] &&
      event.shiftKey &&
      event.code === CODES.R &&
      getSelectedElements(elements, appState).length > 0
    );
  },
  perform: () => {
    window.dispatchEvent(new Event(AI_REFERENCE_ADD_SELECTION_EVENT));

    return {
      captureUpdate: CaptureUpdateAction.NEVER,
    };
  },
});
