import { act, render, screen } from "@testing-library/react";
import React from "react";

import {
  closeLabsFeature,
  isLabsFeatureOpen,
  openLabsFeature,
  useLabsFeatureOpen,
} from "./labsDialogs";

const Probe = () => {
  const open = useLabsFeatureOpen("rorschach");
  return <div data-testid="probe">{open ? "open" : "closed"}</div>;
};

describe("labsDialogs", () => {
  afterEach(() => {
    closeLabsFeature("rorschach");
    closeLabsFeature("shelfLife");
  });

  it("tracks each feature independently", () => {
    openLabsFeature("rorschach");
    expect(isLabsFeatureOpen("rorschach")).toBe(true);
    expect(isLabsFeatureOpen("shelfLife")).toBe(false);
  });

  it("re-renders subscribers on open and close", () => {
    render(<Probe />);
    expect(screen.getByTestId("probe").textContent).toBe("closed");
    act(() => openLabsFeature("rorschach"));
    expect(screen.getByTestId("probe").textContent).toBe("open");
    act(() => closeLabsFeature("rorschach"));
    expect(screen.getByTestId("probe").textContent).toBe("closed");
  });
});
