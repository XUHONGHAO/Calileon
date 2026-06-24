import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EmbedListDialog } from "./EmbedListDialog";

const backendMock = vi.hoisted((): { backend: any } => ({
  backend: null,
}));

vi.mock("../data/cloud", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../data/cloud")>()),
  getCloudBackend: () => backendMock.backend,
}));

vi.mock("@excalidraw/excalidraw/components/Dialog", () => ({
  Dialog: ({
    children,
    title,
  }: {
    children: React.ReactNode;
    title: React.ReactNode;
  }) => (
    <div role="dialog" aria-label={typeof title === "string" ? title : ""}>
      {children}
    </div>
  ),
}));

vi.mock("@excalidraw/excalidraw/i18n", () => ({
  t: (key: string, replacement?: Record<string, string | number>) => {
    const values: Record<string, string> = {
      "buttons.close": "Close",
      "cloud.embed.allowedOrigins": "Allowed origins",
      "cloud.embed.copyFailed": "Could not copy.",
      "cloud.embed.copyIframe": "Copy iframe",
      "cloud.embed.copySnippet": "Copy JS",
      "cloud.embed.create": "Create embed",
      "cloud.embed.creating": "Creating...",
      "cloud.embed.description": `Manage embeds for ${replacement?.title}.`,
      "cloud.embed.empty": "No embeds yet.",
      "cloud.embed.genericError": "Cloud embeds are unavailable.",
      "cloud.embed.loading": "Loading...",
      "cloud.embed.meta": `${replacement?.theme} / ${replacement?.size}`,
      "cloud.embed.mode": "Mode",
      "cloud.embed.modeCollab": "Collab",
      "cloud.embed.modeRead": "Read-only",
      "cloud.embed.modeWrite": "Writable",
      "cloud.embed.originRequired": "Add an origin.",
      "cloud.embed.revoke": "Revoke",
      "cloud.embed.revoked": "Revoked",
      "cloud.embed.revokeConfirm": "Revoke this embed token?",
      "cloud.embed.size": "Size",
      "cloud.embed.sizeCompact": "Compact",
      "cloud.embed.sizeResponsive": "Responsive",
      "cloud.embed.sizeWide": "Wide",
      "cloud.embed.theme": "Theme",
      "cloud.embed.themeDark": "Dark",
      "cloud.embed.themeLight": "Light",
      "cloud.embed.themeSystem": "System",
      "cloud.embed.title": "Embeds",
      "cloud.embed.unavailable": "Cloud embeds are not configured.",
      "cloud.scenes.back": "Back",
      "cloud.scenes.refresh": "Refresh",
    };
    return values[key] ?? key;
  },
}));

const scene = {
  id: "scene-1",
  title: "Roadmap",
  version: 2,
  updatedAt: 0,
};

const embed = {
  id: "embed-1",
  ownerId: "owner-1",
  sceneId: "scene-1",
  mode: "read",
  token: "token-1",
  allowedOrigins: ["http://127.0.0.1:4313"],
  theme: "system",
  size: "responsive",
  revoked: false,
  createdAt: 0,
  updatedAt: 0,
};

const makeBackend = () => ({
  capabilities: { embed: true },
  embed: {
    listByScene: vi.fn(async () => [embed]),
    create: vi.fn(async () => embed),
    revoke: vi.fn(async () => {}),
  },
});

describe("EmbedListDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, "", "http://localhost:3000/");
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async () => {}),
      },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("loads embeds and creates normalized origin entries", async () => {
    const backend = makeBackend();
    backendMock.backend = backend;

    render(<EmbedListDialog open={true} scene={scene} onClose={() => {}} />);

    expect(await screen.findByText("Read-only")).toBeInTheDocument();
    const textarea = screen.getByLabelText("Allowed origins");
    fireEvent.change(textarea, {
      target: { value: "http://127.0.0.1:4313/host.html" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create embed" }));

    await waitFor(() => {
      expect(backend.embed.create).toHaveBeenCalledWith({
        sceneId: "scene-1",
        mode: "read",
        allowedOrigins: ["http://127.0.0.1:4313"],
        theme: "system",
        size: "responsive",
      });
    });
  });

  it("copies iframe and JS snippets and revokes embeds", async () => {
    const backend = makeBackend();
    backendMock.backend = backend;

    render(<EmbedListDialog open={true} scene={scene} onClose={() => {}} />);

    await screen.findByText("Read-only");
    fireEvent.click(screen.getByRole("button", { name: "Copy iframe" }));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining("#embed=token-1"),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Copy JS" }));
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining("excalidraw-embed"),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => {
      expect(backend.embed.revoke).toHaveBeenCalledWith("embed-1");
    });
  });
});
