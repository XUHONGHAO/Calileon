import { CODES, KEYS } from "@excalidraw/common";
import { CaptureUpdateAction, getSelectedElements } from "@excalidraw/element";

import { register } from "./register";

export const actionAddSelectionToAIReference = register({
  name: "addSelectionToAIReference",
  label: "labels.addSelectionToAIReference",
  keywords: ["ai", "reference", "image"],
  trackEvent: false,
  // Only offered when the host app registered an AI reference handler.
  predicate: (elements, appState) => {
    return (
      !appState.viewModeEnabled &&
      !!window.EXCALIDRAW_APP_AI_HANDLERS?.addSelectionAsReference &&
      getSelectedElements(elements, appState).length > 0
    );
  },
  keyTest: (event, appState, elements) => {
    return (
      !appState.viewModeEnabled &&
      !!window.EXCALIDRAW_APP_AI_HANDLERS?.addSelectionAsReference &&
      event[KEYS.CTRL_OR_CMD] &&
      event.shiftKey &&
      event.code === CODES.R &&
      getSelectedElements(elements, appState).length > 0
    );
  },
  perform: () => {
    window.EXCALIDRAW_APP_AI_HANDLERS?.addSelectionAsReference?.();

    return {
      captureUpdate: CaptureUpdateAction.NEVER,
    };
  },
});
