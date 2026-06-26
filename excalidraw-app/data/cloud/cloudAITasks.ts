import { dataURLToFile } from "@excalidraw/excalidraw/data/blob";

import type { FileId } from "@excalidraw/element/types";
import type { DataURL } from "@excalidraw/excalidraw/types";

import type {
  AIImageGenerationMode,
  AIImageGenerationOutput,
  AIImageGenerationParams,
  AIImageSource,
  AIModelMediaType,
} from "../../ai/types";

import type { AITaskStatus, AssetRef, CloudBackend } from "./types";

export type CloudAITaskRunStatus = "success" | "failed" | "canceled";

export type CloudAITaskOutput = {
  output: AIImageGenerationOutput;
  insertedElementId: string;
  insertedFileId?: FileId;
};

export type CloudAITaskRun = {
  submittedAt: string;
  completedAt: string;
  mediaType: AIModelMediaType;
  mode: AIImageGenerationMode | "text-to-video" | "text-to-audio";
  status: CloudAITaskRunStatus;
  model: {
    id: string;
    name: string;
    siteName: string;
  };
  prompt: string;
  negativePrompt?: string;
  params: AIImageGenerationParams;
  sources?: AIImageSource[];
  sourceElementIds?: string[];
  outputs?: CloudAITaskOutput[];
  errorCode?: string;
  errorMessage?: string;
};

const MAX_PROMPT_SUMMARY_LENGTH = 600;

const isLocalImageDataURL = (value: string): value is DataURL =>
  value.startsWith("data:image/");

const redactPrompt = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const redacted = trimmed.replace(
    /\b(api[-_\s]?key|authorization|token|secret|password)\b\s*[:=]\s*\S+/gi,
    "$1: [redacted]",
  );

  return redacted.length > MAX_PROMPT_SUMMARY_LENGTH
    ? `${redacted.slice(0, MAX_PROMPT_SUMMARY_LENGTH)}...`
    : redacted;
};

const toTaskStatus = (status: CloudAITaskRunStatus): AITaskStatus => {
  if (status === "success") {
    return "succeeded";
  }
  if (status === "canceled") {
    return "cancelled";
  }
  return "failed";
};

const parseIsoMs = (value: string): number => {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Date.now() : ms;
};

const collectSourceElementIds = (run: CloudAITaskRun): string[] => {
  const ids = new Set<string>(run.sourceElementIds ?? []);
  for (const source of run.sources ?? []) {
    const sourceElementIds = (source as { elementIds?: string[] }).elementIds;
    if (sourceElementIds?.length) {
      sourceElementIds.forEach((id: string) => ids.add(id));
    } else if (source.elementId) {
      ids.add(source.elementId);
    }
  }
  return [...ids];
};

const listExistingAssetsByFileId = async (
  backend: CloudBackend,
  sceneId: string,
): Promise<Map<string, AssetRef>> => {
  try {
    const assets = await backend.assets.listByScene(sceneId);
    return new Map(
      assets
        .filter((asset) => asset.fileId)
        .map((asset) => [asset.fileId as string, asset]),
    );
  } catch {
    return new Map();
  }
};

const uploadInputAssets = async (input: {
  backend: CloudBackend;
  sceneId: string;
  sources: readonly AIImageSource[];
}): Promise<string[]> => {
  if (!input.sources.length || !input.backend.capabilities.assetStorage) {
    return [];
  }

  const existingAssets = await listExistingAssetsByFileId(
    input.backend,
    input.sceneId,
  );

  const assetIds = await Promise.all(
    input.sources.map(async (source) => {
      if (!source.fileId || !isLocalImageDataURL(source.dataURL)) {
        return null;
      }

      const existing = existingAssets.get(source.fileId);
      if (existing) {
        return existing.id;
      }

      const uploaded = await input.backend.assets.upload({
        blob: dataURLToFile(source.dataURL, source.fileId),
        type: "image",
        sceneId: input.sceneId,
        fileId: source.fileId,
        mimeType: source.file.type,
      });
      return uploaded.id;
    }),
  );

  return assetIds.filter((assetId): assetId is string => !!assetId);
};

const uploadOutputAssets = async (input: {
  backend: CloudBackend;
  sceneId: string;
  outputs: readonly CloudAITaskOutput[];
}): Promise<string[]> => {
  if (!input.outputs.length || !input.backend.capabilities.assetStorage) {
    return [];
  }

  const assetIds = await Promise.all(
    input.outputs.map(async (output) => {
      if (
        !output.insertedFileId ||
        !isLocalImageDataURL(output.output.dataURL)
      ) {
        return null;
      }

      const uploaded = await input.backend.assets.upload({
        blob: dataURLToFile(output.output.dataURL, output.insertedFileId),
        type: "ai-output",
        sceneId: input.sceneId,
        fileId: output.insertedFileId,
        mimeType: output.output.mimeType,
      });
      return uploaded.id;
    }),
  );

  return assetIds.filter((assetId): assetId is string => !!assetId);
};

export const recordCloudAITask = async (input: {
  backend: CloudBackend;
  sceneId: string | null;
  run: CloudAITaskRun;
}): Promise<void> => {
  if (!input.sceneId || !input.backend.capabilities.aiTasks) {
    return;
  }

  const [inputAssetIds, outputAssetIds] = await Promise.all([
    uploadInputAssets({
      backend: input.backend,
      sceneId: input.sceneId,
      sources: input.run.sources ?? [],
    }),
    input.run.status === "success"
      ? uploadOutputAssets({
          backend: input.backend,
          sceneId: input.sceneId,
          outputs: input.run.outputs ?? [],
        })
      : Promise.resolve([]),
  ]);

  await input.backend.aiTasks.create({
    sceneId: input.sceneId,
    featureSource: "workbench",
    mediaType: input.run.mediaType,
    mode: input.run.mode,
    status: toTaskStatus(input.run.status),
    modelId: input.run.model.id,
    modelLabel: input.run.model.name || null,
    providerLabel: input.run.model.siteName || null,
    promptSummary: redactPrompt(input.run.prompt) ?? "",
    negativePromptSummary: redactPrompt(input.run.negativePrompt),
    params: input.run.params,
    inputAssetIds,
    outputAssetIds,
    sourceElementIds: collectSourceElementIds(input.run),
    insertedElementIds: (input.run.outputs ?? []).map(
      (output) => output.insertedElementId,
    ),
    errorCode: input.run.errorCode ?? null,
    errorMessage: redactPrompt(input.run.errorMessage) ?? null,
    submittedAt: parseIsoMs(input.run.submittedAt),
    completedAt: parseIsoMs(input.run.completedAt),
  });
};
