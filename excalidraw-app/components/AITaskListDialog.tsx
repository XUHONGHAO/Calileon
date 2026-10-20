import React, { useCallback, useEffect, useState } from "react";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { CloseIcon } from "@excalidraw/excalidraw/components/icons";
import { t } from "@excalidraw/excalidraw/i18n";

import { getCloudBackend } from "../data/cloud";

import "./SceneListDialog.scss";

import {
  Badge,
  Callout,
  DialogActions,
  ListRow,
  UiButton,
  confirmAction,
} from "./ui";

import type { UiTone } from "./ui";
import type { AITaskRecord, SceneRecord } from "../data/cloud";

export interface AITaskListDialogProps {
  open: boolean;
  onClose: () => void;
  onBack?: () => void;
  onOpenScene: (scene: SceneRecord) => void;
}

const TASK_LIMIT = 50;

const TASK_STATUS_TONE: Partial<Record<AITaskRecord["status"], UiTone>> = {
  succeeded: "success",
  failed: "danger",
  running: "info",
  queued: "info",
};

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
    if (
      busyTaskId ||
      !(await confirmAction(t("cloud.aiTasks.deleteConfirm")))
    ) {
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

  const hasThumbnails = tasks.some((task) => !!assetUrls[task.id]);

  const renderStatus = (message: string) => (
    <p className="SceneListDialog__status" role="status">
      {message}
    </p>
  );

  return (
    <Dialog
      className="SceneListDialogModal"
      size="small"
      closeOnClickOutside={false}
      onCloseRequest={onClose}
      title={t("cloud.aiTasks.title")}
    >
      <div className="SceneListDialog">
        <UiButton
          className="SceneListDialog__close"
          variant="ghost"
          size="sm"
          iconOnly
          icon={CloseIcon}
          aria-label={t("buttons.close")}
          title={t("buttons.close")}
          onClick={onClose}
        />

        <p className="SceneListDialog__description">
          {t("cloud.aiTasks.description")}
        </p>

        {error && <Callout tone="danger">{error}</Callout>}

        {loading ? (
          renderStatus(t("cloud.aiTasks.loading"))
        ) : tasks.length === 0 ? (
          renderStatus(t("cloud.aiTasks.empty"))
        ) : (
          <ul className="SceneListDialog__list">
            {tasks.map((task) => {
              const isBusy = busyTaskId === task.id;
              const assetUrl = assetUrls[task.id];
              const title = task.promptSummary || t("cloud.aiTasks.untitled");

              return (
                <ListRow
                  key={task.id}
                  leading={
                    hasThumbnails &&
                    (assetUrl ? (
                      <img
                        className="SceneListDialog__thumbnail"
                        src={assetUrl}
                        alt=""
                      />
                    ) : (
                      <span
                        className="SceneListDialog__thumbnail"
                        aria-hidden="true"
                      />
                    ))
                  }
                  title={<span title={title}>{title}</span>}
                  badges={
                    <Badge tone={TASK_STATUS_TONE[task.status] ?? "neutral"}>
                      {getTaskStatusLabel(task)}
                    </Badge>
                  }
                  meta={[
                    task.mode,
                    task.modelLabel || task.modelId,
                    t("cloud.aiTasks.updatedAt", {
                      date: formatUpdatedAt(task.completedAt || task.updatedAt),
                    }),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  actions={
                    <UiButton
                      size="sm"
                      loading={isBusy}
                      disabled={!!busyTaskId}
                      onClick={() => void handleOpenScene(task)}
                    >
                      {t("cloud.aiTasks.openScene")}
                    </UiButton>
                  }
                  menu={[
                    {
                      label: t("cloud.aiTasks.delete"),
                      onSelect: () => void handleRemove(task),
                      danger: true,
                      disabled: !!busyTaskId,
                    },
                  ]}
                />
              );
            })}
          </ul>
        )}

        <DialogActions
          leading={
            onBack && (
              <UiButton variant="ghost" onClick={onBack} disabled={loading}>
                {t("cloud.scenes.back")}
              </UiButton>
            )
          }
        >
          <UiButton onClick={() => void loadTasks()} disabled={loading}>
            {t("cloud.scenes.refresh")}
          </UiButton>
        </DialogActions>
      </div>
    </Dialog>
  );
};
