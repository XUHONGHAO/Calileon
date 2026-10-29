import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { AI_PROMPT_TEMPLATES_STORAGE_KEY } from "../ai/promptTemplates";
import { saveAIProxyConfig } from "../ai/proxyConfig";
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

  it("links tabs to their panels and keeps secondary row actions in a menu", () => {
    localStorage.setItem(
      AI_PROMPT_TEMPLATES_STORAGE_KEY,
      JSON.stringify([
        {
          id: "custom-1",
          label: "My template",
          template: "Draw #1",
          modes: ["text-to-image"],
          isBuiltIn: false,
        },
      ]),
    );
    render(<AISettings initialTab="templates" />);

    const templatesTab = screen.getByRole("tab", { name: "Prompt Templates" });
    const panel = screen.getByRole("tabpanel", { name: "Prompt Templates" });
    expect(templatesTab).toHaveAttribute("aria-controls", panel.id);

    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Delete" }),
    ).not.toBeInTheDocument();
    const menus = screen.getAllByRole("button", { name: "More actions" });
    fireEvent.click(menus[menus.length - 1]);
    expect(
      screen.getByRole("menuitem", { name: "Delete" }),
    ).toBeInTheDocument();
  });

  it("asks before deleting a model and keeps it when cancelled", async () => {
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_AI_IMAGE,
      JSON.stringify({
        defaultModel: "m1",
        models: [
          {
            id: "m1",
            siteName: "Test provider",
            baseURL: "https://example.test/v1",
            apiKey: "test-key",
            model: "test-model",
            label: "Test model",
            mediaType: "image",
            capabilities: ["text-to-image"],
            requestTimeoutSeconds: 600,
          },
        ],
      }),
    );
    // No ConfirmHost here, so confirmAction falls back to window.confirm.
    const confirm = vi.fn((_message?: string) => false);
    vi.stubGlobal("confirm", confirm);
    const storedModels = () =>
      JSON.parse(
        localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_AI_IMAGE) || "{}",
      ).models?.length;
    render(<AISettings />);

    const deleteFromMenu = () => {
      fireEvent.click(screen.getByRole("button", { name: "More actions" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    };

    deleteFromMenu();
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0]).toEqual([
      'Delete "Test provider" (test-model)? This can\'t be undone.',
    ]);
    expect(storedModels()).toBe(1);

    confirm.mockReturnValue(true);
    deleteFromMenu();
    await waitFor(() => expect(storedModels()).toBe(0));
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
      version: 2,
      mode: "byok-proxy",
      endpoint: "https://proxy.example.com/ai-proxy/v1/forward",
      accessToken: "proxy-token",
      gatewayEndpoint: "",
      managedRoutes: {},
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

  it("restores direct mode and removes the persisted proxy config", async () => {
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_AI_PROXY,
      JSON.stringify({
        version: 1,
        enabled: true,
        endpoint: "/custom-proxy/v1/forward",
        accessToken: "proxy-token",
      }),
    );
    const confirm = vi.fn((_message?: string) => false);
    vi.stubGlobal("confirm", confirm);
    render(<AISettings initialTab="network" />);

    expect(screen.getByRole("radio", { name: /^Backend proxy/ })).toBeChecked();
    fireEvent.click(
      screen.getByRole("button", { name: "Restore network defaults" }),
    );

    // Cancelled: nothing is removed.
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0][0]).toMatch(/access token/);
    expect(screen.getByRole("radio", { name: /^Backend proxy/ })).toBeChecked();
    expect(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_AI_PROXY),
    ).not.toBeNull();

    confirm.mockReturnValue(true);
    fireEvent.click(
      screen.getByRole("button", { name: "Restore network defaults" }),
    );

    expect(
      await screen.findByRole("radio", { name: /Browser direct \(default\)/ }),
    ).toBeChecked();
    expect(screen.queryByLabelText(/Proxy endpoint/)).not.toBeInTheDocument();
    expect(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_AI_PROXY),
    ).toBeNull();
  });

  it("reports unsaved editor changes and confirms before Back discards them", async () => {
    const onDirtyChange = vi.fn();
    const confirm = vi.fn((_message?: string) => false);
    vi.stubGlobal("confirm", confirm);
    render(<AISettings onDirtyChange={onDirtyChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    // Opening an editor alone is not a change.
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("heading", { name: "New model" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    fireEvent.change(screen.getByLabelText("Site name"), {
      target: { value: "Draft site" },
    });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    // Kept editing: the draft is still there.
    expect(screen.getByLabelText("Site name")).toHaveValue("Draft site");

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "New model" }),
      ).not.toBeInTheDocument(),
    );
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("shows validation errors on the field and focuses it", async () => {
    render(<AISettings />);

    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    fireEvent.click(screen.getByRole("button", { name: "Create model" }));

    const siteName = screen.getByLabelText("Site name");
    expect(siteName).toHaveAttribute("aria-invalid", "true");
    expect(siteName).toHaveAccessibleDescription(/Site name is required\./);
    await waitFor(() => expect(siteName).toHaveFocus());

    fireEvent.change(siteName, { target: { value: "Provider" } });
    expect(siteName).not.toHaveAttribute("aria-invalid");
    fireEvent.click(screen.getByRole("button", { name: "Create model" }));
    const baseURL = screen.getByLabelText("Base URL");
    expect(baseURL).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(baseURL).toHaveFocus());
  });

  it("clears a typed API key when a preset moves the draft to another host", async () => {
    const confirm = vi.fn((_message?: string) => false);
    vi.stubGlobal("confirm", confirm);
    render(<AISettings />);

    fireEvent.click(screen.getByRole("button", { name: "Add model" }));
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://old-provider.example/v1" },
    });
    fireEvent.change(screen.getByLabelText(/API Key/), {
      target: { value: "old-provider-key" },
    });

    const preset = screen.getByRole("button", { name: /pic2api API/ });
    fireEvent.click(preset);
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0][0]).toMatch(/API key/);
    // Cancelled: the draft is untouched.
    expect(screen.getByLabelText("Base URL")).toHaveValue(
      "https://old-provider.example/v1",
    );
    expect(screen.getByLabelText(/API Key/)).toHaveValue("old-provider-key");

    confirm.mockReturnValue(true);
    fireEvent.click(preset);
    await waitFor(() =>
      expect(screen.getByLabelText("Base URL")).toHaveValue(
        "https://www.pic2api.com/v1",
      ),
    );
    expect(screen.getByLabelText(/API Key/)).toHaveValue("");
  });

  it("keeps a same-host API key and asks before overwriting a saved model", async () => {
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_AI_IMAGE,
      JSON.stringify({
        defaultModel: "m1",
        models: [
          {
            id: "m1",
            siteName: "My pic2api",
            baseURL: "https://www.pic2api.com/v1",
            apiKey: "same-host-key",
            model: "custom-model",
            label: "custom-model",
            mediaType: "image",
            capabilities: ["text-to-image"],
            requestTimeoutSeconds: 600,
          },
        ],
      }),
    );
    const confirm = vi.fn((_message?: string) => true);
    vi.stubGlobal("confirm", confirm);
    render(<AISettings />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: /pic2api API/ }));

    // Editing a saved item always asks, even on the same host.
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0][0]).not.toMatch(/cleared/);
    await waitFor(() =>
      expect(screen.getByLabelText("Site name")).toHaveValue("pic2api API"),
    );
    expect(screen.getByLabelText(/API Key/)).toHaveValue("same-host-key");
  });

  it("edits a note per model ID and saves it with each model", async () => {
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_AI_IMAGE,
      JSON.stringify({
        defaultModel: "m1",
        models: ["fast", "pro"].map((model, index) => ({
          id: `m${index + 1}`,
          siteName: "Relay",
          baseURL: "https://relay.example/v1",
          apiKey: "relay-key",
          model,
          label: model,
          mediaType: "image",
          capabilities: ["text-to-image"],
          requestTimeoutSeconds: 600,
          ...(model === "fast" ? { note: "cheap, 1K only" } : {}),
        })),
      }),
    );
    render(<AISettings />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Note for fast")).toHaveValue(
      "cheap, 1K only",
    );
    fireEvent.change(screen.getByLabelText("Note for pro"), {
      target: { value: "  best quality, slow  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save model" }));

    await waitFor(() => {
      const saved = JSON.parse(
        localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_AI_IMAGE) || "{}",
      );
      expect(
        saved.models.map((model: any) => [model.model, model.note]),
      ).toEqual([
        ["fast", "cheap, 1K only"],
        ["pro", "best quality, slow"],
      ]);
    });
  });

  it("keeps an edited network draft when another surface saves proxy settings", () => {
    render(<AISettings initialTab="network" />);

    fireEvent.click(screen.getByRole("radio", { name: /^Backend proxy/ }));
    fireEvent.change(screen.getByLabelText(/Proxy endpoint/), {
      target: { value: "https://draft.example.com/ai-proxy/v1/forward" },
    });
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();

    act(() => {
      saveAIProxyConfig({ mode: "direct", accessToken: "elsewhere" });
    });

    expect(screen.getByLabelText(/Proxy endpoint/)).toHaveValue(
      "https://draft.example.com/ai-proxy/v1/forward",
    );
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  });

  it("follows outside proxy updates while the network draft is untouched", () => {
    render(<AISettings initialTab="network" />);
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();

    act(() => {
      saveAIProxyConfig({
        mode: "byok-proxy",
        endpoint: "https://outside.example.com/ai-proxy/v1/forward",
      });
    });

    expect(screen.getByRole("radio", { name: /^Backend proxy/ })).toBeChecked();
    expect(screen.getByLabelText(/Proxy endpoint/)).toHaveValue(
      "https://outside.example.com/ai-proxy/v1/forward",
    );
    expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument();
  });

  it("puts an invalid proxy endpoint error on the field", async () => {
    render(<AISettings initialTab="network" />);

    fireEvent.click(screen.getByRole("radio", { name: /^Backend proxy/ }));
    const endpoint = screen.getByLabelText(/Proxy endpoint/);
    fireEvent.change(endpoint, { target: { value: "//evil.example" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Save network settings" }),
    );

    expect(endpoint).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(endpoint).toHaveFocus());
    expect(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_AI_PROXY),
    ).toBeNull();
  });
});
