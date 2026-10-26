import { useTunnels } from "../context/tunnels";

import DropdownMenu from "./dropdownMenu/DropdownMenu";

import type { JSX, ReactNode } from "react";

/**
 * A host-provided item in the toolbar's "More tools" menu (desktop and
 * mobile). Render it as a child of `<Excalidraw>`. The menu unmounts when it
 * closes, so keep any state the item opens (e.g. a dialog) outside of it.
 */
export const ExtraToolsMenuItem = ({
  children,
  icon,
  onSelect,
  badge,
  "data-testid": testId,
}: {
  children: ReactNode;
  icon?: JSX.Element;
  onSelect: () => void;
  badge?: ReactNode;
  "data-testid"?: string;
}) => {
  const { ExtraToolsMenuTunnel } = useTunnels();

  return (
    <ExtraToolsMenuTunnel.In>
      <DropdownMenu.Item
        onSelect={onSelect}
        icon={icon}
        badge={badge}
        data-testid={testId}
      >
        {children}
      </DropdownMenu.Item>
    </ExtraToolsMenuTunnel.In>
  );
};
ExtraToolsMenuItem.displayName = "ExtraToolsMenuItem";
