import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeLabsFeature,
  isLabsFeatureOpen,
  openLabsFeature,
} from "../labsDialogs";

import { RorschachHost, RorschachMenuItem } from ".";

vi.mock("@excalidraw/excalidraw/index", () => ({
  MainMenu: {
    Item: ({
      children,
      onSelect,
      ...rest
    }: React.HTMLAttributes<HTMLDivElement> & {
      onSelect?: () => void;
      "data-testid"?: string;
    }) => (
      <div role="button" onClick={onSelect} {...rest}>
        {children}
      </div>
    ),
  },
}));

vi.mock("./RorschachDialog", () => ({
  RorschachDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="rorschach-dialog" /> : null,
}));

const api = {} as any;

describe("Rorschach labs wiring", () => {
  beforeEach(() => {
    closeLabsFeature("rorschach");
  });

  it("hides the menu entry in Vault mode", () => {
    const { container } = render(
      <RorschachMenuItem externalFeaturesDisabled />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("opens the feature through the labs store", () => {
    render(<RorschachMenuItem externalFeaturesDisabled={false} />);
    const item = screen.getByTestId("labs-rorschach-menu-item");
    expect(item.getAttribute("aria-label")).toBeTruthy();
    fireEvent.click(item);
    expect(isLabsFeatureOpen("rorschach")).toBe(true);
  });

  it("mounts the dialog only while open and outside Vault mode", () => {
    const { rerender } = render(
      <RorschachHost excalidrawAPI={api} externalFeaturesDisabled={false} />,
    );
    expect(screen.queryByTestId("rorschach-dialog")).toBeNull();

    act(() => {
      openLabsFeature("rorschach");
    });
    rerender(
      <RorschachHost excalidrawAPI={api} externalFeaturesDisabled={false} />,
    );
    expect(screen.queryByTestId("rorschach-dialog")).toBeTruthy();

    rerender(<RorschachHost excalidrawAPI={api} externalFeaturesDisabled />);
    expect(screen.queryByTestId("rorschach-dialog")).toBeNull();
  });
});
