import { CaptureUpdateAction, isAudioElement } from "@excalidraw/element";

import type { ExcalidrawAudioElement } from "@excalidraw/element/types";

import { ToolButton } from "../components/ToolButton";
import { UnlinkIcon } from "../components/icons";
import { t } from "../i18n";

import { register } from "./register";

import type { AppClassProperties, AppState } from "../types";

const getAttachedSelection = (
  appState: Pick<AppState, "selectedElementIds">,
  app: AppClassProperties,
) =>
  app.scene
    .getSelectedElements(appState)
    .filter(
      (element): element is ExcalidrawAudioElement =>
        isAudioElement(element) && !!element.hostId,
    );

/** turns attached voice notes back into free bubbles (ADR 0034 R5) */
export const actionDetachAudio = register({
  name: "detachAudio",
  label: "voice.host.detach",
  icon: UnlinkIcon,
  trackEvent: { category: "element" },
  predicate: (elements, appState, _, app) =>
    !appState.viewModeEnabled && getAttachedSelection(appState, app).length > 0,
  perform: (elements, appState, _, app) => {
    const detachIds = new Set(
      getAttachedSelection(appState, app).map((element) => element.id),
    );
    if (!detachIds.size) {
      return false;
    }
    for (const element of elements) {
      if (detachIds.has(element.id) && isAudioElement(element)) {
        app.scene.mutateElement(element, { hostId: null });
      }
    }
    return {
      elements: app.scene.getElementsIncludingDeleted(),
      appState,
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    };
  },
  PanelComponent: ({ appState, updateData, app }) => (
    <ToolButton
      type="button"
      icon={UnlinkIcon}
      hidden={getAttachedSelection(appState, app).length === 0}
      onClick={() => updateData(null)}
      title={t("voice.host.detach")}
      aria-label={t("voice.host.detach")}
      data-testid="detach-audio"
    />
  ),
});
