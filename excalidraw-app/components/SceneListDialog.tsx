import { Button } from "@excalidraw/excalidraw/components/Button";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { CloseIcon } from "@excalidraw/excalidraw/components/icons";
import { t } from "@excalidraw/excalidraw/i18n";
import React, { useCallback, useEffect, useState } from "react";

import { getCloudBackend } from "../data/cloud";
import { getCloudShareLink } from "../data/cloud/cloudShareLinks";

import "./SceneListDialog.scss";

import type {
  SceneRecord,
  SceneSummary,
  ShareLink,
  ShareMode,
} from "../data/cloud";

export interface SceneListDialogProps {
  open: boolean;
  activeSceneId?: string | null;
  onClose: () => void;
  onBack?: () => void;
  onOpenScene: (scene: SceneRecord) => void | Promise<void>;
  onOpenEmbeds?: (scene: SceneSummary) => void;
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
  activeSceneId,
  onClose,
  onBack,
  onOpenScene,
  onOpenEmbeds,
}) => {
  const [scenes, setScenes] = useState<SceneSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busySceneId, setBusySceneId] = useState<string | null>(null);
  const [renamingSceneId, setRenamingSceneId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [sharingScene, setSharingScene] = useState<SceneSummary | null>(null);
  const [shareLinks, setShareLinks] = useState<ShareLink[]>([]);
  const [shareLoading, setShareLoading] = useState(false);
  const [busyShareId, setBusyShareId] = useState<string | null>(null);

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

  const loadShares = useCallback(
    async (sceneId: string) => {
      if (!backend.capabilities.share) {
        setShareLinks([]);
        setError(t("cloud.share.unavailable"));
        return;
      }

      setShareLoading(true);
      setError(null);
      try {
        setShareLinks(await backend.shares.listByScene(sceneId));
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setShareLoading(false);
      }
    },
    [backend],
  );

  useEffect(() => {
    if (open) {
      void loadScenes();
      return;
    }

    setError(null);
    setBusySceneId(null);
    setRenamingSceneId(null);
    setRenameTitle("");
    setSharingScene(null);
    setShareLinks([]);
    setBusyShareId(null);
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
      backend.encryption?.removeKey?.(id);
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

  const startSharing = async (scene: SceneSummary) => {
    setSharingScene(scene);
    setError(null);
    await loadShares(scene.id);
  };

  const stopSharing = () => {
    setSharingScene(null);
    setShareLinks([]);
    setBusyShareId(null);
    setError(null);
  };

  const handleCreateShare = async (mode: ShareMode) => {
    if (!sharingScene) {
      return;
    }

    setBusyShareId(`create-${mode}`);
    setError(null);
    try {
      await backend.shares.create({ sceneId: sharingScene.id, mode });
      await loadShares(sharingScene.id);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyShareId(null);
    }
  };

  const handleCopyShare = async (share: ShareLink) => {
    setBusyShareId(share.id);
    setError(null);
    try {
      await navigator.clipboard.writeText(
        getCloudShareLink(
          share.token,
          backend.encryption?.getKey?.(share.sceneId)?.key,
        ),
      );
    } catch {
      setError(t("cloud.share.copyFailed"));
    } finally {
      setBusyShareId(null);
    }
  };

  const handleRevokeShare = async (share: ShareLink) => {
    if (!sharingScene || !window.confirm(t("cloud.share.revokeConfirm"))) {
      return;
    }

    setBusyShareId(share.id);
    setError(null);
    try {
      await backend.shares.revoke(share.id);
      await loadShares(sharingScene.id);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyShareId(null);
    }
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
          <p>
            {sharingScene
              ? t("cloud.share.description", { title: sharingScene.title })
              : t("cloud.scenes.description")}
          </p>
          <div className="SceneListDialog__toolbarActions">
            {sharingScene ? (
              <Button onSelect={stopSharing} disabled={shareLoading}>
                {t("cloud.scenes.back")}
              </Button>
            ) : onBack ? (
              <Button onSelect={onBack} disabled={loading}>
                {t("cloud.scenes.back")}
              </Button>
            ) : null}
            <Button
              onSelect={() =>
                sharingScene
                  ? void loadShares(sharingScene.id)
                  : void loadScenes()
              }
              disabled={sharingScene ? shareLoading : loading}
            >
              {t("cloud.scenes.refresh")}
            </Button>
          </div>
        </div>

        {error && (
          <p className="SceneListDialog__error" role="alert">
            {error}
          </p>
        )}

        {sharingScene ? (
          <div className="SceneListDialog__shareView">
            <div className="SceneListDialog__shareActions">
              <Button
                onSelect={() => void handleCreateShare("read")}
                disabled={shareLoading || busyShareId !== null}
              >
                {t("cloud.share.createRead")}
              </Button>
              <Button
                onSelect={() => void handleCreateShare("write")}
                disabled={shareLoading || busyShareId !== null}
              >
                {t("cloud.share.createWrite")}
              </Button>
            </div>

            {shareLoading ? (
              <div className="SceneListDialog__status">
                {t("cloud.share.loading")}
              </div>
            ) : shareLinks.length === 0 ? (
              <div className="SceneListDialog__status">
                {t("cloud.share.empty")}
              </div>
            ) : (
              <ul className="SceneListDialog__list">
                {shareLinks.map((share) => (
                  <li className="SceneListDialog__item" key={share.id}>
                    <div className="SceneListDialog__details">
                      <strong>
                        {share.mode === "read"
                          ? t("cloud.share.modeRead")
                          : t("cloud.share.modeWrite")}
                      </strong>
                      <span>
                        {share.revoked
                          ? t("cloud.share.revoked")
                          : t("cloud.share.active")}
                      </span>
                    </div>
                    <div className="SceneListDialog__actions">
                      <Button
                        onSelect={() => void handleCopyShare(share)}
                        disabled={busyShareId !== null || share.revoked}
                      >
                        {t("cloud.share.copy")}
                      </Button>
                      <Button
                        onSelect={() => void handleRevokeShare(share)}
                        disabled={busyShareId !== null || share.revoked}
                      >
                        {t("cloud.share.revoke")}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : loading ? (
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
              const isCurrentScene = activeSceneId === scene.id;

              return (
                <li className="SceneListDialog__item" key={scene.id}>
                  <div className="SceneListDialog__details">
                    <div className="SceneListDialog__titleRow">
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
                    </div>
                    <div className="SceneListDialog__metaRow">
                      <span className="SceneListDialog__updatedAt">
                        {t("cloud.scenes.updatedAt", {
                          date: formatUpdatedAt(scene.updatedAt),
                        })}
                      </span>
                      {isCurrentScene && (
                        <span className="SceneListDialog__currentBadge">
                          {t("cloud.scenes.current")}
                        </span>
                      )}
                    </div>
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
                          onSelect={() => void startSharing(scene)}
                          disabled={isBusy || !backend.capabilities.share}
                        >
                          {t("cloud.share.action")}
                        </Button>
                        <Button
                          onSelect={() => onOpenEmbeds?.(scene)}
                          disabled={
                            isBusy ||
                            !onOpenEmbeds ||
                            !backend.capabilities.embed
                          }
                        >
                          {t("cloud.embed.action")}
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
