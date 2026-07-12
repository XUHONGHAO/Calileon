import { describe, expect, it, vi } from "vitest";

import { ManyMindsScheduler } from "./manyMindsScheduler";
import {
  createManyMindsBatch,
  type ManyMindsAssetRef,
  type ManyMindsPerspective,
} from "./manyMindsTypes";

const perspectives = (count: number): ManyMindsPerspective[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `p-${index}`,
    name: `Perspective ${index}`,
    icon: "sparkles",
    prompt: `Prompt ${index}`,
    isBuiltIn: true,
  }));

const createBatch = (count = 4) =>
  createManyMindsBatch({
    persistenceScopeId: "scope-1",
    input: {
      kind: "text",
      prompt: "A city",
      sourceElementIds: [],
      assets: [],
      createdAt: 1,
    },
    perspectives: perspectives(count),
    modelId: "configured-model",
    params: { size: "1024x1024", n: 1 },
    now: 1,
  });

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ManyMindsScheduler", () => {
  it("limits concurrency to three and isolates failure", async () => {
    const pending: Array<{
      resolve: (asset: ManyMindsAssetRef) => void;
      reject: (error: Error) => void;
    }> = [];
    const executeTask = vi.fn(
      () =>
        new Promise<ManyMindsAssetRef>((resolve, reject) =>
          pending.push({ resolve, reject }),
        ),
    );
    const scheduler = new ManyMindsScheduler({ executeTask });
    scheduler.start(createBatch());
    expect(executeTask).toHaveBeenCalledTimes(3);

    pending[0].reject(new Error("provider failed"));
    await flush();
    expect(executeTask).toHaveBeenCalledTimes(4);
    pending[1].resolve({
      assetId: "a-1",
      role: "output",
      mimeType: "image/png",
    });
    pending[2].resolve({
      assetId: "a-2",
      role: "output",
      mimeType: "image/png",
    });
    pending[3].resolve({
      assetId: "a-3",
      role: "output",
      mimeType: "image/png",
    });
    await flush();

    const tasks = Object.values(scheduler.getBatch()!.tasks);
    expect(tasks.filter((task) => task.status === "failed")).toHaveLength(1);
    expect(tasks.filter((task) => task.status === "succeeded")).toHaveLength(3);
    expect(executeTask).toHaveBeenCalledTimes(4);
  });

  it("hydrates running tasks as interrupted without submitting", () => {
    const executeTask = vi.fn();
    const batch = createBatch(2);
    batch.tasks[batch.taskOrder[0]].status = "running";
    const scheduler = new ManyMindsScheduler({ executeTask, now: () => 50 });
    scheduler.hydrate(batch);
    expect(executeTask).not.toHaveBeenCalled();
    expect(scheduler.getBatch()!.tasks[batch.taskOrder[0]].status).toBe(
      "interrupted",
    );
    expect(scheduler.getBatch()!.status).toBe("interrupted");
  });

  it("cancels and explicitly retries only one task", async () => {
    const executeTask = vi.fn(({ task }: { task: { id: string } }) =>
      Promise.resolve({
        assetId: `asset-${task.id}`,
        role: "output" as const,
        mimeType: "image/png",
      }),
    );
    const batch = createBatch(2);
    const cancelledId = batch.taskOrder[1];
    const scheduler = new ManyMindsScheduler({ executeTask });
    scheduler.hydrate(batch);
    scheduler.cancelTask(cancelledId);
    scheduler.start();
    await flush();
    expect(executeTask).toHaveBeenCalledTimes(1);
    expect(scheduler.getBatch()!.tasks[cancelledId].status).toBe("cancelled");

    expect(scheduler.retryTask(cancelledId)).toBe(true);
    scheduler.start();
    await flush();
    expect(executeTask).toHaveBeenCalledTimes(2);
    expect(scheduler.getBatch()!.tasks[cancelledId].attempt).toBe(1);
  });

  it("never silently changes the configured model", async () => {
    const seenModels: string[] = [];
    const scheduler = new ManyMindsScheduler({
      executeTask: async ({ task }) => {
        seenModels.push(task.modelId);
        throw new Error("model unavailable");
      },
    });
    scheduler.start(createBatch(1));
    await flush();
    expect(seenModels).toEqual(["configured-model"]);
    expect(Object.values(scheduler.getBatch()!.tasks)[0].attempt).toBe(1);
  });
});
