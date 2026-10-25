import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { beforeEach, describe, expect, it, vi } from "vitest";

import React from "react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  listManyMindsBatches,
  saveManyMindsBatch,
} from "../ai/manyMindsPersistence";
import { generateImagesWithOpenAIAdapter } from "../ai/openAIImageAdapter";

import { createManyMindsBatch } from "../ai/manyMindsTypes";

import { ManyMindsDialog } from "./ManyMindsDialog";
import { chooseSelectOption, getSelectOptionLabels } from "./ui/testing";

import type { ManyMindsBatch } from "../ai/manyMindsTypes";

vi.mock("@excalidraw/excalidraw/components/Dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("../ai/config", () => ({
  loadAIImageConfig: () => ({
    baseURL: "",
    apiKey: "",
    defaultModel: "model-1",
    models: [
      {
        id: "model-card-1",
        siteName: "Test",
        baseURL: "https://example.test/v1",
        apiKey: "local-only-key",
        model: "model-1",
        label: "Model One",
        mediaType: "image",
        capabilities: ["text-to-image", "image-to-image"],
        endpoints: {},
        requestTimeoutSeconds: 60,
      },
    ],
  }),
}));

vi.mock("../ai/manyMindsPersistence", () => ({
  listManyMindsBatches: vi.fn(async () => []),
  loadManyMindsAsset: vi.fn(async () => null),
  saveManyMindsAsset: vi.fn(),
  saveManyMindsBatch: vi.fn(),
  deleteManyMindsAsset: vi.fn(),
}));

vi.mock("../ai/openAIImageAdapter", () => ({
  generateImagesWithOpenAIAdapter: vi.fn(),
}));

const textOnlyAPI = {
  getSceneElements: () => [],
  getAppState: () => ({ selectedElementIds: {} }),
  getFiles: () => ({}),
} as unknown as ExcalidrawImperativeAPI;

describe("ManyMindsDialog", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(listManyMindsBatches).mockReset();
    vi.mocked(listManyMindsBatches).mockResolvedValue([]);
    vi.mocked(saveManyMindsBatch).mockReset();
    vi.mocked(generateImagesWithOpenAIAdapter).mockReset();
  });

  it("defaults to four tasks and exposes all MVP grid sizes", () => {
    render(
      <ManyMindsDialog
        open
        onClose={vi.fn()}
        excalidrawAPI={null}
        persistenceScopeId="local:test"
      />,
    );

    const count = screen.getByLabelText("Views");
    expect(count).toHaveAttribute("data-value", "4");
    expect(getSelectOptionLabels(count)).toEqual(["2", "4", "6", "9"]);
    expect(screen.getAllByLabelText(/Perspective \d/)).toHaveLength(4);

    chooseSelectOption(count, "9");
    expect(screen.getAllByLabelText(/Perspective \d/)).toHaveLength(9);
  });

  it("keeps running tasks alive when the dialog is closed and reopened", async () => {
    // Round-trip the persisted batch so a reopen really finds the running one.
    let saved: ManyMindsBatch | null = null;
    vi.mocked(saveManyMindsBatch).mockImplementation(async (_scope, next) => {
      saved = next;
      return next.id;
    });
    vi.mocked(listManyMindsBatches).mockImplementation(async () =>
      saved ? [saved] : [],
    );
    const signals: AbortSignal[] = [];
    vi.mocked(generateImagesWithOpenAIAdapter).mockImplementation(
      ({ signal }) => {
        signals.push(signal!);
        return new Promise(() => {});
      },
    );
    const excalidrawAPI = {
      getSceneElements: () => [],
      getAppState: () => ({ selectedElementIds: {} }),
      getFiles: () => ({}),
    } as unknown as ExcalidrawImperativeAPI;
    const props = {
      onClose: vi.fn(),
      excalidrawAPI,
      persistenceScopeId: "local:test",
    };
    const { rerender } = render(<ManyMindsDialog open {...props} />);

    chooseSelectOption(screen.getByLabelText("Input"), "Text");
    fireEvent.change(screen.getByLabelText("Request"), {
      target: { value: "A lighthouse" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate 4 views" }));
    await waitFor(() => expect(signals.length).toBeGreaterThan(0));

    rerender(<ManyMindsDialog open={false} {...props} />);
    rerender(<ManyMindsDialog open {...props} />);
    await act(async () => {});

    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    expect(
      screen.queryByText(/Interrupted by page refresh/),
    ).not.toBeInTheDocument();
  });

  it("disables generation without a stable persistence scope", () => {
    render(
      <ManyMindsDialog
        open
        onClose={vi.fn()}
        excalidrawAPI={null}
        persistenceScopeId={null}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Generate 4 views" }),
    ).toBeDisabled();
  });

  it("starts a 9-view batch with a distinct perspective in every slot", async () => {
    vi.mocked(generateImagesWithOpenAIAdapter).mockImplementation(
      () => new Promise(() => {}),
    );
    render(
      <ManyMindsDialog
        open
        onClose={vi.fn()}
        excalidrawAPI={textOnlyAPI}
        persistenceScopeId="local:test"
      />,
    );

    chooseSelectOption(screen.getByLabelText("Views"), "9");
    const slots = screen.getAllByLabelText(/Perspective \d/);
    const values = slots.map((slot) => slot.getAttribute("data-value"));
    expect(values.every(Boolean)).toBe(true);
    expect(new Set(values).size).toBe(9);

    chooseSelectOption(screen.getByLabelText("Input"), "Text");
    fireEvent.change(screen.getByLabelText("Request"), {
      target: { value: "A lighthouse" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate 9 views" }));

    await waitFor(() =>
      expect(generateImagesWithOpenAIAdapter).toHaveBeenCalledTimes(3),
    );
    expect(
      screen.queryByText("Choose a perspective for every task."),
    ).not.toBeInTheDocument();
  });

  it("disables Generate while a batch is running", async () => {
    const signals: AbortSignal[] = [];
    vi.mocked(generateImagesWithOpenAIAdapter).mockImplementation(
      ({ signal }) => {
        signals.push(signal!);
        return new Promise(() => {});
      },
    );
    render(
      <ManyMindsDialog
        open
        onClose={vi.fn()}
        excalidrawAPI={textOnlyAPI}
        persistenceScopeId="local:test"
      />,
    );
    chooseSelectOption(screen.getByLabelText("Input"), "Text");
    fireEvent.change(screen.getByLabelText("Request"), {
      target: { value: "A lighthouse" },
    });
    const generate = screen.getByRole("button", { name: "Generate 4 views" });
    fireEvent.click(generate);
    fireEvent.click(generate);

    await waitFor(() => expect(generate).toBeDisabled());
    fireEvent.click(generate);
    // One batch: 3 running (concurrency), none aborted by a second scheduler.
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
  });

  it("translates built-in perspective names and the interrupted notice at render time", async () => {
    const batch = createManyMindsBatch({
      persistenceScopeId: "local:test",
      input: {
        kind: "text",
        prompt: "A city",
        sourceElementIds: [],
        assets: [],
        createdAt: 1,
      },
      perspectives: [
        {
          id: "clarify",
          // Persisted name from an older build / another language.
          name: "Legacy stored name",
          icon: "focus",
          prompt: "Clarify",
          isBuiltIn: true,
        },
      ],
      modelId: "model-card-1",
      params: { size: "1024x1024", n: 1 },
      now: 1,
    });
    const task = batch.tasks[batch.taskOrder[0]];
    task.status = "running";
    // Older builds persisted this English text in the task itself.
    task.error = "Interrupted by page refresh. Retry explicitly to continue.";
    vi.mocked(listManyMindsBatches).mockResolvedValue([batch]);

    render(
      <ManyMindsDialog
        open
        onClose={vi.fn()}
        excalidrawAPI={textOnlyAPI}
        persistenceScopeId="local:test"
      />,
    );

    expect(
      await screen.findByRole("article", { name: /^Clarify: / }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Legacy stored name")).not.toBeInTheDocument();
    expect(screen.getAllByText(/Interrupted by page refresh/)).toHaveLength(1);
  });
});
