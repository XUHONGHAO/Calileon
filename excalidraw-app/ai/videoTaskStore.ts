import { STORAGE_KEYS } from "../app_constants";

import type { AIVideoTaskStatus, PendingVideoTask } from "./types";

/**
 * Persistence for in-flight video generation tasks. Video generation is async
 * (submit -> poll for tens of seconds to minutes), so tasks are written to
 * localStorage and re-hydrated on mount, letting the workbench resume polling
 * after a page refresh instead of losing a long-running generation.
 *
 * The API key is intentionally NOT persisted; only `modelId` is stored so the
 * resumed poll can look the key up from the current config.
 */

export const AI_VIDEO_TASKS_UPDATED_EVENT = "excalidraw-ai-video-tasks";

const MAX_PENDING_VIDEO_TASKS = 50;

type PendingVideoTasksState = {
  tasks: PendingVideoTask[];
};

const isPendingVideoTask = (value: unknown): value is PendingVideoTask => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const task = value as Partial<PendingVideoTask>;

  return (
    typeof task.taskId === "string" &&
    typeof task.baseURL === "string" &&
    typeof task.modelId === "string" &&
    typeof task.model === "string" &&
    typeof task.siteName === "string" &&
    (task.mode === "text-to-video" || task.mode === "image-to-video") &&
    typeof task.prompt === "string" &&
    !!task.params &&
    typeof task.params === "object" &&
    (task.status === "queued" ||
      task.status === "processing" ||
      task.status === "completed" ||
      task.status === "failed") &&
    typeof task.submittedAt === "string"
  );
};

export const loadPendingVideoTasks = (): PendingVideoTask[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_AI_VIDEO_TASKS);

    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as Partial<PendingVideoTasksState>;

    return Array.isArray(parsed?.tasks)
      ? parsed.tasks.filter(isPendingVideoTask)
      : [];
  } catch (error: any) {
    console.error(error);
    return [];
  }
};

const savePendingVideoTasks = (tasks: PendingVideoTask[]) => {
  const normalizedTasks = tasks
    .filter(isPendingVideoTask)
    .slice(0, MAX_PENDING_VIDEO_TASKS);
  const state: PendingVideoTasksState = { tasks: normalizedTasks };

  localStorage.setItem(
    STORAGE_KEYS.LOCAL_STORAGE_AI_VIDEO_TASKS,
    JSON.stringify(state),
  );
  dispatchPendingVideoTasksUpdated(normalizedTasks);

  return normalizedTasks;
};

/**
 * Insert or update a task by `taskId`. Newest tasks sort first; an existing
 * task keeps its position so a status update does not reorder the queue.
 */
export const upsertVideoTask = (task: PendingVideoTask) => {
  const existing = loadPendingVideoTasks();
  const index = existing.findIndex((entry) => entry.taskId === task.taskId);

  if (index === -1) {
    return savePendingVideoTasks([task, ...existing]);
  }

  const next = [...existing];
  next[index] = { ...next[index], ...task };

  return savePendingVideoTasks(next);
};

export const updateVideoTaskStatus = (
  taskId: string,
  status: AIVideoTaskStatus,
) => {
  const existing = loadPendingVideoTasks();
  const index = existing.findIndex((entry) => entry.taskId === taskId);

  if (index === -1) {
    return existing;
  }

  const next = [...existing];
  next[index] = { ...next[index], status };

  return savePendingVideoTasks(next);
};

export const removeVideoTask = (taskId: string) => {
  const existing = loadPendingVideoTasks();
  const next = existing.filter((entry) => entry.taskId !== taskId);

  if (next.length === existing.length) {
    return existing;
  }

  return savePendingVideoTasks(next);
};

export const clearPendingVideoTasks = () => {
  localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_AI_VIDEO_TASKS);
  dispatchPendingVideoTasksUpdated([]);
};

const dispatchPendingVideoTasksUpdated = (tasks: PendingVideoTask[]) => {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent(AI_VIDEO_TASKS_UPDATED_EVENT, {
      detail: tasks,
    }),
  );
};
