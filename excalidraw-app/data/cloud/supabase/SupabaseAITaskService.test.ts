import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSupabaseAITaskService } from "./SupabaseAITaskService";

const makeBuilder = (result: { data?: unknown; error?: unknown }) => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const builder: Record<string, unknown> = {};
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  for (const method of [
    "insert",
    "update",
    "select",
    "eq",
    "is",
    "order",
    "limit",
  ]) {
    builder[method] = record(method);
  }
  builder.single = (...args: unknown[]) => {
    calls.push({ method: "single", args });
    return Promise.resolve(result);
  };
  builder.then = (
    resolve: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  (builder as { __calls: typeof calls }).__calls = calls;
  return builder;
};

const mockFrom = vi.fn();
const mockGetUser = vi.fn();

vi.mock("./client", () => ({
  getSupabaseClient: () => ({
    from: mockFrom,
    auth: { getUser: mockGetUser },
  }),
  hasSupabaseConfig: () => true,
}));

const taskRow = {
  id: "task-1",
  owner_id: "owner-1",
  scene_id: "scene-1",
  feature_source: "workbench",
  media_type: "image",
  mode: "text-to-image",
  status: "succeeded",
  model_id: "model-1",
  model_label: "Model",
  provider_label: "Provider",
  prompt_summary: "Draw a whiteboard",
  negative_prompt_summary: null,
  params: { size: "1024x1024" },
  input_asset_ids: [],
  output_asset_ids: ["asset-1"],
  source_element_ids: [],
  inserted_element_ids: ["element-1"],
  error_code: null,
  error_message: null,
  submitted_at: "2026-06-23T01:00:00.000Z",
  completed_at: "2026-06-23T01:00:02.000Z",
  created_at: "2026-06-23T01:00:00.000Z",
  updated_at: "2026-06-23T01:00:02.000Z",
  deleted_at: null,
};

describe("SupabaseAITaskService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({
      data: { user: { id: "owner-1" } },
      error: null,
    });
  });

  it("creates owner-scoped AI task records", async () => {
    const builder = makeBuilder({ data: taskRow, error: null });
    mockFrom.mockReturnValue(builder);

    const result = await createSupabaseAITaskService().create({
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
      params: { size: "1024x1024" },
      inputAssetIds: [],
      outputAssetIds: ["asset-1"],
      sourceElementIds: [],
      insertedElementIds: ["element-1"],
      errorCode: null,
      errorMessage: null,
      submittedAt: Date.parse("2026-06-23T01:00:00.000Z"),
      completedAt: Date.parse("2026-06-23T01:00:02.000Z"),
    });

    expect(result).toMatchObject({
      id: "task-1",
      ownerId: "owner-1",
      outputAssetIds: ["asset-1"],
    });
    const calls = (
      builder as { __calls: Array<{ method: string; args: unknown[] }> }
    ).__calls;
    const insert = calls.find((call) => call.method === "insert");
    expect(insert?.args[0]).toMatchObject({
      owner_id: "owner-1",
      scene_id: "scene-1",
      output_asset_ids: ["asset-1"],
    });
  });

  it("lists recent tasks with optional scene filtering", async () => {
    const builder = makeBuilder({ data: [taskRow], error: null });
    mockFrom.mockReturnValue(builder);

    const result = await createSupabaseAITaskService().list({
      sceneId: "scene-1",
      limit: 5,
    });

    expect(result).toHaveLength(1);
    const calls = (
      builder as { __calls: Array<{ method: string; args: unknown[] }> }
    ).__calls;
    expect(calls).toEqual(
      expect.arrayContaining([
        { method: "eq", args: ["scene_id", "scene-1"] },
        { method: "limit", args: [5] },
      ]),
    );
  });

  it("soft-deletes task records", async () => {
    const builder = makeBuilder({ data: null, error: null });
    mockFrom.mockReturnValue(builder);

    await createSupabaseAITaskService().remove("task-1");

    const calls = (
      builder as { __calls: Array<{ method: string; args: unknown[] }> }
    ).__calls;
    expect(calls.find((call) => call.method === "update")?.args[0]).toEqual({
      deleted_at: expect.any(String),
    });
    expect(calls).toEqual(
      expect.arrayContaining([{ method: "eq", args: ["id", "task-1"] }]),
    );
  });
});
