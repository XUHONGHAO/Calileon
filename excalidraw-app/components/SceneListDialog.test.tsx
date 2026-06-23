import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { vi } from "vitest";

import { SceneListDialog } from "./SceneListDialog";

import type { SceneRecord, SceneSummary } from "../data/cloud";

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
    <div role="dialog">
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

vi.mock("@excalidraw/excalidraw/i18n", () => ({
  t: (key: string, replacement?: Record<string, string | number>) => {
    const values: Record<string, string> = {
      "cloud.scenes.back": "Back",
      "cloud.scenes.cancelRename": "Cancel",
      "cloud.scenes.delete": "Delete",
      "cloud.scenes.deleteConfirm": "Delete this cloud whiteboard?",
      "cloud.scenes.description": "Manage cloud whiteboards.",
      "cloud.scenes.empty": "No cloud whiteboards yet.",
      "cloud.scenes.genericError": "Cloud whiteboards are unavailable.",
      "cloud.scenes.loading": "Loading cloud whiteboards...",
      "cloud.scenes.open": "Open",
      "cloud.scenes.refresh": "Refresh",
      "cloud.scenes.rename": "Rename",
      "cloud.scenes.renameTitle": "Whiteboard title",
      "cloud.scenes.saveRename": "Save",
      "cloud.scenes.title": "Cloud whiteboards",
      "cloud.scenes.unavailable": "Cloud whiteboards are not configured.",
      "cloud.scenes.unknownUpdatedAt": "unknown time",
      "cloud.scenes.updatedAt": `Updated ${replacement?.date}`,
    };
    return values[key] ?? key;
  },
}));

const summaries: SceneSummary[] = [
  {
    id: "scene-1",
    title: "Roadmap",
    version: 2,
    updatedAt: Date.UTC(2026, 5, 22, 4, 0, 0),
  },
];

const record: SceneRecord = {
  id: "scene-1",
  ownerId: "u1",
  title: "Roadmap",
  payloadKind: "plain",
  payload: { elements: [], appState: {} },
  version: 2,
  createdAt: Date.UTC(2026, 5, 22, 3, 0, 0),
  updatedAt: Date.UTC(2026, 5, 22, 4, 0, 0),
  deletedAt: null,
};

const makeBackend = () => ({
  capabilities: { sceneStorage: true },
  scenes: {
    list: vi.fn(async () => summaries),
    load: vi.fn(async () => record),
    rename: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
  },
});

const renderDialog = (
  overrides: Partial<React.ComponentProps<typeof SceneListDialog>> = {},
) => {
  const props: React.ComponentProps<typeof SceneListDialog> = {
    open: true,
    onClose: vi.fn(),
    onOpenScene: vi.fn(),
    ...overrides,
  };
  render(<SceneListDialog {...props} />);
  return props;
};

describe("SceneListDialog", () => {
  beforeEach(() => {
    backendMock.backend = makeBackend();
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads and renders cloud scene summaries", async () => {
    renderDialog();

    expect(await screen.findByText("Roadmap")).toBeInTheDocument();
    expect(backendMock.backend.scenes.list).toHaveBeenCalledWith({
      sort: "updatedAt",
    });
  });

  it("loads a selected cloud scene before opening it", async () => {
    const onOpenScene = vi.fn();
    const onClose = vi.fn();
    renderDialog({ onClose, onOpenScene });

    fireEvent.click(await screen.findByRole("button", { name: "Open" }));

    await waitFor(() => {
      expect(backendMock.backend.scenes.load).toHaveBeenCalledWith("scene-1");
    });
    expect(onOpenScene).toHaveBeenCalledWith(record);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls the back handler from the toolbar", async () => {
    const onBack = vi.fn();
    renderDialog({ onBack });

    fireEvent.click(await screen.findByRole("button", { name: "Back" }));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("renames a cloud scene and refreshes the list", async () => {
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Whiteboard title"), {
      target: { value: "Updated Roadmap" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(backendMock.backend.scenes.rename).toHaveBeenCalledWith(
        "scene-1",
        "Updated Roadmap",
      );
    });
    expect(backendMock.backend.scenes.list).toHaveBeenCalledTimes(2);
  });

  it("soft-deletes a confirmed cloud scene and refreshes the list", async () => {
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(backendMock.backend.scenes.remove).toHaveBeenCalledWith("scene-1");
    });
    expect(window.confirm).toHaveBeenCalledWith(
      "Delete this cloud whiteboard?",
    );
    expect(backendMock.backend.scenes.list).toHaveBeenCalledTimes(2);
  });
});
