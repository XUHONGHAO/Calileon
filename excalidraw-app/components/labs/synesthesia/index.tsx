import { MainMenu } from "@excalidraw/excalidraw";
import { t } from "@excalidraw/excalidraw/i18n";

import {
  closeLabsFeature,
  openLabsFeature,
  useLabsFeatureOpen,
} from "../labsDialogs";

import { soundIcon } from "./icons";
import { SynesthesiaDialog } from "./SynesthesiaDialog";

import type { LabsHostProps, LabsMenuItemProps } from "../types";

export const SynesthesiaMenuItem = (_props: LabsMenuItemProps) => (
  <MainMenu.Item
    icon={soundIcon}
    data-testid="labs-synesthesia-menu-item"
    aria-label={t("labs.synesthesia.title")}
    onSelect={() => openLabsFeature("synesthesia")}
  >
    {t("labs.synesthesia.title")}
  </MainMenu.Item>
);
export const SynesthesiaHost = ({ excalidrawAPI }: LabsHostProps) => {
  const open = useLabsFeatureOpen("synesthesia");
  return open && excalidrawAPI ? (
    <SynesthesiaDialog
      api={excalidrawAPI}
      onClose={() => closeLabsFeature("synesthesia")}
    />
  ) : null;
};
