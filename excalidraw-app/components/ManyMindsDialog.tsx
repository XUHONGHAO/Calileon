import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { t } from "@excalidraw/excalidraw/i18n";
import { getSelectedElements } from "@excalidraw/element";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  DataURL,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { InitializedExcalidrawImageElement } from "@excalidraw/element/types";

import {
  DEFAULT_AI_REFERENCE_EXPORT_OPTIONS,
  createImportedReferenceSource,
  exportSelectionToReferenceSource,
} from "../ai/canvasExport";
import { loadAIImageConfig } from "../ai/config";
import { dataURLToFile, fileToDataURL } from "../ai/imageCanvas";
import {
  appendAIGenerationLog,
  createAIGenerationLogEntry,
  createErrorResponseDetails,
  createSuccessResponseDetails,
} from "../ai/generationLog";
import {
  insertManyMindsGroupIntoCanvas,
  insertManyMindsTaskIntoCanvas,
  insertManyMindsTasksIntoCanvas,
  replaceManyMindsSourceImage,
} from "../ai/manyMindsCanvas";
import {
  listManyMindsBatches,
  loadManyMindsAsset,
  saveManyMindsAsset,
  saveManyMindsBatch,
} from "../ai/manyMindsPersistence";
import {
  BUILTIN_MANY_MINDS_PERSPECTIVES,
  createCustomManyMindsPerspective,
  deleteCustomManyMindsPerspective,
  loadCustomManyMindsPerspectives,
  saveCustomManyMindsPerspectives,
} from "../ai/manyMindsPerspectives";
import { ManyMindsScheduler } from "../ai/manyMindsScheduler";
import { createManyMindsBatch, createManyMindsId } from "../ai/manyMindsTypes";
import { generateImagesWithOpenAIAdapter } from "../ai/openAIImageAdapter";

import "./ManyMindsDialog.scss";

import type { AIImageSource } from "../ai/types";
import type {
  ManyMindsBatch,
  ManyMindsInputKind,
  ManyMindsPerspective,
  ManyMindsTask,
} from "../ai/manyMindsTypes";

const COUNTS = [2, 4, 6, 9] as const;
const DEFAULT_PARAMS = { size: "1024x1024", n: 1 };

type Props = {
  open: boolean;
  onClose: () => void;
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  persistenceScopeId: string | null;
};

const blobToPreviewURL = (blob: Blob) => URL.createObjectURL(blob);

export const ManyMindsDialog = ({
  open,
  onClose,
  excalidrawAPI,
  persistenceScopeId,
}: Props) => {
  const config = useMemo(
    () =>
      open
        ? loadAIImageConfig()
        : { baseURL: "", apiKey: "", defaultModel: "", models: [] },
    [open],
  );
  const imageModels = useMemo(
    () => config.models.filter((model) => model.mediaType === "image"),
    [config],
  );
  const [modelId, setModelId] = useState("");
  const [inputKind, setInputKind] = useState<ManyMindsInputKind>("image");
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState<typeof COUNTS[number]>(4);
  const [customPerspectives, setCustomPerspectives] = useState<
    ManyMindsPerspective[]
  >([]);
  const [perspectiveIds, setPerspectiveIds] = useState<string[]>([]);
  const [batch, setBatch] = useState<ManyMindsBatch | null>(null);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [customName, setCustomName] = useState("");
  const [customPrompt, setCustomPrompt] = useState("");
  const [branchParentTaskId, setBranchParentTaskId] = useState<string | null>(
    null,
  );
  const schedulerRef = useRef<ManyMindsScheduler | null>(null);
  const previewURLsRef = useRef<string[]>([]);

  const perspectives = useMemo(
    () => [...BUILTIN_MANY_MINDS_PERSPECTIVES, ...customPerspectives],
    [customPerspectives],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    setCustomPerspectives(loadCustomManyMindsPerspectives());
    setPerspectiveIds(
      BUILTIN_MANY_MINDS_PERSPECTIVES.slice(0, count).map((item) => item.id),
    );
    setModelId((current) => current || imageModels[0]?.id || "");
  }, [count, imageModels, open]);

  const refreshPreviews = useCallback(
    async (nextBatch: ManyMindsBatch | null) => {
      previewURLsRef.current.forEach(URL.revokeObjectURL);
      previewURLsRef.current = [];
      if (!nextBatch || !persistenceScopeId) {
        setPreviews({});
        return;
      }
      const entries = await Promise.all(
        nextBatch.taskOrder.map(async (taskId) => {
          const output = nextBatch.tasks[taskId]?.output;
          if (!output) {
            return null;
          }
          const stored = await loadManyMindsAsset(
            persistenceScopeId,
            output.assetId,
          );
          if (!stored) {
            return null;
          }
          const url = blobToPreviewURL(stored.blob);
          previewURLsRef.current.push(url);
          return [taskId, url] as const;
        }),
      );
      setPreviews(
        Object.fromEntries(
          entries.filter(
            (entry): entry is readonly [string, string] => !!entry,
          ),
        ),
      );
    },
    [persistenceScopeId],
  );

  const createScheduler = useCallback(() => {
    if (!persistenceScopeId) {
      return null;
    }
    const scheduler = new ManyMindsScheduler({
      onPersist: async (nextBatch) => {
        await saveManyMindsBatch(persistenceScopeId, nextBatch);
      },
      executeTask: async ({ batch: currentBatch, task, signal }) => {
        const submittedAt = new Date().toISOString();
        const currentConfig = loadAIImageConfig();
        const model = currentConfig.models.find(
          (item) => item.id === task.modelId,
        );
        if (!model || model.mediaType !== "image") {
          throw new Error(t("ai.manyMinds.errors.modelUnavailable"));
        }
        if (!model.apiKey || !model.baseURL) {
          throw new Error(t("ai.manyMinds.errors.modelUnavailable"));
        }
        const sources: AIImageSource[] = [];
        for (const inputAsset of currentBatch.input.assets) {
          const stored = await loadManyMindsAsset(
            persistenceScopeId,
            inputAsset.assetId,
          );
          if (!stored) {
            throw new Error(t("ai.manyMinds.errors.inputMissing"));
          }
          const dataURL = (await fileToDataURL(
            new File([stored.blob], `${inputAsset.assetId}.png`, {
              type: stored.ref.mimeType,
            }),
          )) as DataURL;
          sources.push({
            elementId:
              currentBatch.input.sourceElementIds[0] || inputAsset.assetId,
            file: dataURLToFile(
              dataURL,
              `${inputAsset.assetId}.png`,
              stored.ref.mimeType,
            ),
            dataURL,
            width: stored.ref.width,
            height: stored.ref.height,
          });
        }
        const mode = sources.length ? "image-to-image" : "text-to-image";
        if (!model.capabilities.includes(mode)) {
          throw new Error(t("ai.manyMinds.errors.modelUnavailable"));
        }
        const effectivePrompt = [
          currentBatch.input.prompt,
          task.perspective.prompt,
        ]
          .filter(Boolean)
          .join("\n\n");
        let outputs;
        try {
          outputs = await generateImagesWithOpenAIAdapter({
            config: {
              ...currentConfig,
              defaultModel: model.model,
              models: [
                model,
                ...currentConfig.models.filter((item) => item.id !== model.id),
              ],
            },
            mode,
            model: model.model,
            prompt: effectivePrompt,
            params: { ...task.params, n: 1 },
            sources: sources.length ? sources : undefined,
            signal,
          });
        } catch (error) {
          appendAIGenerationLog(
            createAIGenerationLogEntry({
              submittedAt,
              mediaType: "image",
              mode,
              status: signal.aborted ? "canceled" : "failed",
              model: {
                id: model.id,
                name: model.model,
                siteName: model.siteName,
              },
              prompt: effectivePrompt,
              params: { ...task.params, n: 1 },
              baseURL: model.baseURL,
              responseSummary: signal.aborted
                ? "Many Minds task cancelled"
                : "Many Minds task failed",
              responseDetails: {
                batchId: currentBatch.id,
                taskId: task.id,
                perspectiveId: task.perspective.id,
                error: createErrorResponseDetails(error),
              },
            }),
          );
          throw error;
        }
        const output = outputs[0];
        if (!output) {
          throw new Error(t("ai.manyMinds.errors.emptyOutput"));
        }
        const file = dataURLToFile(
          output.dataURL,
          `${task.id}.png`,
          output.mimeType,
        );
        const ref = {
          assetId: createManyMindsId("many-minds-asset"),
          role: "output" as const,
          mimeType: output.mimeType,
        };
        await saveManyMindsAsset(persistenceScopeId, {
          version: 1,
          ref,
          blob: file,
          createdAt: Date.now(),
        });
        appendAIGenerationLog(
          createAIGenerationLogEntry({
            submittedAt,
            mediaType: "image",
            mode,
            status: "success",
            model: {
              id: model.id,
              name: model.model,
              siteName: model.siteName,
            },
            prompt: effectivePrompt,
            params: { ...task.params, n: 1 },
            baseURL: model.baseURL,
            responseSummary: "Many Minds task succeeded",
            responseDetails: {
              batchId: currentBatch.id,
              taskId: task.id,
              perspectiveId: task.perspective.id,
              output: createSuccessResponseDetails(outputs),
            },
          }),
        );
        return ref;
      },
    });
    scheduler.subscribe((nextBatch) => {
      setBatch(nextBatch);
      void refreshPreviews(nextBatch);
    });
    schedulerRef.current?.dispose();
    schedulerRef.current = scheduler;
    return scheduler;
  }, [persistenceScopeId, refreshPreviews]);

  useEffect(
    () => () => {
      schedulerRef.current?.dispose();
      previewURLsRef.current.forEach(URL.revokeObjectURL);
    },
    [],
  );

  useEffect(() => {
    if (!open || !persistenceScopeId) {
      return;
    }
    let active = true;
    void listManyMindsBatches(persistenceScopeId).then((batches) => {
      if (!active || !batches[0]) {
        return;
      }
      const scheduler = createScheduler();
      scheduler?.hydrate(batches[0]);
      setMessage(t("ai.manyMinds.restoredNotice"));
    });
    return () => {
      active = false;
    };
  }, [createScheduler, open, persistenceScopeId]);

  const createInput = useCallback(async () => {
    if (!excalidrawAPI || !persistenceScopeId) {
      throw new Error(t("ai.manyMinds.errors.scopeUnavailable"));
    }
    if (branchParentTaskId && batch) {
      const parentTask = batch.tasks[branchParentTaskId];
      const parentOutput = parentTask?.output;
      if (!parentOutput) {
        throw new Error(t("ai.manyMinds.errors.inputMissing"));
      }
      return {
        kind: "vision-and-text" as const,
        prompt: prompt.trim(),
        sourceElementIds: [],
        assets: [{ ...parentOutput, role: "input" as const }],
        createdAt: Date.now(),
      };
    }
    const elements = excalidrawAPI.getSceneElements();
    const appState = excalidrawAPI.getAppState();
    const selected = getSelectedElements(elements, appState);
    if (
      (inputKind === "image" || inputKind === "vision-and-text") &&
      selected.length !== 1
    ) {
      throw new Error(t("ai.manyMinds.errors.selectOneImage"));
    }
    if (inputKind === "region" && !selected.length) {
      throw new Error(t("ai.manyMinds.errors.selectRegion"));
    }
    if (
      (inputKind === "text" || inputKind === "vision-and-text") &&
      !prompt.trim()
    ) {
      throw new Error(t("ai.manyMinds.errors.promptRequired"));
    }
    let source = null;
    if (inputKind === "image" || inputKind === "vision-and-text") {
      const image = selected[0];
      if (image.type !== "image" || !image.fileId) {
        throw new Error(t("ai.manyMinds.errors.selectOneImage"));
      }
      const file = excalidrawAPI.getFiles()[image.fileId];
      if (!file) {
        throw new Error(t("ai.manyMinds.errors.inputMissing"));
      }
      source = createImportedReferenceSource({
        element: image as InitializedExcalidrawImageElement,
        fileData: file,
        index: 0,
      });
    } else if (inputKind === "region") {
      source = (
        await exportSelectionToReferenceSource({
          elements: selected,
          appState,
          files: excalidrawAPI.getFiles(),
          options: DEFAULT_AI_REFERENCE_EXPORT_OPTIONS,
          index: 0,
        })
      ).source;
    }
    const assets = [];
    if (source) {
      const ref = {
        assetId: createManyMindsId("many-minds-asset"),
        role: "input" as const,
        mimeType: source.file.type || "image/png",
        width: source.width,
        height: source.height,
      };
      await saveManyMindsAsset(persistenceScopeId, {
        version: 1,
        ref,
        blob: source.file,
        createdAt: Date.now(),
      });
      assets.push(ref);
    }
    return {
      kind: inputKind,
      prompt: prompt.trim(),
      sourceElementIds: source ? source.elementIds || [source.elementId] : [],
      assets,
      createdAt: Date.now(),
    };
  }, [
    batch,
    branchParentTaskId,
    excalidrawAPI,
    inputKind,
    persistenceScopeId,
    prompt,
  ]);

  const startBatch = useCallback(async () => {
    try {
      const model = imageModels.find((item) => item.id === modelId);
      if (!model) {
        throw new Error(t("ai.manyMinds.errors.modelUnavailable"));
      }
      const chosen = perspectiveIds
        .slice(0, count)
        .map((id) => perspectives.find((item) => item.id === id))
        .filter((item): item is ManyMindsPerspective => !!item);
      if (chosen.length !== count) {
        throw new Error(t("ai.manyMinds.errors.perspectivesRequired"));
      }
      const input = await createInput();
      const next = createManyMindsBatch({
        persistenceScopeId: persistenceScopeId!,
        input,
        perspectives: chosen,
        modelId: model.id,
        params: DEFAULT_PARAMS,
        concurrency: 3,
        parentTaskId: branchParentTaskId || undefined,
      });
      const scheduler = createScheduler();
      setSelectedTaskIds([]);
      setMessage("");
      setBranchParentTaskId(null);
      scheduler?.start(next);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [
    count,
    createInput,
    createScheduler,
    imageModels,
    modelId,
    branchParentTaskId,
    persistenceScopeId,
    perspectiveIds,
    perspectives,
  ]);

  const successfulTasks =
    batch?.taskOrder
      .map((id) => batch.tasks[id])
      .filter(
        (task): task is ManyMindsTask =>
          task?.status === "succeeded" && !!task.output,
      ) || [];

  const resolveCanvasItems = useCallback(
    async (tasks: ManyMindsTask[]) => {
      if (!persistenceScopeId) {
        return [];
      }
      return (
        await Promise.all(
          tasks.map(async (task) => {
            const output =
              task.output &&
              (await loadManyMindsAsset(
                persistenceScopeId,
                task.output.assetId,
              ));
            if (!output || !batch) {
              return null;
            }
            return {
              task,
              asset: { ...output.ref, blob: output.blob },
              relation: {
                version: 1 as const,
                batchId: batch.id,
                taskId: task.id,
                perspectiveId: task.perspective.id,
                parentTaskId: task.parentTaskId,
                inputAssetIds: batch.input.assets.map((asset) => asset.assetId),
                outputAssetId: output.ref.assetId,
              },
            };
          }),
        )
      ).filter((item): item is NonNullable<typeof item> => !!item);
    },
    [batch, persistenceScopeId],
  );

  const insertTasks = useCallback(
    async (tasks: ManyMindsTask[], mode: "single" | "multi" | "all") => {
      if (!excalidrawAPI) {
        return;
      }
      const items = await resolveCanvasItems(tasks);
      if (!items.length) {
        return;
      }
      if (mode === "single") {
        await insertManyMindsTaskIntoCanvas({ excalidrawAPI, item: items[0] });
      } else if (mode === "all") {
        await insertManyMindsGroupIntoCanvas({
          excalidrawAPI,
          items,
          sourceElementIds: batch?.input.sourceElementIds,
        });
      } else {
        await insertManyMindsTasksIntoCanvas({
          excalidrawAPI,
          items,
          sourceElementIds: batch?.input.sourceElementIds,
        });
      }
    },
    [batch?.input.sourceElementIds, excalidrawAPI, resolveCanvasItems],
  );

  const addCustomPerspective = () => {
    const created = createCustomManyMindsPerspective({
      name: customName,
      prompt: customPrompt,
    });
    if (!created) {
      return;
    }
    const next = saveCustomManyMindsPerspectives([
      ...customPerspectives,
      created,
    ]);
    setCustomPerspectives(next);
    setCustomName("");
    setCustomPrompt("");
  };

  if (!open) {
    return null;
  }
  return (
    <Dialog
      className="ManyMindsDialog"
      title={t("ai.manyMinds.title")}
      size="wide"
      onCloseRequest={onClose}
    >
      <div className="ManyMinds" aria-label={t("ai.manyMinds.title")}>
        <section className="ManyMinds__setup">
          <label>
            {t("ai.manyMinds.inputKind")}
            <select
              value={inputKind}
              onChange={(event) =>
                setInputKind(event.target.value as ManyMindsInputKind)
              }
            >
              <option value="image">{t("ai.manyMinds.inputs.image")}</option>
              <option value="region">{t("ai.manyMinds.inputs.region")}</option>
              <option value="text">{t("ai.manyMinds.inputs.text")}</option>
              <option value="vision-and-text">
                {t("ai.manyMinds.inputs.visionAndText")}
              </option>
            </select>
          </label>
          <label>
            {t("ai.manyMinds.prompt")}
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <div className="ManyMinds__row">
            <label>
              {t("ai.manyMinds.count")}
              <select
                value={count}
                onChange={(event) =>
                  setCount(Number(event.target.value) as typeof COUNTS[number])
                }
              >
                {COUNTS.map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label>
              {t("ai.manyMinds.model")}
              <select
                value={modelId}
                onChange={(event) => setModelId(event.target.value)}
              >
                {imageModels.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label || model.model}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <fieldset>
            <legend>{t("ai.manyMinds.perspectives")}</legend>
            <div className="ManyMinds__perspectives">
              {Array.from({ length: count }, (_, index) => (
                <select
                  aria-label={`${t("ai.manyMinds.perspective")} ${index + 1}`}
                  key={index}
                  value={perspectiveIds[index] || ""}
                  onChange={(event) =>
                    setPerspectiveIds((current) => {
                      const next = [...current];
                      next[index] = event.target.value;
                      return next;
                    })
                  }
                >
                  {perspectives.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              ))}
            </div>
          </fieldset>
          <details>
            <summary>{t("ai.manyMinds.customPerspective")}</summary>
            <input
              aria-label={t("ai.manyMinds.customName")}
              value={customName}
              onChange={(event) => setCustomName(event.target.value)}
            />
            <textarea
              aria-label={t("ai.manyMinds.customPrompt")}
              value={customPrompt}
              onChange={(event) => setCustomPrompt(event.target.value)}
            />
            <button onClick={addCustomPerspective}>
              {t("ai.manyMinds.addPerspective")}
            </button>
            {customPerspectives.map((item) => (
              <button
                key={item.id}
                onClick={() =>
                  setCustomPerspectives(
                    deleteCustomManyMindsPerspective(item.id),
                  )
                }
              >
                {t("ai.manyMinds.deletePerspective", { name: item.name })}
              </button>
            ))}
          </details>
          <button
            className="ManyMinds__primary"
            onClick={() => void startBatch()}
            disabled={!persistenceScopeId || !imageModels.length}
          >
            {t("ai.manyMinds.generate", { count })}
          </button>
          {message && <p role="status">{message}</p>}
        </section>
        {batch && (
          <section>
            <div className="ManyMinds__batchHeader">
              <strong>
                {t("ai.manyMinds.progress", {
                  done: successfulTasks.length,
                  total: batch.taskOrder.length,
                })}
              </strong>
              <button onClick={() => schedulerRef.current?.cancelBatch()}>
                {t("ai.manyMinds.cancelBatch")}
              </button>
            </div>
            <div
              className={`ManyMinds__grid ManyMinds__grid--${batch.taskOrder.length}`}
            >
              {batch.taskOrder.map((taskId) => {
                const task = batch.tasks[taskId];
                if (!task) {
                  return null;
                }
                return (
                  <article
                    className={`ManyMinds__task is-${task.status}`}
                    key={task.id}
                    aria-label={`${task.perspective.name}: ${t(
                      `ai.manyMinds.status.${task.status}`,
                    )}`}
                  >
                    <label>
                      <input
                        type="checkbox"
                        checked={selectedTaskIds.includes(task.id)}
                        disabled={task.status !== "succeeded"}
                        onChange={(event) =>
                          setSelectedTaskIds((current) =>
                            event.target.checked
                              ? [...current, task.id]
                              : current.filter((id) => id !== task.id),
                          )
                        }
                      />
                      {task.perspective.name}
                    </label>
                    {previews[task.id] && (
                      <img
                        src={previews[task.id]}
                        alt={task.perspective.name}
                      />
                    )}
                    <p>{t(`ai.manyMinds.status.${task.status}`)}</p>
                    {task.error && <p role="alert">{task.error}</p>}
                    {task.cancellationMayHaveIncurredCost && (
                      <p>{t("ai.manyMinds.costWarning")}</p>
                    )}
                    <select
                      value={task.modelId}
                      disabled={
                        task.status === "running" || task.status === "succeeded"
                      }
                      onChange={(event) =>
                        schedulerRef.current?.updateTask(task.id, {
                          modelId: event.target.value,
                        })
                      }
                    >
                      {imageModels.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.label || model.model}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label={t("ai.manyMinds.perspective")}
                      value={task.perspective.id}
                      disabled={
                        task.status === "running" || task.status === "succeeded"
                      }
                      onChange={(event) => {
                        const perspective = perspectives.find(
                          (item) => item.id === event.target.value,
                        );
                        if (perspective) {
                          schedulerRef.current?.updateTask(task.id, {
                            perspective,
                          });
                        }
                      }}
                    >
                      {perspectives.map((perspective) => (
                        <option key={perspective.id} value={perspective.id}>
                          {perspective.name}
                        </option>
                      ))}
                    </select>
                    <div className="ManyMinds__taskActions">
                      {["queued", "running", "interrupted"].includes(
                        task.status,
                      ) && (
                        <button
                          onClick={() =>
                            schedulerRef.current?.cancelTask(task.id)
                          }
                        >
                          {t("ai.manyMinds.cancel")}
                        </button>
                      )}
                      {["failed", "cancelled", "interrupted"].includes(
                        task.status,
                      ) && (
                        <button
                          onClick={() => {
                            if (schedulerRef.current?.retryTask(task.id)) {
                              schedulerRef.current.start();
                            }
                          }}
                        >
                          {t("ai.manyMinds.retry")}
                        </button>
                      )}
                      {task.status === "succeeded" && (
                        <>
                          <button
                            onClick={() => void insertTasks([task], "single")}
                          >
                            {t("ai.manyMinds.insertOne")}
                          </button>
                          <button
                            onClick={() =>
                              void (async () => {
                                const items = await resolveCanvasItems([task]);
                                const sourceId =
                                  batch.input.sourceElementIds[0];
                                if (items[0] && sourceId && excalidrawAPI) {
                                  await replaceManyMindsSourceImage({
                                    excalidrawAPI,
                                    sourceElementId: sourceId,
                                    item: items[0],
                                  });
                                }
                              })()
                            }
                          >
                            {t("ai.manyMinds.replace")}
                          </button>
                          <button
                            onClick={() => {
                              setPrompt("");
                              setInputKind("vision-and-text");
                              setBranchParentTaskId(task.id);
                              setMessage(t("ai.manyMinds.branchReady"));
                            }}
                          >
                            {t("ai.manyMinds.branch")}
                          </button>
                        </>
                      )}
                      <button
                        onClick={() =>
                          schedulerRef.current?.deleteTask(task.id)
                        }
                      >
                        {t("ai.manyMinds.delete")}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
            <div className="ManyMinds__footer">
              <button
                disabled={!selectedTaskIds.length}
                onClick={() =>
                  void insertTasks(
                    selectedTaskIds
                      .map((id) => batch.tasks[id])
                      .filter(Boolean),
                    "multi",
                  )
                }
              >
                {t("ai.manyMinds.insertSelected")}
              </button>
              <button
                disabled={!successfulTasks.length}
                onClick={() => void insertTasks(successfulTasks, "all")}
              >
                {t("ai.manyMinds.insertAll")}
              </button>
            </div>
          </section>
        )}
      </div>
    </Dialog>
  );
};
