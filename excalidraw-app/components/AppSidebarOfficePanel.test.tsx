import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";

import { AppSidebarOfficePanel } from "./AppSidebarOfficePanel";

vi.mock("@excalidraw/excalidraw/context/ui-appState", () => ({
  useUIAppState: () => ({
    theme: "light",
  }),
}));

describe("AppSidebarOfficePanel", () => {
  it("exposes comments office workflow actions", () => {
    const onOpenCollaboration = vi.fn();
    const onOpenCreate = vi.fn();
    const onOpenShare = vi.fn();

    render(
      <AppSidebarOfficePanel
        kind="comments"
        onOpenCollaboration={onOpenCollaboration}
        onOpenCreate={onOpenCreate}
        onOpenShare={onOpenShare}
        plusBaseURL="https://plus.example.test"
      />,
    );

    expect(screen.getByText("Team review")).toBeInTheDocument();
    expect(
      screen.getByRole("list", { name: "Office workflow" }),
    ).toHaveTextContent("ReviewShareExport");

    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(onOpenShare).toHaveBeenCalledTimes(1);
    expect(onOpenCollaboration).toHaveBeenCalledTimes(1);
    expect(onOpenCreate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Sign up now" })).toHaveAttribute(
      "href",
      "https://plus.example.test/plus?utm_source=excalidraw&utm_medium=app&utm_content=comments_promo#excalidraw-redirect",
    );
  });

  it("renders presentation handoff state", () => {
    render(
      <AppSidebarOfficePanel
        kind="presentation"
        onOpenCollaboration={vi.fn()}
        onOpenCreate={vi.fn()}
        onOpenShare={vi.fn()}
        plusBaseURL="https://plus.example.test"
      />,
    );

    expect(screen.getByText("Presentation handoff")).toBeInTheDocument();
    expect(screen.getByText("Present")).toHaveClass("is-active");
    expect(
      screen.getByText("Create presentations with Excalidraw+"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign up now" })).toHaveAttribute(
      "href",
      "https://plus.example.test/plus?utm_source=excalidraw&utm_medium=app&utm_content=presentations_promo#excalidraw-redirect",
    );
  });
});
