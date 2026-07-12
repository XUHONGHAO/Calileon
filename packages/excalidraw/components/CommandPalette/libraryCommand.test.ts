import { DEFAULT_SIDEBAR } from "@excalidraw/common";

import { getLibraryCommandOpenSidebar } from "./libraryCommand";

describe("getLibraryCommandOpenSidebar", () => {
  it("opens the Library when no sidebar is open", () => {
    expect(getLibraryCommandOpenSidebar(null)).toEqual({
      name: DEFAULT_SIDEBAR.name,
      tab: DEFAULT_SIDEBAR.defaultTab,
    });
  });

  it("closes the sidebar when the Library is already open", () => {
    expect(
      getLibraryCommandOpenSidebar({
        name: DEFAULT_SIDEBAR.name,
        tab: DEFAULT_SIDEBAR.defaultTab,
      }),
    ).toBeNull();
  });

  it.each([
    ["another default sidebar tab", { name: DEFAULT_SIDEBAR.name, tab: "ai" }],
    ["the search tab", { name: DEFAULT_SIDEBAR.name, tab: "search" }],
    ["a custom sidebar", { name: "custom", tab: "details" }],
  ])("switches %s to the Library", (_description, openSidebar) => {
    expect(getLibraryCommandOpenSidebar(openSidebar)).toEqual({
      name: DEFAULT_SIDEBAR.name,
      tab: DEFAULT_SIDEBAR.defaultTab,
    });
  });
});
