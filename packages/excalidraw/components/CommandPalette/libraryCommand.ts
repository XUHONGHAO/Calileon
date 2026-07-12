import { DEFAULT_SIDEBAR } from "@excalidraw/common";

import type { UIAppState } from "../../types";

export const getLibraryCommandOpenSidebar = (
  openSidebar: UIAppState["openSidebar"],
): UIAppState["openSidebar"] => {
  const isLibraryOpen =
    openSidebar?.name === DEFAULT_SIDEBAR.name &&
    openSidebar.tab === DEFAULT_SIDEBAR.defaultTab;

  return isLibraryOpen
    ? null
    : {
        name: DEFAULT_SIDEBAR.name,
        tab: DEFAULT_SIDEBAR.defaultTab,
      };
};
