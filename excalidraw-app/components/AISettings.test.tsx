import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";

import { AISettings } from "./AISettings";

describe("AISettings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("opens on the requested templates tab", () => {
    render(<AISettings initialTab="templates" />);

    expect(screen.getByRole("tab", { name: "Models" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(
      screen.getByRole("tab", { name: "Prompt Templates" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Built-in Templates")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add model" }),
    ).not.toBeInTheDocument();
  });

  it("switches between the model, agent, and template settings surfaces", () => {
    render(<AISettings />);

    const modelsTab = screen.getByRole("tab", { name: "Models" });
    const agentsTab = screen.getByRole("tab", { name: "AI Agent" });
    const templatesTab = screen.getByRole("tab", {
      name: "Prompt Templates",
    });

    expect(modelsTab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("tablist", { name: "AI models" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add model" }),
    ).toBeInTheDocument();

    fireEvent.click(agentsTab);

    expect(agentsTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Base Agent Configuration")).toBeInTheDocument();
    expect(screen.getByText("General Agents")).toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: "Custom Agents" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Use default Text Agent for vision tasks"),
    ).not.toBeInTheDocument();

    fireEvent.click(templatesTab);

    expect(templatesTab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("button", { name: "Add template" }),
    ).toBeInTheDocument();

    fireEvent.click(modelsTab);

    expect(modelsTab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("tablist", { name: "AI models" }),
    ).toBeInTheDocument();
  });

  it("offers direct next actions from empty model and template states", () => {
    render(<AISettings />);

    fireEvent.click(screen.getByRole("button", { name: "Add image model" }));
    expect(
      screen.getByRole("heading", { name: "New model" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    fireEvent.click(screen.getByRole("tab", { name: "Prompt Templates" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Add custom template" }),
    );

    expect(
      screen.getByRole("heading", { name: "New template" }),
    ).toBeInTheDocument();
  });
});
