import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { CloseIcon } from "@excalidraw/excalidraw/components/icons";
import { t } from "@excalidraw/excalidraw/i18n";
import React, { useCallback, useEffect, useState } from "react";

import { getCloudBackend } from "../data/cloud";
import { getCloudShareLink } from "../data/cloud/cloudShareLinks";

import "./SceneListDialog.scss";

import {
  Badge,
  Callout,
  DialogActions,
  Field,
  ListRow,
  Select,
  TextInput,
  UiButton,
  confirmAction,
} from "./ui";

import type { ActionMenuItem } from "./ui";

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
  const [shareMode, setShareMode] = useState<ShareMode>("read");

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
    setShareMode("read");
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
    if (!(await confirmAction(t("cloud.scenes.deleteConfirm")))) {
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
    setShareMode("read");
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
    if (
      !sharingScene ||
      !(await confirmAction(t("cloud.share.revokeConfirm")))
    ) {
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

  const onRenameKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement>,
    id: string,
  ) => {
    event.stopPropagation();
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void handleRename(id);
    }
  };

  const renderStatus = (message: string) => (
    <p className="SceneListDialog__status" role="status">
      {message}
    </p>
  );

  const renderShareView = () => (
    <div className="SceneListDialog__shareView">
      <div className="SceneListDialog__shareCreate">
        <Field label={t("cloud.share.permission")}>
          <Select
            value={shareMode}
            disabled={shareLoading || busyShareId !== null}
            onChange={(event) =>
              setShareMode(event.currentTarget.value as ShareMode)
            }
          >
            <option value="read">{t("cloud.share.modeRead")}</option>
            <option value="write">{t("cloud.share.modeWrite")}</option>
          </Select>
        </Field>
        <UiButton
          variant="primary"
          loading={busyShareId === `create-${shareMode}`}
          disabled={shareLoading || busyShareId !== null}
          onClick={() => void handleCreateShare(shareMode)}
        >
          {t("cloud.share.create")}
        </UiButton>
      </div>

      {shareLoading ? (
        renderStatus(t("cloud.share.loading"))
      ) : shareLinks.length === 0 ? (
        renderStatus(t("cloud.share.empty"))
      ) : (
        <ul className="SceneListDialog__list">
          {shareLinks.map((share) => (
            <ListRow
              key={share.id}
              className={share.revoked ? "SceneListDialog__row--revoked" : ""}
              title={
                share.mode === "read"
                  ? t("cloud.share.modeRead")
                  : t("cloud.share.modeWrite")
              }
              badges={
                <Badge tone={share.revoked ? "neutral" : "success"}>
                  {share.revoked
                    ? t("cloud.share.revoked")
                    : t("cloud.share.active")}
                </Badge>
              }
              actions={
                !share.revoked && (
                  <>
                    <UiButton
                      size="sm"
                      loading={busyShareId === share.id}
                      disabled={busyShareId !== null}
                      onClick={() => void handleCopyShare(share)}
                    >
                      {t("cloud.share.copy")}
                    </UiButton>
                    <UiButton
                      size="sm"
                      variant="danger"
                      disabled={busyShareId !== null}
                      onClick={() => void handleRevokeShare(share)}
                    >
                      {t("cloud.share.revoke")}
                    </UiButton>
                  </>
                )
              }
            />
          ))}
        </ul>
      )}
    </div>
  );

  const renderSceneRow = (scene: SceneSummary) => {
    const isBusy = busySceneId === scene.id;
    const isRenaming = renamingSceneId === scene.id;
    const isCurrentScene = activeSceneId === scene.id;
    const rowDisabled = busySceneId !== null;

    if (isRenaming) {
      return (
        <ListRow
          key={scene.id}
          className="SceneListDialog__row--renaming"
          current={isCurrentScene}
          title={
            <TextInput
              aria-label={t("cloud.scenes.renameTitle")}
              autoFocus
              disabled={isBusy}
              value={renameTitle}
              onChange={(event) => setRenameTitle(event.currentTarget.value)}
              onKeyDown={(event) => onRenameKeyDown(event, scene.id)}
            />
          }
          actions={
            <>
              <UiButton
                size="sm"
                onClick={() => {
                  setRenamingSceneId(null);
                  setRenameTitle("");
                }}
                disabled={isBusy}
              >
                {t("cloud.scenes.cancelRename")}
              </UiButton>
              <UiButton
                size="sm"
                variant="primary"
                loading={isBusy}
                onClick={() => void handleRename(scene.id)}
                disabled={!renameTitle.trim()}
              >
                {t("cloud.scenes.saveRename")}
              </UiButton>
            </>
          }
        />
      );
    }

    const menu: ActionMenuItem[] = [
      {
        label: t("cloud.scenes.rename"),
        onSelect: () => startRename(scene),
        disabled: rowDisabled,
      },
    ];
    if (backend.capabilities.share) {
      menu.push({
        label: t("cloud.share.action"),
        onSelect: () => void startSharing(scene),
        disabled: rowDisabled,
      });
    }
    if (onOpenEmbeds && backend.capabilities.embed) {
      menu.push({
        label: t("cloud.embed.action"),
        onSelect: () => onOpenEmbeds(scene),
        disabled: rowDisabled,
      });
    }
    menu.push({
      label: t("cloud.scenes.delete"),
      onSelect: () => void handleRemove(scene.id),
      danger: true,
      disabled: rowDisabled,
    });

    return (
      <ListRow
        key={scene.id}
        current={isCurrentScene}
        title={<span title={scene.title}>{scene.title}</span>}
        badges={
          isCurrentScene && (
            <Badge tone="info">{t("cloud.scenes.current")}</Badge>
          )
        }
        meta={t("cloud.scenes.updatedAt", {
          date: formatUpdatedAt(scene.updatedAt),
        })}
        actions={
          <UiButton
            size="sm"
            loading={isBusy}
            disabled={rowDisabled}
            onClick={() => void handleOpenScene(scene.id)}
          >
            {t("cloud.scenes.open")}
          </UiButton>
        }
        menu={menu}
      />
    );
  };

  const listBusy = sharingScene ? shareLoading : loading;

  return (
    <Dialog
      className="SceneListDialogModal"
      size="small"
      closeOnClickOutside={false}
      onCloseRequest={onClose}
      title={t("cloud.scenes.title")}
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
          {sharingScene
            ? t("cloud.share.description", { title: sharingScene.title })
            : t("cloud.scenes.description")}
        </p>

        {error && <Callout tone="danger">{error}</Callout>}

        {sharingScene ? (
          renderShareView()
        ) : loading ? (
          renderStatus(t("cloud.scenes.loading"))
        ) : scenes.length === 0 ? (
          renderStatus(t("cloud.scenes.empty"))
        ) : (
          <ul className="SceneListDialog__list">
            {scenes.map(renderSceneRow)}
          </ul>
        )}

        <DialogActions
          leading={
            (sharingScene || onBack) && (
              <UiButton
                variant="ghost"
                onClick={sharingScene ? stopSharing : onBack}
                disabled={listBusy}
              >
                {t("cloud.scenes.back")}
              </UiButton>
            )
          }
        >
          <UiButton
            onClick={() =>
              sharingScene
                ? void loadShares(sharingScene.id)
                : void loadScenes()
            }
            disabled={listBusy}
          >
            {t("cloud.scenes.refresh")}
          </UiButton>
        </DialogActions>
      </div>
    </Dialog>
  );
};
