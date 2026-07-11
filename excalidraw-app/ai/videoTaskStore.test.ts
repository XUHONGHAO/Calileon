import { STORAGE_KEYS } from "../app_constants";

import {
  clearPendingVideoTasks,
  loadPendingVideoTasks,
  removeVideoTask,
  updateVideoTaskStatus,
  upsertVideoTask,
} from "./videoTaskStore";

import type { PendingVideoTask } from "./types";

const createTask = (
  overrides: Partial<PendingVideoTask> = {},
): PendingVideoTask => ({
  taskId: "task-1",
  baseURL: "https://duoyuanx.com/v1",
  modelId: "model-card-1",
  model: "grok-video-3",
  siteName: "多元探索",
  mode: "text-to-video",
  prompt: "a cat in the rain",
  params: { size: "720x1280", n: 1 },
  status: "queued",
  submittedAt: "2026-07-07T10:00:00.000Z",
  ...overrides,
});

describe("video task store", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("persists and loads pending tasks", () => {
    const task = createTask();

    upsertVideoTask(task);

    expect(loadPendingVideoTasks()).toEqual([task]);
  });

  it("inserts new tasks at the front and keeps existing task positions", () => {
    upsertVideoTask(createTask({ taskId: "task-1" }));
    upsertVideoTask(createTask({ taskId: "task-2" }));

    expect(loadPendingVideoTasks().map((task) => task.taskId)).toEqual([
      "task-2",
      "task-1",
    ]);

    // updating task-1 must not reorder it to the front
    upsertVideoTask(createTask({ taskId: "task-1", status: "processing" }));

    const tasks = loadPendingVideoTasks();
    expect(tasks.map((task) => task.taskId)).toEqual(["task-2", "task-1"]);
    expect(tasks.find((task) => task.taskId === "task-1")?.status).toBe(
      "processing",
    );
  });

  it("updates the status of an existing task", () => {
    upsertVideoTask(createTask({ taskId: "task-1" }));

    updateVideoTaskStatus("task-1", "completed");

    expect(loadPendingVideoTasks()[0].status).toBe("completed");
  });

  it("ignores status updates for unknown tasks", () => {
    upsertVideoTask(createTask({ taskId: "task-1" }));

    updateVideoTaskStatus("missing", "failed");

    expect(loadPendingVideoTasks()).toHaveLength(1);
    expect(loadPendingVideoTasks()[0].status).toBe("queued");
  });

  it("removes a task by id", () => {
    upsertVideoTask(createTask({ taskId: "task-1" }));
    upsertVideoTask(createTask({ taskId: "task-2" }));

    removeVideoTask("task-1");

    expect(loadPendingVideoTasks().map((task) => task.taskId)).toEqual([
      "task-2",
    ]);
  });

  it("clears all tasks", () => {
    upsertVideoTask(createTask({ taskId: "task-1" }));

    clearPendingVideoTasks();

    expect(loadPendingVideoTasks()).toEqual([]);
  });

  it("returns an empty list when storage holds malformed JSON", () => {
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_AI_VIDEO_TASKS,
      "{not json",
    );

    expect(loadPendingVideoTasks()).toEqual([]);
  });

  it("filters out entries that are not valid tasks", () => {
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_AI_VIDEO_TASKS,
      JSON.stringify({
        tasks: [
          createTask({ taskId: "valid" }),
          { taskId: "missing-fields" },
          null,
          "garbage",
        ],
      }),
    );

    expect(loadPendingVideoTasks().map((task) => task.taskId)).toEqual([
      "valid",
    ]);
  });

  it("tolerates a legacy array shape without a tasks wrapper", () => {
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_AI_VIDEO_TASKS,
      JSON.stringify([createTask()]),
    );

    expect(loadPendingVideoTasks()).toEqual([]);
  });
});
