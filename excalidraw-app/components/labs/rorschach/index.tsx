import { MainMenu } from "@excalidraw/excalidraw/index";
import { t } from "@excalidraw/excalidraw/i18n";

import {
  closeLabsFeature,
  openLabsFeature,
  useLabsFeatureOpen,
} from "../labsDialogs";

import { RorschachDialog } from "./RorschachDialog";
import { RorschachIcon } from "./icons";

import type { LabsHostProps, LabsMenuItemProps } from "../types";

// G6 Rorschach Mirror. Rules and design:
// 开发文档/excalidraw/01-requirements/canvas-experiments/parallel-wave-1/G6-rorschach-brief.md
// Sends image data off-device, so it disappears entirely in Vault mode.

/**
 * The menu item itself never reads mutable app state: it only flips the store,
 * because it unmounts as soon as the menu closes.
 */
export const RorschachMenuItem = ({
  externalFeaturesDisabled,
}: LabsMenuItemProps) => {
  if (externalFeaturesDisabled) {
    return null;
  }

  return (
    <MainMenu.Item
      icon={RorschachIcon}
      aria-label={t("labs.rorschach.menuLabel")}
      data-testid="labs-rorschach-menu-item"
      onSelect={() => openLabsFeature("rorschach")}
    >
      {t("labs.rorschach.title")}
    </MainMenu.Item>
  );
};

export const RorschachHost = ({
  excalidrawAPI,
  externalFeaturesDisabled,
}: LabsHostProps) => {
  const open = useLabsFeatureOpen("rorschach");

  if (!open || externalFeaturesDisabled) {
    return null;
  }

  return (
    <RorschachDialog
      open={open}
      excalidrawAPI={excalidrawAPI}
      externalFeaturesDisabled={externalFeaturesDisabled}
      onClose={() => closeLabsFeature("rorschach")}
    />
  );
};
