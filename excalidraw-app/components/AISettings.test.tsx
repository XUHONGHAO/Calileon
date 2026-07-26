import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { STORAGE_KEYS } from "../app_constants";

import { AISettings } from "./AISettings";

describe("AISettings", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("switches between the model, agent, template, and network settings surfaces", () => {
    render(<AISettings />);

    const modelsTab = screen.getByRole("tab", { name: "Models" });
    const agentsTab = screen.getByRole("tab", { name: "AI Agent" });
    const templatesTab = screen.getByRole("tab", {
      name: "Prompt Templates",
    });
    const networkTab = screen.getByRole("tab", { name: "Network" });

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

    fireEvent.click(networkTab);

    expect(networkTab).toHaveAttribute("aria-selected", "true");
    expect(
      screen.getByRole("radio", { name: /Browser direct \(default\)/ }),
    ).toBeChecked();
    expect(
      screen.getByRole("button", { name: "Test proxy connection" }),
    ).toBeDisabled();

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

  it("saves proxy settings in the independent local storage entry", () => {
    render(<AISettings initialTab="network" />);

    fireEvent.click(screen.getByRole("radio", { name: /^Backend proxy/ }));
    fireEvent.change(screen.getByLabelText(/Proxy endpoint/), {
      target: { value: "https://proxy.example.com/ai-proxy/v1/forward" },
    });
    fireEvent.change(screen.getByLabelText(/Proxy access token/), {
      target: { value: "proxy-token" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save network settings" }),
    );

    expect(
      JSON.parse(
        localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_AI_PROXY) || "{}",
      ),
    ).toEqual({
      version: 1,
      enabled: true,
      endpoint: "https://proxy.example.com/ai-proxy/v1/forward",
      accessToken: "proxy-token",
    });
    expect(screen.getByText("Network settings saved.")).toBeInTheDocument();
  });

  it("tests only the protected proxy readiness endpoint", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "ready" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<AISettings initialTab="network" />);

    fireEvent.click(screen.getByRole("radio", { name: /^Backend proxy/ }));
    fireEvent.change(screen.getByLabelText(/Proxy access token/), {
      target: { value: "proxy-token" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Test proxy connection" }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(endpoint).toBe("/ai-proxy/readyz");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("X-Excalidraw-AI-Proxy-Token")).toBe(
      "proxy-token",
    );
    expect(
      screen.getByText(
        "Proxy is reachable and accepted the configured access policy.",
      ),
    ).toBeInTheDocument();
  });

  it("restores direct mode and removes the persisted proxy config", () => {
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_AI_PROXY,
      JSON.stringify({
        version: 1,
        enabled: true,
        endpoint: "/custom-proxy/v1/forward",
        accessToken: "proxy-token",
      }),
    );
    render(<AISettings initialTab="network" />);

    expect(screen.getByRole("radio", { name: /^Backend proxy/ })).toBeChecked();
    fireEvent.click(
      screen.getByRole("button", { name: "Restore network defaults" }),
    );

    expect(
      screen.getByRole("radio", { name: /Browser direct \(default\)/ }),
    ).toBeChecked();
    expect(screen.getByLabelText(/Proxy endpoint/)).toHaveValue("");
    expect(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_AI_PROXY),
    ).toBeNull();
  });
});
