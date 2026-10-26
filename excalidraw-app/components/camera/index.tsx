import { ExtraToolsMenuItem } from "@excalidraw/excalidraw/index";
import { cameraIcon } from "@excalidraw/excalidraw/components/icons";
import { t } from "@excalidraw/excalidraw/i18n";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { CameraCaptureDialog } from "./CameraCaptureDialog";
import {
  closeCameraCapture,
  openCameraCapture,
  useCameraCaptureOpen,
} from "./cameraState";

// ADR 0035 §5: the camera lives in the toolbar's "More tools" menu, not in the
// AI Workbench; captures land on the canvas and the creator picks them later.

/** render as a child of `<Excalidraw>`; hidden where the camera isn't granted */
export const CameraCaptureMenuItem = ({ disabled }: { disabled: boolean }) => {
  if (disabled) {
    return null;
  }
  return (
    <ExtraToolsMenuItem
      icon={cameraIcon}
      onSelect={openCameraCapture}
      data-testid="toolbar-camera"
    >
      {t("camera.menuItem")}
    </ExtraToolsMenuItem>
  );
};

export const CameraCaptureHost = ({
  excalidrawAPI,
  disabled,
  videoBlockedReason,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  disabled: boolean;
  videoBlockedReason: string | null;
}) => {
  const open = useCameraCaptureOpen();
  if (!open || disabled || !excalidrawAPI) {
    return null;
  }
  return (
    <CameraCaptureDialog
      excalidrawAPI={excalidrawAPI}
      videoBlockedReason={videoBlockedReason}
      onClose={closeCameraCapture}
    />
  );
};
