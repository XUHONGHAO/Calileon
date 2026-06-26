import React, { useCallback, useEffect, useState } from "react";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { Button } from "@excalidraw/excalidraw/components/Button";
import { CloseIcon } from "@excalidraw/excalidraw/components/icons";
import { t } from "@excalidraw/excalidraw/i18n";

import { getCloudBackend } from "../data/cloud";

import "./SceneListDialog.scss";

import type { AITaskRecord, SceneRecord } from "../data/cloud";

export interface AITaskListDialogProps {
  open: boolean;
  onClose: () => void;
  onBack?: () => void;
  onOpenScene: (scene: SceneRecord) => void;
}

const TASK_LIMIT = 50;

const formatUpdatedAt = (value: number) => {
  if (!value) {
    return t("cloud.scenes.unknownUpdatedAt");
  }
  return new Date(value).toLocaleString();
};

const getTaskStatusLabel = (task: AITaskRecord) => {
  if (task.status === "succeeded") {
    return t("cloud.aiTasks.statusSucceeded");
  }
  if (task.status === "failed") {
    return t("cloud.aiTasks.statusFailed");
  }
  if (task.status === "cancelled") {
    return t("cloud.aiTasks.statusCancelled");
  }
  if (task.status === "running") {
    return t("cloud.aiTasks.statusRunning");
  }
  return t("cloud.aiTasks.statusQueued");
};

export const AITaskListDialog: React.FC<AITaskListDialogProps> = ({
  open,
  onClose,
  onBack,
  onOpenScene,
}) => {
  const [tasks, setTasks] = useState<AITaskRecord[]>([]);
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const backend = getCloudBackend();

  const loadTasks = useCallback(async () => {
    if (!backend.capabilities.aiTasks) {
      setTasks([]);
      setAssetUrls({});
      setError(t("cloud.aiTasks.unavailable"));
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const nextTasks = await backend.aiTasks.list({ limit: TASK_LIMIT });
      setTasks(nextTasks);

      const thumbnailEntries = await Promise.all(
        nextTasks.map(async (task) => {
          const assetId = task.outputAssetIds[0];
          if (!assetId) {
            return null;
          }
          try {
            return [task.id, await backend.assets.getUrl(assetId)] as const;
          } catch {
            return null;
          }
        }),
      );

      setAssetUrls(
        Object.fromEntries(
          thumbnailEntries.filter(
            (entry): entry is readonly [string, string] => !!entry,
          ),
        ),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("cloud.aiTasks.genericError"),
      );
    } finally {
      setLoading(false);
    }
  }, [backend]);

  useEffect(() => {
    if (!open) {
      return;
    }
    void loadTasks();
  }, [loadTasks, open]);

  if (!open) {
    return null;
  }

  const handleOpenScene = async (task: AITaskRecord) => {
    if (busyTaskId) {
      return;
    }

    setBusyTaskId(task.id);
    setError(null);
    try {
      const scene = await backend.scenes.load(task.sceneId);
      onOpenScene(scene);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("cloud.aiTasks.genericError"),
      );
    } finally {
      setBusyTaskId(null);
    }
  };

  const handleRemove = async (task: AITaskRecord) => {
    if (busyTaskId || !window.confirm(t("cloud.aiTasks.deleteConfirm"))) {
      return;
    }

    setBusyTaskId(task.id);
    setError(null);
    try {
      await backend.aiTasks.remove(task.id);
      await loadTasks();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("cloud.aiTasks.genericError"),
      );
    } finally {
      setBusyTaskId(null);
    }
  };

  return (
    <Dialog
      className="SceneListDialogModal"
      size="small"
      closeOnClickOutside={false}
      onCloseRequest={onClose}
      title={t("cloud.aiTasks.title")}
    >
      <div className="SceneListDialog">
        <button
          className="SceneListDialog__close"
          type="button"
          aria-label={t("buttons.close")}
          title={t("buttons.close")}
          onClick={onClose}
        >
          {CloseIcon}
        </button>

        <div className="SceneListDialog__toolbar">
          <p>{t("cloud.aiTasks.description")}</p>
          <div className="SceneListDialog__toolbarActions">
            {onBack && (
              <Button onSelect={onBack} disabled={loading}>
                {t("cloud.scenes.back")}
              </Button>
            )}
            <Button onSelect={() => void loadTasks()} disabled={loading}>
              {t("cloud.scenes.refresh")}
            </Button>
          </div>
        </div>

        {error && (
          <p className="SceneListDialog__error" role="alert">
            {error}
          </p>
        )}

        {loading ? (
          <div className="SceneListDialog__status">
            {t("cloud.aiTasks.loading")}
          </div>
        ) : tasks.length === 0 ? (
          <div className="SceneListDialog__status">
            {t("cloud.aiTasks.empty")}
          </div>
        ) : (
          <ul className="SceneListDialog__list">
            {tasks.map((task) => {
              const isBusy = busyTaskId === task.id;
              const assetUrl = assetUrls[task.id];

              return (
                <li
                  className={
                    assetUrl
                      ? "SceneListDialog__item SceneListDialog__item--withThumbnail"
                      : "SceneListDialog__item"
                  }
                  key={task.id}
                >
                  {assetUrl && (
                    <img
                      className="SceneListDialog__thumbnail"
                      src={assetUrl}
                      alt=""
                    />
                  )}
                  <div className="SceneListDialog__details">
                    <strong title={task.promptSummary}>
                      {task.promptSummary || t("cloud.aiTasks.untitled")}
                    </strong>
                    <span>
                      {getTaskStatusLabel(task)} {" - "} {task.mode} {" - "}
                      {task.modelLabel || task.modelId}
                    </span>
                    <span>
                      {t("cloud.aiTasks.updatedAt", {
                        date: formatUpdatedAt(
                          task.completedAt || task.updatedAt,
                        ),
                      })}
                    </span>
                  </div>
                  <div className="SceneListDialog__actions">
                    <Button
                      onSelect={() => void handleOpenScene(task)}
                      disabled={!!busyTaskId}
                    >
                      {t("cloud.aiTasks.openScene")}
                    </Button>
                    <Button
                      onSelect={() => void handleRemove(task)}
                      disabled={!!busyTaskId || isBusy}
                    >
                      {t("cloud.aiTasks.delete")}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
};
