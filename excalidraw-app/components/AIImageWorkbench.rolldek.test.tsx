import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { vi } from "vitest";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { saveAIImageConfig } from "../ai/config";
import { loadAIGenerationLogs } from "../ai/generationLog";
import { AIImageGenerationError } from "../ai/openAIImageAdapter";
import {
  downloadRollDekVideoResult,
  pollRollDekVideoTask,
  submitRollDekVideoTask,
} from "../ai/rolldekVideoAdapter";
import { submitVideoTask } from "../ai/openAIVideoAdapter";
import {
  getVideoDimensions,
  insertVideoEmbedIntoCanvas,
} from "../ai/videoCanvas";
import { loadPendingVideoTasks } from "../ai/videoTaskStore";

import { AIImageWorkbench } from "./AIImageWorkbench";
import { getSelectOptionLabels } from "./ui/testing";

import type { AIImageModel, AIImageProviderConfig } from "../ai/types";

vi.mock("../data/AIWorkbenchIndexedDB", () => ({
  AIWorkbenchIndexedDBAdapter: {
    setRevisionPayloads: async () => [],
    getMany: async (keys: string[]) => keys.map(() => undefined),
    deleteMany: async () => undefined,
  },
}));

vi.mock("../ai/rolldekVideoAdapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ai/rolldekVideoAdapter")>()),
  submitRollDekVideoTask: vi.fn(),
  pollRollDekVideoTask: vi.fn(),
  downloadRollDekVideoResult: vi.fn(),
}));

vi.mock("../ai/openAIVideoAdapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ai/openAIVideoAdapter")>()),
  submitVideoTask: vi.fn(),
  pollVideoTask: vi.fn(),
}));

// Signed-in state and the reference service are switched per test.
const authState = { isSignedIn: false };
vi.mock("../auth/useCloudAuth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/useCloudAuth")>()),
  useCloudAuth: () => ({
    isAuthAvailable: true,
    status: authState.isSignedIn ? "signed-in" : "signed-out",
    user: null,
    isSignedIn: authState.isSignedIn,
    signIn: vi.fn(),
    signOut: vi.fn(),
    updateAvatar: null,
  }),
}));

const videoReferences = {
  upload: vi.fn(),
  remove: vi.fn(),
  removeStale: vi.fn(),
};
const backendState = { withReferences: false };
vi.mock("../data/cloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../data/cloud")>();
  return {
    ...actual,
    getCloudBackend: () => {
      const backend = actual.getCloudBackend();
      return backendState.withReferences
        ? { ...backend, videoReferences }
        : backend;
    },
  };
});

vi.mock("../ai/rolldekVideoOptions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ai/rolldekVideoOptions")>()),
  // jsdom cannot read media metadata.
  probeMediaDurationSeconds: vi.fn(async () => 3),
}));

vi.mock("../ai/videoCanvas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ai/videoCanvas")>()),
  getVideoDimensions: vi.fn(),
  insertVideoEmbedIntoCanvas: vi.fn(),
}));

const VOLC_MODEL = "doubao-seedance-2-5-260628";

const createRollDekConfig = (
  billing: AIImageModel["billing"] = { mode: "per-token", multiplier: 0.75 },
): AIImageProviderConfig => ({
  baseURL: "https://rolldek.com",
  apiKey: "",
  defaultModel: "rolldek-volc",
  models: [
    {
      id: "rolldek-volc",
      siteName: "RollDek",
      baseURL: "https://api-cn.rolldek.com",
      apiKey: "sk-local-only",
      model: VOLC_MODEL,
      label: "Seedance 2.5",
      mediaType: "video",
      nativeModel: "other",
      capabilities: ["text-to-video", "image-to-video"],
      endpoints: {
        textToImage: { path: "/images/generations", format: "json" },
        imageToImage: { path: "/images/edits", format: "form" },
        inpaint: { path: "/images/edits", format: "form" },
      },
      requestTimeoutSeconds: 30,
      videoProtocol: "volc-tasks",
      billing,
    },
  ],
});

const createExcalidrawAPI = (): ExcalidrawImperativeAPI =>
  ({
    getAppState: () => ({ selectedElementIds: {}, name: null }),
    getName: () => "Untitled",
    getSceneElements: () => [],
    getFiles: () => ({}),
    onChange: () => () => {},
    setToast: vi.fn(),
  } as unknown as ExcalidrawImperativeAPI);

const startVideo = (prompt = "清晨的高山湖泊") => {
  fireEvent.click(screen.getByRole("button", { name: "Video" }));
  const editor = screen.getByLabelText("Prompt");
  editor.textContent = prompt;
  fireEvent.input(editor);
  fireEvent.click(screen.getByRole("button", { name: "Generate video" }));
};

describe("AIImageWorkbench with RollDek video", () => {
  const { createObjectURL, revokeObjectURL } = URL;

  beforeEach(() => {
    localStorage.clear();
    authState.isSignedIn = false;
    backendState.withReferences = false;
    videoReferences.upload.mockReset();
    videoReferences.remove.mockReset().mockResolvedValue(undefined);
    videoReferences.removeStale.mockReset().mockResolvedValue(0);
    vi.mocked(submitRollDekVideoTask).mockReset();
    vi.mocked(pollRollDekVideoTask).mockReset();
    vi.mocked(downloadRollDekVideoResult).mockReset();
    vi.mocked(submitVideoTask).mockReset();
    vi.mocked(insertVideoEmbedIntoCanvas).mockReset();
    vi.mocked(getVideoDimensions).mockResolvedValue({
      width: 1280,
      height: 720,
    });
    URL.createObjectURL = vi.fn(() => "blob:probe");
    URL.revokeObjectURL = vi.fn();
    saveAIImageConfig(createRollDekConfig());
  });

  afterEach(() => {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("submits, downloads with the key and persists the bytes", async () => {
    const videoBlob = new Blob([new Uint8Array(8)], { type: "video/mp4" });
    vi.mocked(submitRollDekVideoTask).mockResolvedValue({
      taskId: "task_lzp",
      endpoint: "https://api-cn.rolldek.com/api/v3/contents/generations/tasks",
    });
    vi.mocked(pollRollDekVideoTask).mockResolvedValue({
      status: "completed",
      videoURL: "https://api-cn.rolldek.com/v1/videos/task_lzp/content",
      durationSeconds: 4,
      totalTokens: 83_505,
    });
    vi.mocked(downloadRollDekVideoResult).mockResolvedValue({
      blob: videoBlob,
      mimeType: "video/mp4",
      bytes: 8,
    });
    const onPersistVideoOutput = vi.fn().mockResolvedValue({
      assetId: "local:task_lzp",
      mimeType: "video/mp4",
      bytes: 8,
    });

    render(
      <AIImageWorkbench
        excalidrawAPI={createExcalidrawAPI()}
        onPersistVideoOutput={onPersistVideoOutput}
      />,
    );
    startVideo();

    await waitFor(() => {
      expect(insertVideoEmbedIntoCanvas).toHaveBeenCalled();
    });
    expect(submitVideoTask).not.toHaveBeenCalled();
    expect(submitRollDekVideoTask).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: "volc-tasks",
        baseURL: "https://api-cn.rolldek.com",
        apiKey: "sk-local-only",
        model: VOLC_MODEL,
        mode: "text-to-video",
        references: [],
      }),
    );
    expect(pollRollDekVideoTask).toHaveBeenCalledWith(
      expect.objectContaining({ protocol: "volc-tasks", taskId: "task_lzp" }),
    );
    expect(downloadRollDekVideoResult).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://api-cn.rolldek.com",
        apiKey: "sk-local-only",
        taskId: "task_lzp",
      }),
    );
    expect(getVideoDimensions).toHaveBeenCalledWith(
      "blob:probe",
      expect.anything(),
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:probe");
    expect(onPersistVideoOutput).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task_lzp", videoBlob }),
    );
    expect(loadPendingVideoTasks()).toEqual([]);
    expect(loadAIGenerationLogs()[0]).toMatchObject({
      status: "success",
      request: {
        endpoint:
          "https://api-cn.rolldek.com/api/v3/contents/generations/tasks",
      },
    });
    // 83,505 tokens × ¥70/M (720p list price) × 0.75
    const details = JSON.stringify(loadAIGenerationLogs()[0]);
    expect(details).toContain('"billedUnits":83505');
    expect(details).toContain("4.38");
  });

  it("adds the refund note when RollDek reports a failed task", async () => {
    vi.mocked(submitRollDekVideoTask).mockResolvedValue({
      taskId: "task_fail",
      endpoint: "https://api-cn.rolldek.com/api/v3/contents/generations/tasks",
    });
    vi.mocked(pollRollDekVideoTask).mockResolvedValue({
      status: "failed",
      error: "该模型暂时没有可用生成资源",
    });

    render(<AIImageWorkbench excalidrawAPI={createExcalidrawAPI()} />);
    startVideo();

    await waitFor(() => {
      expect(
        screen.getByText(/该模型暂时没有可用生成资源 RollDek refunds/),
      ).toBeTruthy();
    });
    expect(loadPendingVideoTasks()).toEqual([]);
  });

  it("tells the user to check the console when the submit outcome is unknown", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(submitRollDekVideoTask).mockRejectedValue(
      new AIImageGenerationError("Please retry later.", "request-failed", {
        submitOutcome: "unknown",
      }),
    );

    render(<AIImageWorkbench excalidrawAPI={createExcalidrawAPI()} />);
    startVideo();

    await waitFor(() => {
      expect(
        screen.getByText(/Please retry later\. The task may have been created/),
      ).toBeTruthy();
    });
    expect(submitRollDekVideoTask).toHaveBeenCalledTimes(1);
    expect(loadPendingVideoTasks()).toEqual([]);
  });

  it("gives up after three task-not-found polls in a row", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(submitRollDekVideoTask).mockResolvedValue({
      taskId: "task_gone",
      endpoint: "https://api-cn.rolldek.com/api/v3/contents/generations/tasks",
    });
    vi.mocked(pollRollDekVideoTask).mockRejectedValue(
      new AIImageGenerationError("task not found", "request-failed", {
        taskNotFound: true,
      }),
    );

    const { unmount } = render(
      <AIImageWorkbench excalidrawAPI={createExcalidrawAPI()} />,
    );
    startVideo();

    await act(async () => {});
    expect(pollRollDekVideoTask).toHaveBeenCalledTimes(1);
    expect(loadPendingVideoTasks()).toHaveLength(1);

    // RollDek polls every 15 s; error backoff is 15 s, then 30 s.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(pollRollDekVideoTask).toHaveBeenCalledTimes(2);
    expect(loadPendingVideoTasks()).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(pollRollDekVideoTask).toHaveBeenCalledTimes(3);
    expect(loadPendingVideoTasks()).toEqual([]);
    expect(loadAIGenerationLogs()[0]).toMatchObject({ status: "failed" });

    unmount();
  });

  it("keeps the task for another download when the download keeps failing", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(submitRollDekVideoTask).mockResolvedValue({
      taskId: "task_dl",
      endpoint: "https://api-cn.rolldek.com/api/v3/contents/generations/tasks",
    });
    vi.mocked(pollRollDekVideoTask).mockResolvedValue({
      status: "completed",
      videoURL: "https://api-cn.rolldek.com/v1/videos/task_dl/content",
    });
    vi.mocked(downloadRollDekVideoResult).mockRejectedValue(
      new AIImageGenerationError("network", "cors-or-network", {
        downloadFailed: true,
      }),
    );

    const { unmount } = render(
      <AIImageWorkbench
        excalidrawAPI={createExcalidrawAPI()}
        onPersistVideoOutput={vi.fn()}
      />,
    );
    startVideo();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(downloadRollDekVideoResult).toHaveBeenCalledTimes(3);
    expect(loadPendingVideoTasks()).toEqual([
      expect.objectContaining({ taskId: "task_dl" }),
    ]);
    expect(insertVideoEmbedIntoCanvas).not.toHaveBeenCalled();

    unmount();
  });

  it("offers the catalog options and a per-token estimate", () => {
    render(<AIImageWorkbench excalidrawAPI={createExcalidrawAPI()} />);
    fireEvent.click(screen.getByRole("button", { name: "Video" }));

    expect(
      getSelectOptionLabels(screen.getByLabelText("Aspect ratio")),
    ).toEqual(["16:9", "9:16", "1:1", "21:9", "4:3", "3:4"]);
    expect(getSelectOptionLabels(screen.getByLabelText("Resolution"))).toEqual([
      "720P",
      "1080P",
    ]);
    expect(screen.getByLabelText("Duration")).toHaveAttribute("max", "15");
    // 10 s 720p = 216,000 tokens × ¥70/M × 0.75 = 11.34.
    expect(
      screen.getByText(/About 216,000 tokens · about \$11\.34\./),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "First/last frame" }),
    ).toBeDisabled();
  });

  it("shows no estimate for per-request cards", () => {
    saveAIImageConfig(createRollDekConfig({ mode: "per-request" }));
    render(<AIImageWorkbench excalidrawAPI={createExcalidrawAPI()} />);
    fireEvent.click(screen.getByRole("button", { name: "Video" }));

    expect(screen.queryByText(/tokens/)).toBeNull();
  });

  it("keeps references off when signed out", () => {
    backendState.withReferences = true;
    render(<AIImageWorkbench excalidrawAPI={createExcalidrawAPI()} />);
    fireEvent.click(screen.getByRole("button", { name: "Video" }));

    expect(screen.getByRole("button", { name: "Reference" })).toBeDisabled();
    expect(
      screen.getByText(/Sign in to a cloud account to use reference/),
    ).toBeTruthy();
  });

  it("uploads a video reference after the privacy notice is acknowledged", async () => {
    authState.isSignedIn = true;
    backendState.withReferences = true;
    videoReferences.upload.mockResolvedValue({
      assetId: "ref-1",
      url: "https://storage.example/ref-1?token=signed",
      expiresAt: "2026-11-01T12:00:00Z",
    });
    vi.mocked(submitRollDekVideoTask).mockResolvedValue({
      taskId: "task_ref",
      endpoint: "https://api-cn.rolldek.com/api/v3/contents/generations/tasks",
    });
    vi.mocked(pollRollDekVideoTask).mockResolvedValue({
      status: "processing",
    });

    const { unmount } = render(
      <AIImageWorkbench excalidrawAPI={createExcalidrawAPI()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Video" }));
    fireEvent.click(screen.getByRole("button", { name: "Reference" }));
    expect(
      screen.getByText(/Add a reference image in the Image tab/),
    ).toBeTruthy();

    const clip = new File(["clip"], "clip.mp4", { type: "video/mp4" });
    fireEvent.change(screen.getByTestId("rolldek-video-input"), {
      target: { files: [clip] },
    });
    await waitFor(() => {
      expect(screen.getByText("3 s")).toBeTruthy();
    });
    expect(screen.getByText("clip.mp4")).toBeTruthy();
    expect(
      screen.queryByText(/Add a reference image in the Image tab/),
    ).toBeNull();
    // (10 + 3) s × 921,600 px × 24 / 1024 = 280,800 tokens at the
    // with-video price: × ¥42/M × 0.75 = 8.85.
    expect(
      screen.getByText(
        /About 280,800 tokens · about \$8\.85\. With a reference video/,
      ),
    ).toBeTruthy();

    const editor = screen.getByLabelText("Prompt");
    editor.textContent = "沿用 #1 的运镜";
    fireEvent.input(editor);
    const generate = screen.getByRole("button", { name: "Generate video" });
    expect(generate).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(localStorage.getItem("excalidraw-ai-video-reference-notice")).toBe(
      "1",
    );
    fireEvent.click(generate);

    await waitFor(() => {
      expect(submitRollDekVideoTask).toHaveBeenCalled();
    });
    expect(videoReferences.upload).toHaveBeenCalledWith(
      expect.objectContaining({ blob: clip, mimeType: "video/mp4" }),
    );
    expect(submitRollDekVideoTask).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "reference-to-video",
        references: [
          {
            kind: "video",
            url: "https://storage.example/ref-1?token=signed",
            durationSeconds: 3,
          },
        ],
      }),
    );
    await waitFor(() => {
      expect(loadPendingVideoTasks()).toEqual([
        expect.objectContaining({
          taskId: "task_ref",
          referenceAssetIds: ["ref-1"],
          hasReferenceVideo: true,
        }),
      ]);
    });

    unmount();
  });

  it("rejects media types the bucket does not accept", async () => {
    authState.isSignedIn = true;
    backendState.withReferences = true;
    render(<AIImageWorkbench excalidrawAPI={createExcalidrawAPI()} />);
    fireEvent.click(screen.getByRole("button", { name: "Video" }));
    fireEvent.click(screen.getByRole("button", { name: "Reference" }));

    fireEvent.change(screen.getByTestId("rolldek-video-input"), {
      target: {
        files: [new File(["x"], "take.mov", { type: "video/quicktime" })],
      },
    });

    expect(
      await screen.findByText(/take\.mov is not a supported format/),
    ).toBeTruthy();
  });
});
