import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { vi } from "vitest";

import { AITaskListDialog } from "./AITaskListDialog";

import type { AITaskRecord, SceneRecord } from "../data/cloud";

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
      "buttons.close": "Close",
      "cloud.aiTasks.delete": "Delete",
      "cloud.aiTasks.deleteConfirm": "Delete this AI task record?",
      "cloud.aiTasks.description": "Review recent AI generation tasks.",
      "cloud.aiTasks.empty": "No cloud AI tasks yet.",
      "cloud.aiTasks.genericError": "Cloud AI tasks are unavailable.",
      "cloud.aiTasks.loading": "Loading cloud AI tasks...",
      "cloud.aiTasks.openScene": "Open whiteboard",
      "cloud.aiTasks.statusCancelled": "Canceled",
      "cloud.aiTasks.statusFailed": "Failed",
      "cloud.aiTasks.statusQueued": "Queued",
      "cloud.aiTasks.statusRunning": "Running",
      "cloud.aiTasks.statusSucceeded": "Succeeded",
      "cloud.aiTasks.title": "Cloud AI tasks",
      "cloud.aiTasks.unavailable": "Cloud AI tasks are not configured.",
      "cloud.aiTasks.untitled": "Untitled AI task",
      "cloud.aiTasks.updatedAt": `Updated ${replacement?.date}`,
      "cloud.scenes.back": "Back",
      "cloud.scenes.openFailed": "Could not open.",
      "cloud.scenes.refresh": "Refresh",
      "cloud.scenes.unknownUpdatedAt": "unknown time",
    };
    return values[key] ?? key;
  },
}));

const task: AITaskRecord = {
  id: "task-1",
  ownerId: "owner-1",
  sceneId: "scene-1",
  featureSource: "workbench",
  mediaType: "image",
  mode: "text-to-image",
  status: "succeeded",
  modelId: "model-1",
  modelLabel: "Model",
  providerLabel: "Provider",
  promptSummary: "Draw a whiteboard",
  negativePromptSummary: null,
  params: {},
  inputAssetIds: [],
  outputAssetIds: ["asset-1"],
  sourceElementIds: [],
  insertedElementIds: ["element-1"],
  errorCode: null,
  errorMessage: null,
  submittedAt: 1,
  completedAt: 2,
  createdAt: 1,
  updatedAt: 2,
  deletedAt: null,
};

const scene: SceneRecord = {
  id: "scene-1",
  ownerId: "owner-1",
  title: "Board",
  payloadKind: "plain",
  payload: { elements: [], appState: {} },
  version: 1,
  createdAt: 1,
  updatedAt: 2,
  deletedAt: null,
};

const makeBackend = () => ({
  capabilities: { aiTasks: true },
  aiTasks: {
    list: vi.fn(async () => [task]),
    remove: vi.fn(async () => {}),
  },
  assets: {
    getUrl: vi.fn(async () => "https://signed.example/asset.png"),
  },
  scenes: {
    load: vi.fn(async () => scene),
  },
});

const renderDialog = (
  overrides: Partial<React.ComponentProps<typeof AITaskListDialog>> = {},
) => {
  const props: React.ComponentProps<typeof AITaskListDialog> = {
    open: true,
    onClose: vi.fn(),
    onOpenScene: vi.fn(),
    ...overrides,
  };
  render(<AITaskListDialog {...props} />);
  return props;
};

describe("AITaskListDialog", () => {
  beforeEach(() => {
    backendMock.backend = makeBackend();
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads and renders recent AI tasks", async () => {
    renderDialog();

    expect(await screen.findByText("Draw a whiteboard")).toBeInTheDocument();
    expect(backendMock.backend.aiTasks.list).toHaveBeenCalledWith({
      limit: 50,
    });
    expect(backendMock.backend.assets.getUrl).toHaveBeenCalledWith("asset-1");
  });

  it("opens the task's cloud whiteboard", async () => {
    const onOpenScene = vi.fn();
    const onClose = vi.fn();
    renderDialog({ onOpenScene, onClose });

    fireEvent.click(
      await screen.findByRole("button", { name: "Open whiteboard" }),
    );

    await waitFor(() => {
      expect(backendMock.backend.scenes.load).toHaveBeenCalledWith("scene-1");
    });
    expect(onOpenScene).toHaveBeenCalledWith(scene);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("soft-deletes task records and refreshes the list", async () => {
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(backendMock.backend.aiTasks.remove).toHaveBeenCalledWith("task-1");
    });
    expect(window.confirm).toHaveBeenCalledWith("Delete this AI task record?");
    expect(backendMock.backend.aiTasks.list).toHaveBeenCalledTimes(2);
  });
});
