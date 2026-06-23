import { Button } from "@excalidraw/excalidraw/components/Button";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { CloseIcon } from "@excalidraw/excalidraw/components/icons";
import { t } from "@excalidraw/excalidraw/i18n";
import React, { useCallback, useEffect, useState } from "react";

import { getCloudBackend } from "../data/cloud";

import "./SceneListDialog.scss";

import type { SceneRecord, SceneSummary } from "../data/cloud";

export interface SceneListDialogProps {
  open: boolean;
  onClose: () => void;
  onBack?: () => void;
  onOpenScene: (scene: SceneRecord) => void | Promise<void>;
}

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : t("cloud.scenes.genericError");

const formatUpdatedAt = (updatedAt: number) => {
  if (!updatedAt) {
    return t("cloud.scenes.unknownUpdatedAt");
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(updatedAt);
};

export const SceneListDialog: React.FC<SceneListDialogProps> = ({
  open,
  onClose,
  onBack,
  onOpenScene,
}) => {
  const [scenes, setScenes] = useState<SceneSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busySceneId, setBusySceneId] = useState<string | null>(null);
  const [renamingSceneId, setRenamingSceneId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");

  const backend = getCloudBackend();

  const loadScenes = useCallback(async () => {
    if (!backend.capabilities.sceneStorage) {
      setScenes([]);
      setError(t("cloud.scenes.unavailable"));
      return;
    }

    setLoading(true);
    setError(null);
    try {
      setScenes(await backend.scenes.list({ sort: "updatedAt" }));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [backend]);

  useEffect(() => {
    if (open) {
      void loadScenes();
      return;
    }

    setError(null);
    setBusySceneId(null);
    setRenamingSceneId(null);
    setRenameTitle("");
  }, [loadScenes, open]);

  if (!open) {
    return null;
  }

  const handleOpenScene = async (id: string) => {
    setBusySceneId(id);
    setError(null);
    try {
      const scene = await backend.scenes.load(id);
      await onOpenScene(scene);
      onClose();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusySceneId(null);
    }
  };

  const handleRename = async (id: string) => {
    const nextTitle = renameTitle.trim();
    if (!nextTitle) {
      return;
    }

    setBusySceneId(id);
    setError(null);
    try {
      await backend.scenes.rename(id, nextTitle);
      setRenamingSceneId(null);
      setRenameTitle("");
      await loadScenes();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusySceneId(null);
    }
  };

  const handleRemove = async (id: string) => {
    if (!window.confirm(t("cloud.scenes.deleteConfirm"))) {
      return;
    }

    setBusySceneId(id);
    setError(null);
    try {
      await backend.scenes.remove(id);
      await loadScenes();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusySceneId(null);
    }
  };

  const startRename = (scene: SceneSummary) => {
    setRenamingSceneId(scene.id);
    setRenameTitle(scene.title);
    setError(null);
  };

  const stopShortcutPropagation = (event: React.KeyboardEvent) => {
    event.stopPropagation();
  };

  return (
    <Dialog
      className="SceneListDialogModal"
      size="small"
      closeOnClickOutside={false}
      onCloseRequest={onClose}
      title={t("cloud.scenes.title")}
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
          <p>{t("cloud.scenes.description")}</p>
          <div className="SceneListDialog__toolbarActions">
            {onBack && (
              <Button onSelect={onBack} disabled={loading}>
                {t("cloud.scenes.back")}
              </Button>
            )}
            <Button onSelect={() => void loadScenes()} disabled={loading}>
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
            {t("cloud.scenes.loading")}
          </div>
        ) : scenes.length === 0 ? (
          <div className="SceneListDialog__status">
            {t("cloud.scenes.empty")}
          </div>
        ) : (
          <ul className="SceneListDialog__list">
            {scenes.map((scene) => {
              const isBusy = busySceneId === scene.id;
              const isRenaming = renamingSceneId === scene.id;

              return (
                <li className="SceneListDialog__item" key={scene.id}>
                  <div className="SceneListDialog__details">
                    {isRenaming ? (
                      <input
                        aria-label={t("cloud.scenes.renameTitle")}
                        autoFocus
                        disabled={isBusy}
                        value={renameTitle}
                        onChange={(event) =>
                          setRenameTitle(event.currentTarget.value)
                        }
                        onKeyDown={stopShortcutPropagation}
                      />
                    ) : (
                      <strong title={scene.title}>{scene.title}</strong>
                    )}
                    <span>
                      {t("cloud.scenes.updatedAt", {
                        date: formatUpdatedAt(scene.updatedAt),
                      })}
                    </span>
                  </div>

                  <div className="SceneListDialog__actions">
                    {isRenaming ? (
                      <>
                        <Button
                          onSelect={() => void handleRename(scene.id)}
                          disabled={isBusy || !renameTitle.trim()}
                        >
                          {t("cloud.scenes.saveRename")}
                        </Button>
                        <Button
                          onSelect={() => {
                            setRenamingSceneId(null);
                            setRenameTitle("");
                          }}
                          disabled={isBusy}
                        >
                          {t("cloud.scenes.cancelRename")}
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          onSelect={() => void handleOpenScene(scene.id)}
                          disabled={isBusy}
                        >
                          {t("cloud.scenes.open")}
                        </Button>
                        <Button
                          onSelect={() => startRename(scene)}
                          disabled={isBusy}
                        >
                          {t("cloud.scenes.rename")}
                        </Button>
                        <Button
                          onSelect={() => void handleRemove(scene.id)}
                          disabled={isBusy}
                        >
                          {t("cloud.scenes.delete")}
                        </Button>
                      </>
                    )}
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
