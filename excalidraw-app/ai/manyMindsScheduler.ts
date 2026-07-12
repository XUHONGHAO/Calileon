import { sanitizeManyMindsText } from "./manyMindsPerspectives";

import type {
  ManyMindsAssetRef,
  ManyMindsBatch,
  ManyMindsTask,
} from "./manyMindsTypes";

export type ManyMindsTaskExecutor = (input: {
  batch: ManyMindsBatch;
  task: ManyMindsTask;
  signal: AbortSignal;
}) => Promise<ManyMindsAssetRef>;

export type ManyMindsSchedulerOptions = {
  executeTask: ManyMindsTaskExecutor;
  onPersist?: (batch: ManyMindsBatch) => void | Promise<void>;
  now?: () => number;
};

const cloneBatch = (batch: ManyMindsBatch): ManyMindsBatch => ({
  ...batch,
  input: {
    ...batch.input,
    sourceElementIds: [...batch.input.sourceElementIds],
    assets: batch.input.assets.map((asset) => ({ ...asset })),
  },
  taskOrder: [...batch.taskOrder],
  tasks: Object.fromEntries(
    Object.entries(batch.tasks).map(([id, task]) => [
      id,
      {
        ...task,
        perspective: {
          ...task.perspective,
          params: { ...task.perspective.params },
        },
        params: { ...task.params },
        output: task.output ? { ...task.output } : undefined,
      },
    ]),
  ),
});

const isAbortError = (error: unknown) =>
  error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";

export class ManyMindsScheduler {
  private batch: ManyMindsBatch | null = null;
  private readonly executeTask: ManyMindsTaskExecutor;
  private readonly onPersist?: ManyMindsSchedulerOptions["onPersist"];
  private readonly now: () => number;
  private readonly listeners = new Set<(batch: ManyMindsBatch) => void>();
  private readonly controllers = new Map<string, AbortController>();
  private runEnabled = false;
  private disposed = false;
  private persistChain = Promise.resolve();

  constructor({
    executeTask,
    onPersist,
    now = Date.now,
  }: ManyMindsSchedulerOptions) {
    this.executeTask = executeTask;
    this.onPersist = onPersist;
    this.now = now;
  }

  getBatch() {
    return this.batch ? cloneBatch(this.batch) : null;
  }

  subscribe(listener: (batch: ManyMindsBatch) => void) {
    this.listeners.add(listener);
    if (this.batch) {
      listener(cloneBatch(this.batch));
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Restores state only. It deliberately never invokes the paid executor. */
  hydrate(batch: ManyMindsBatch) {
    this.assertUsable();
    this.runEnabled = false;
    const now = this.now();
    const restored = cloneBatch(batch);
    let interrupted = false;
    for (const task of Object.values(restored.tasks)) {
      if (task.status === "running") {
        task.status = "interrupted";
        task.interruptedAt = now;
        task.error =
          "Interrupted by page refresh. Retry explicitly to continue.";
        interrupted = true;
      }
    }
    if (interrupted) {
      restored.status = "interrupted";
      restored.updatedAt = now;
    }
    this.batch = restored;
    this.publish();
    return this.getBatch();
  }

  start(batch?: ManyMindsBatch) {
    this.assertUsable();
    if (batch) {
      this.batch = cloneBatch(batch);
    }
    if (!this.batch) {
      throw new Error("Many Minds scheduler has no batch.");
    }
    this.runEnabled = true;
    if (this.batch.status !== "cancelled") {
      this.batch.status = "running";
      this.touch();
      this.pump();
    }
    return this.getBatch();
  }

  cancelTask(taskId: string) {
    const task = this.requireTask(taskId);
    if (task.status === "queued" || task.status === "interrupted") {
      task.status = "cancelled";
      task.completedAt = this.now();
    } else if (task.status === "running") {
      task.status = "cancelled";
      task.completedAt = this.now();
      task.cancellationMayHaveIncurredCost = true;
      this.controllers.get(taskId)?.abort();
    } else {
      return false;
    }
    this.touch();
    this.pump();
    return true;
  }

  retryTask(taskId: string) {
    const task = this.requireTask(taskId);
    if (!["failed", "cancelled", "interrupted"].includes(task.status)) {
      return false;
    }
    task.status = "queued";
    task.error = undefined;
    task.output = undefined;
    task.startedAt = undefined;
    task.completedAt = undefined;
    task.interruptedAt = undefined;
    task.cancellationMayHaveIncurredCost = undefined;
    this.touch();
    if (this.runEnabled) {
      this.pump();
    }
    return true;
  }

  updateTask(
    taskId: string,
    update: Partial<Pick<ManyMindsTask, "modelId" | "params" | "perspective">>,
  ) {
    const task = this.requireTask(taskId);
    if (task.status === "running" || task.status === "succeeded") {
      return false;
    }
    if (update.modelId !== undefined) {
      task.modelId = sanitizeManyMindsText(update.modelId);
    }
    if (update.params !== undefined) {
      task.params = { ...update.params };
    }
    if (update.perspective !== undefined) {
      task.perspective = {
        ...update.perspective,
        name: sanitizeManyMindsText(update.perspective.name),
        prompt: sanitizeManyMindsText(update.perspective.prompt),
      };
    }
    this.touch();
    return true;
  }

  deleteTask(taskId: string) {
    const task = this.requireTask(taskId);
    if (task.status === "running") {
      this.controllers.get(taskId)?.abort();
    }
    delete this.batch!.tasks[taskId];
    this.batch!.taskOrder = this.batch!.taskOrder.filter((id) => id !== taskId);
    this.touch();
    this.pump();
    return true;
  }

  cancelBatch() {
    if (!this.batch) {
      return false;
    }
    this.runEnabled = false;
    this.batch.taskOrder.forEach((taskId) => this.cancelTask(taskId));
    this.batch.status = "cancelled";
    this.touch();
    return true;
  }

  dispose() {
    this.disposed = true;
    this.runEnabled = false;
    this.controllers.forEach((controller) => controller.abort());
    this.controllers.clear();
    this.listeners.clear();
  }

  private assertUsable() {
    if (this.disposed) {
      throw new Error("Many Minds scheduler is disposed.");
    }
  }

  private requireTask(taskId: string) {
    if (!this.batch?.tasks[taskId]) {
      throw new Error(`Unknown Many Minds task: ${taskId}`);
    }
    return this.batch.tasks[taskId];
  }

  private touch() {
    if (!this.batch) {
      return;
    }
    this.batch.updatedAt = this.now();
    this.publish();
  }

  private publish() {
    if (!this.batch) {
      return;
    }
    const snapshot = cloneBatch(this.batch);
    this.listeners.forEach((listener) => listener(snapshot));
    if (this.onPersist) {
      this.persistChain = this.persistChain
        .then(() => this.onPersist?.(snapshot))
        .then(
          () => undefined,
          () => undefined,
        );
    }
  }

  private pump() {
    if (!this.batch || !this.runEnabled || this.disposed) {
      return;
    }
    const running = Object.values(this.batch.tasks).filter(
      (task) => task.status === "running",
    ).length;
    const available = Math.max(0, this.batch.concurrency - running);
    this.batch.taskOrder
      .map((taskId) => this.batch!.tasks[taskId])
      .filter(
        (task): task is ManyMindsTask => !!task && task.status === "queued",
      )
      .slice(0, available)
      .forEach((task) => this.runTask(task));

    if (
      !Object.values(this.batch.tasks).some((task) =>
        ["queued", "running"].includes(task.status),
      )
    ) {
      this.batch.status = Object.values(this.batch.tasks).some(
        (task) => task.status === "interrupted",
      )
        ? "interrupted"
        : "completed";
      this.runEnabled = false;
      this.touch();
    }
  }

  private runTask(task: ManyMindsTask) {
    if (!this.batch || task.status !== "queued") {
      return;
    }
    const controller = new AbortController();
    this.controllers.set(task.id, controller);
    task.status = "running";
    task.attempt += 1;
    task.startedAt = this.now();
    task.error = undefined;
    this.touch();
    const batchSnapshot = cloneBatch(this.batch);
    const taskSnapshot = { ...batchSnapshot.tasks[task.id] };

    void this.executeTask({
      batch: batchSnapshot,
      task: taskSnapshot,
      signal: controller.signal,
    })
      .then((output) => {
        const current = this.batch?.tasks[task.id];
        if (!current || current.status !== "running") {
          return;
        }
        current.status = "succeeded";
        current.output = { ...output, role: "output" };
        current.completedAt = this.now();
      })
      .catch((error: unknown) => {
        const current = this.batch?.tasks[task.id];
        if (!current || current.status !== "running") {
          return;
        }
        if (controller.signal.aborted || isAbortError(error)) {
          current.status = "cancelled";
          current.cancellationMayHaveIncurredCost = true;
        } else {
          current.status = "failed";
          current.error = sanitizeManyMindsText(
            error instanceof Error ? error.message : String(error),
          ).slice(0, 1000);
        }
        current.completedAt = this.now();
      })
      .finally(() => {
        this.controllers.delete(task.id);
        this.touch();
        this.pump();
      });
  }
}
