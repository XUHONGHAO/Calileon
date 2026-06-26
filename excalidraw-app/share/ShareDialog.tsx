import { trackEvent } from "@excalidraw/excalidraw/analytics";
import { copyTextToSystemClipboard } from "@excalidraw/excalidraw/clipboard";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { FilledButton } from "@excalidraw/excalidraw/components/FilledButton";
import { TextField } from "@excalidraw/excalidraw/components/TextField";
import {
  copyIcon,
  LinkIcon,
  playerPlayIcon,
  playerStopFilledIcon,
  share,
  shareIOS,
  shareWindows,
} from "@excalidraw/excalidraw/components/icons";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import { useCopyStatus } from "@excalidraw/excalidraw/hooks/useCopiedIndicator";
import { useI18n } from "@excalidraw/excalidraw/i18n";
import { KEYS, getFrame } from "@excalidraw/common";
import { useCallback, useEffect, useRef, useState } from "react";

import { atom, useAtom, useAtomValue } from "../app-jotai";
import { useCloudAuth } from "../auth/useCloudAuth";
import { activeRoomLinkAtom } from "../collab/Collab";
import { getCloudBackend, shareLink } from "../data/cloud";
import { getCloudShareLink } from "../data/cloud/cloudShareLinks";

import "./ShareDialog.scss";
import { QRCode } from "./QRCode";

import type { CollabAPI } from "../collab/Collab";
import type { CollabRoomRecord, ShareLink, ShareMode } from "../data/cloud";

type OnExportToBackend = () => void;
type ShareDialogType = "share" | "collaborationOnly" | "inputInvite";

export interface ShareDialogCloudSceneInfo {
  id: string;
  title: string;
  version: number;
  updatedAt: number;
}

export const shareDialogStateAtom = atom<
  | { isOpen: false }
  | { isOpen: true; type: Exclude<ShareDialogType, "inputInvite"> }
  | { isOpen: true; type: "inputInvite"; inputTargetId: string }
>({ isOpen: false });

const getShareIcon = () => {
  const navigator = window.navigator as any;
  const isAppleBrowser = /Apple/.test(navigator.vendor);
  const isWindowsBrowser = navigator.appVersion.indexOf("Win") !== -1;

  if (isAppleBrowser) {
    return shareIOS;
  } else if (isWindowsBrowser) {
    return shareWindows;
  }

  return share;
};

export type ShareDialogProps = {
  activeCloudScene?: ShareDialogCloudSceneInfo | null;
  collabAPI: CollabAPI | null;
  handleClose: () => void;
  inputTargetId: string | null;
  onExportToBackend: OnExportToBackend;
  onSaveCloudScene?: () => void | Promise<void>;
  onStartCollabRoom?: (room: {
    roomId: string;
    roomKey: string;
  }) => void | Promise<void>;
  collabRoomRefreshKey?: number;
  onCollabRoomChanged?: () => void;
  onCollabRoomRevoked?: (room: CollabRoomRecord) => void | Promise<void>;
  type: ShareDialogType;
};

const ActiveRoomDialog = ({
  collabAPI,
  activeRoomLink,
  handleClose,
  inputTargetId,
}: {
  collabAPI: CollabAPI;
  activeRoomLink: string;
  handleClose: () => void;
  inputTargetId: string | null;
}) => {
  const { t } = useI18n();
  const [, setJustCopied] = useState(false);
  const timerRef = useRef<number>(0);
  const ref = useRef<HTMLInputElement>(null);
  const isShareSupported = "share" in navigator;
  const { onCopy, copyStatus } = useCopyStatus();
  const inputTargetRoomLink = inputTargetId
    ? collabAPI.getInputTargetRoomLink(inputTargetId)
    : null;
  const linkToShare = inputTargetRoomLink || activeRoomLink;

  const copyRoomLink = async () => {
    try {
      await copyTextToSystemClipboard(linkToShare);
    } catch (e) {
      collabAPI.setCollabError(t("errors.copyToSystemClipboardFailed"));
    }

    setJustCopied(true);

    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
    }

    timerRef.current = window.setTimeout(() => {
      setJustCopied(false);
    }, 3000);

    ref.current?.select();
  };

  const shareRoomLink = async () => {
    try {
      await navigator.share({
        title: inputTargetRoomLink
          ? t("roomDialog.inputInviteShareTitle")
          : t("roomDialog.shareTitle"),
        text: inputTargetRoomLink
          ? t("roomDialog.inputInviteShareTitle")
          : t("roomDialog.shareTitle"),
        url: linkToShare,
      });
    } catch (error: any) {
      // Just ignore.
    }
  };

  return (
    <>
      <h3 className="ShareDialog__active__header">
        {inputTargetRoomLink
          ? t("labels.inviteInput")
          : t("labels.liveCollaboration").replace(/\./g, "")}
      </h3>
      <TextField
        defaultValue={collabAPI.getUsername()}
        placeholder={t("labels.yourName")}
        label={t("labels.yourName")}
        onChange={collabAPI.setUsername}
        onKeyDown={(event) => event.key === KEYS.ENTER && handleClose()}
      />
      <div className="ShareDialog__active__linkRow">
        <TextField
          ref={ref}
          label={
            inputTargetRoomLink
              ? t("roomDialog.inputTargetLinkLabel")
              : t("roomDialog.shareLinkLabel")
          }
          readonly
          fullWidth
          value={linkToShare}
        />
        {isShareSupported && (
          <FilledButton
            size="large"
            variant="icon"
            label={t("labels.share")}
            icon={getShareIcon()}
            className="ShareDialog__active__share"
            onClick={shareRoomLink}
          />
        )}
        <FilledButton
          size="large"
          label={t("buttons.copyLink")}
          icon={copyIcon}
          status={copyStatus}
          onClick={() => {
            copyRoomLink();
            onCopy();
          }}
        />
      </div>
      <QRCode value={linkToShare} />
      <div className="ShareDialog__active__description">
        <p>
          <span
            role="img"
            aria-hidden="true"
            className="ShareDialog__active__description__emoji"
          >
            🔒{" "}
          </span>
          {t("roomDialog.desc_privacy")}
        </p>
        <p>{t("roomDialog.desc_exitSession")}</p>
      </div>

      <div className="ShareDialog__active__actions">
        <FilledButton
          size="large"
          variant="outlined"
          color="danger"
          label={t("roomDialog.button_stopSession")}
          icon={playerStopFilledIcon}
          onClick={() => {
            trackEvent("share", "room closed");
            collabAPI.stopCollaboration();
            if (!collabAPI.isCollaborating()) {
              handleClose();
            }
          }}
        />
      </div>
    </>
  );
};

const ShareDialogPicker = (props: ShareDialogProps) => {
  const { t } = useI18n();
  const { isSignedIn } = useCloudAuth();

  const { collabAPI } = props;
  const activeCloudScene = props.activeCloudScene ?? null;
  const backend = getCloudBackend();
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [savingCloudScene, setSavingCloudScene] = useState(false);
  const [shareLinks, setShareLinks] = useState<ShareLink[]>([]);
  const [shareLoading, setShareLoading] = useState(false);
  const [busyShareId, setBusyShareId] = useState<string | null>(null);
  const [collabRoomStats, setCollabRoomStats] = useState<
    | { status: "idle" | "loading" | "unavailable" }
    | { status: "ready"; room: CollabRoomRecord | null }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const [collabRoomLink, setCollabRoomLink] = useState<string | null>(null);
  const [creatingCollabRoom, setCreatingCollabRoom] = useState(false);
  const [revokingCollabRoom, setRevokingCollabRoom] = useState(false);

  const loadCloudShareLinks = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      if (!isSignedIn || !activeCloudScene) {
        setShareLinks([]);
        return;
      }
      if (!backend.capabilities.share) {
        setCloudError(t("cloud.share.unavailable"));
        setShareLinks([]);
        return;
      }

      setShareLoading(true);
      setCloudError(null);
      try {
        const links = await backend.shares.listByScene(activeCloudScene.id);
        if (!isCancelled()) {
          setShareLinks(links);
        }
      } catch (error) {
        if (!isCancelled()) {
          setCloudError(
            error instanceof Error
              ? error.message
              : t("cloud.share.unavailable"),
          );
        }
      } finally {
        if (!isCancelled()) {
          setShareLoading(false);
        }
      }
    },
    [activeCloudScene, backend, isSignedIn, t],
  );

  const loadCollabRoomStats = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      if (!isSignedIn || !activeCloudScene) {
        setCollabRoomStats({ status: "idle" });
        return;
      }
      if (!backend.capabilities.collabRoomBinding) {
        setCollabRoomStats({ status: "unavailable" });
        return;
      }

      setCollabRoomStats({ status: "loading" });
      try {
        const room = await backend.collabRooms.getByScene(activeCloudScene.id);
        if (!isCancelled()) {
          setCollabRoomStats({ status: "ready", room });
        }
      } catch (error) {
        if (!isCancelled()) {
          setCollabRoomStats({
            status: "error",
            message:
              error instanceof Error
                ? error.message
                : t("cloud.collabRooms.genericError"),
          });
        }
      }
    },
    [activeCloudScene, backend, isSignedIn, t],
  );

  useEffect(() => {
    let cancelled = false;
    void loadCloudShareLinks(() => cancelled);
    void loadCollabRoomStats(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [props.collabRoomRefreshKey, loadCloudShareLinks, loadCollabRoomStats]);

  const copyCloudShare = async (link: ShareLink) => {
    await copyTextToSystemClipboard(
      getCloudShareLink(
        link.token,
        backend.encryption?.getKey?.(link.sceneId)?.key,
      ),
    );
  };

  const handleCreateCloudShare = async (mode: ShareMode) => {
    if (!activeCloudScene || busyShareId) {
      return;
    }

    setBusyShareId(`create-${mode}`);
    setCloudError(null);
    try {
      const link = await backend.shares.create({
        sceneId: activeCloudScene.id,
        mode,
      });
      await copyCloudShare(link);
      await loadCloudShareLinks();
    } catch (error) {
      setCloudError(
        error instanceof Error ? error.message : t("cloud.share.copyFailed"),
      );
    } finally {
      setBusyShareId(null);
    }
  };

  const handleCopyCloudShare = async (link: ShareLink) => {
    setBusyShareId(link.id);
    setCloudError(null);
    try {
      await copyCloudShare(link);
    } catch {
      setCloudError(t("cloud.share.copyFailed"));
    } finally {
      setBusyShareId(null);
    }
  };

  const handleRevokeCloudShare = async (link: ShareLink) => {
    if (!window.confirm(t("cloud.share.revokeConfirm"))) {
      return;
    }

    setBusyShareId(link.id);
    setCloudError(null);
    try {
      await backend.shares.revoke(link.id);
      await loadCloudShareLinks();
    } catch (error) {
      setCloudError(
        error instanceof Error ? error.message : t("cloud.share.unavailable"),
      );
    } finally {
      setBusyShareId(null);
    }
  };

  const handleSaveCloudScene = async () => {
    if (!props.onSaveCloudScene || savingCloudScene) {
      return;
    }
    setSavingCloudScene(true);
    setCloudError(null);
    try {
      await props.onSaveCloudScene();
    } catch (error) {
      setCloudError(
        error instanceof Error ? error.message : t("cloud.scenes.saveFailed"),
      );
    } finally {
      setSavingCloudScene(false);
    }
  };

  const handleCreateRealtimeRoom = async () => {
    if (!collabAPI || creatingCollabRoom) {
      return;
    }

    if (
      isSignedIn &&
      activeCloudScene &&
      backend.capabilities.collabRoomBinding
    ) {
      setCreatingCollabRoom(true);
      setCloudError(null);
      try {
        const { roomId, roomKey } =
          await shareLink.generateCollaborationLinkData();
        await backend.collabRooms.createForScene({
          sceneId: activeCloudScene.id,
          roomId,
        });
        const link = shareLink.getCollaborationLink({ roomId, roomKey });
        if (props.onStartCollabRoom) {
          await props.onStartCollabRoom({ roomId, roomKey });
        } else {
          await collabAPI.startCollaboration(
            { roomId, roomKey },
            { preserveLocalScene: true },
          );
        }
        setCollabRoomLink(link);
        await copyTextToSystemClipboard(link);
        await loadCollabRoomStats();
        props.onCollabRoomChanged?.();
      } catch (error) {
        setCloudError(
          error instanceof Error
            ? error.message
            : t("cloud.collabRooms.genericError"),
        );
      } finally {
        setCreatingCollabRoom(false);
      }
      return;
    }

    trackEvent("share", "room creation", `ui (${getFrame()})`);
    void collabAPI.startCollaboration(null);
  };

  const handleCopyCollabRoom = async () => {
    if (!collabRoomLink) {
      return;
    }
    try {
      await copyTextToSystemClipboard(collabRoomLink);
    } catch {
      setCloudError(t("cloud.collabRooms.copyFailed"));
    }
  };

  const handleRevokeCollabRoom = async () => {
    if (
      collabRoomStats.status !== "ready" ||
      !collabRoomStats.room ||
      revokingCollabRoom ||
      !window.confirm(t("cloud.collabRooms.revokeConfirm"))
    ) {
      return;
    }

    setRevokingCollabRoom(true);
    setCloudError(null);
    try {
      const room = collabRoomStats.room;
      await backend.collabRooms.revoke(room.id);
      await props.onCollabRoomRevoked?.(room);
      setCollabRoomLink(null);
      await loadCollabRoomStats();
      props.onCollabRoomChanged?.();
    } catch (error) {
      setCloudError(
        error instanceof Error
          ? error.message
          : t("cloud.collabRooms.genericError"),
      );
    } finally {
      setRevokingCollabRoom(false);
    }
  };

  const activeCloudSceneTitle =
    activeCloudScene?.title ?? t("cloud.auth.currentCloudWhiteboard");
  const cloudShareUnavailableReason = !isSignedIn
    ? t("cloud.errors.signInRequired")
    : !backend.capabilities.share
    ? t("cloud.share.unavailable")
    : !activeCloudScene
    ? t("roomDialog.cloudShareSaveFirst")
    : null;

  const startCollabJSX = collabAPI ? (
    <>
      <div className="ShareDialog__picker__header">
        {props.type === "inputInvite"
          ? t("labels.inviteInput")
          : t("labels.liveCollaboration").replace(/\./g, "")}
      </div>

      <div className="ShareDialog__picker__description">
        <div className="ShareDialog__picker__description__intro">
          {props.type === "inputInvite"
            ? t("roomDialog.inputInviteDesc")
            : t("roomDialog.desc_intro")}
        </div>
        {t("roomDialog.desc_privacy")}
      </div>

      {props.type === "inputInvite" ? (
        <div className="ShareDialog__picker__button">
          <FilledButton
            size="large"
            label={t("roomDialog.button_startSession")}
            icon={playerPlayIcon}
            onClick={() => {
              trackEvent("share", "room creation", `ui (${getFrame()})`);
              collabAPI.startCollaboration(null);
            }}
          />
        </div>
      ) : (
        <div className="ShareDialog__options">
          <section className="ShareDialog__option">
            <div className="ShareDialog__optionHeader">
              <strong>{t("roomDialog.realtimeRoomTitle")}</strong>
              <span>{t("roomDialog.realtimeRoomBadge")}</span>
            </div>
            <p>{t("roomDialog.realtimeRoomDescription")}</p>
            {activeCloudScene && isSignedIn && (
              <small>
                {collabRoomStats.status === "loading"
                  ? t("cloud.collabRooms.loading")
                  : collabRoomStats.status === "ready" && collabRoomStats.room
                  ? t("cloud.collabRooms.roomId", {
                      roomId: collabRoomStats.room.roomId,
                    })
                  : collabRoomStats.status === "unavailable"
                  ? t("cloud.collabRooms.unavailable")
                  : t("cloud.collabRooms.empty")}
              </small>
            )}
            {collabRoomStats.status === "ready" &&
              collabRoomStats.room &&
              !collabRoomLink && (
                <small>{t("cloud.collabRooms.keyNotStored")}</small>
              )}
            <div className="ShareDialog__optionActions">
              <FilledButton
                size="large"
                label={
                  creatingCollabRoom
                    ? t("cloud.collabRooms.creating")
                    : t("roomDialog.button_startSession")
                }
                icon={playerPlayIcon}
                onClick={() => void handleCreateRealtimeRoom()}
                disabled={creatingCollabRoom || revokingCollabRoom}
              />
              <FilledButton
                size="large"
                variant="outlined"
                label={t("cloud.collabRooms.copyLink")}
                icon={copyIcon}
                onClick={() => void handleCopyCollabRoom()}
                disabled={!collabRoomLink || creatingCollabRoom}
              />
              {activeCloudScene && isSignedIn && (
                <FilledButton
                  size="large"
                  variant="outlined"
                  color="danger"
                  label={
                    revokingCollabRoom
                      ? t("cloud.collabRooms.revoking")
                      : t("cloud.collabRooms.revoke")
                  }
                  onClick={() => void handleRevokeCollabRoom()}
                  disabled={
                    collabRoomStats.status !== "ready" ||
                    !collabRoomStats.room ||
                    creatingCollabRoom ||
                    revokingCollabRoom
                  }
                />
              )}
            </div>
          </section>

          <section className="ShareDialog__option">
            <div className="ShareDialog__optionHeader">
              <strong>{t("roomDialog.cloudShareTitle")}</strong>
              <span>{t("roomDialog.cloudShareBadge")}</span>
            </div>
            <p>{t("roomDialog.cloudShareDescription")}</p>
            {activeCloudScene ? (
              <small title={activeCloudSceneTitle}>
                {t("roomDialog.cloudShareCurrentScene", {
                  title: activeCloudSceneTitle,
                })}
              </small>
            ) : cloudShareUnavailableReason ? (
              <small>{cloudShareUnavailableReason}</small>
            ) : null}

            {activeCloudScene && (
              <div className="ShareDialog__cloudShareActions">
                <FilledButton
                  size="large"
                  variant="outlined"
                  label={t("cloud.share.createRead")}
                  icon={LinkIcon}
                  onClick={() => void handleCreateCloudShare("read")}
                  disabled={
                    !isSignedIn ||
                    !backend.capabilities.share ||
                    shareLoading ||
                    busyShareId !== null
                  }
                />
                <FilledButton
                  size="large"
                  variant="outlined"
                  label={t("cloud.share.createWrite")}
                  icon={LinkIcon}
                  onClick={() => void handleCreateCloudShare("write")}
                  disabled={
                    !isSignedIn ||
                    !backend.capabilities.share ||
                    shareLoading ||
                    busyShareId !== null
                  }
                />
              </div>
            )}

            {!activeCloudScene && props.onSaveCloudScene && (
              <div className="ShareDialog__cloudShareActions">
                <FilledButton
                  size="large"
                  variant="outlined"
                  label={
                    savingCloudScene
                      ? t("cloud.scenes.saving")
                      : t("cloud.scenes.saveToCloud")
                  }
                  icon={LinkIcon}
                  onClick={() => void handleSaveCloudScene()}
                  disabled={!isSignedIn || savingCloudScene}
                />
              </div>
            )}

            {activeCloudScene &&
              (shareLoading ? (
                <div className="ShareDialog__status">
                  {t("cloud.share.loading")}
                </div>
              ) : shareLinks.length === 0 ? (
                <div className="ShareDialog__status">
                  {t("cloud.share.empty")}
                </div>
              ) : (
                <ul className="ShareDialog__linkList">
                  {shareLinks.map((link) => (
                    <li key={link.id}>
                      <div>
                        <strong>
                          {link.mode === "read"
                            ? t("cloud.share.modeRead")
                            : t("cloud.share.modeWrite")}
                        </strong>
                        <span>
                          {link.revoked
                            ? t("cloud.share.revoked")
                            : t("cloud.share.active")}
                        </span>
                      </div>
                      <div className="ShareDialog__linkActions">
                        <button
                          type="button"
                          onClick={() => void handleCopyCloudShare(link)}
                          disabled={busyShareId !== null || link.revoked}
                        >
                          {t("cloud.share.copy")}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleRevokeCloudShare(link)}
                          disabled={busyShareId !== null || link.revoked}
                        >
                          {t("cloud.share.revoke")}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ))}
          </section>
        </div>
      )}

      {cloudError && (
        <p className="ShareDialog__error" role="alert">
          {cloudError}
        </p>
      )}

      {props.type === "share" && (
        <div className="ShareDialog__separator">
          <span>{t("shareDialog.or")}</span>
        </div>
      )}
    </>
  ) : null;

  return (
    <>
      {startCollabJSX}

      {props.type === "share" && (
        <>
          <div className="ShareDialog__picker__header">
            {t("exportDialog.link_title")}
          </div>
          <div className="ShareDialog__picker__description">
            {t("exportDialog.link_details")}
          </div>

          <div className="ShareDialog__picker__button">
            <FilledButton
              size="large"
              label={t("exportDialog.link_button")}
              icon={LinkIcon}
              onClick={async () => {
                await props.onExportToBackend();
                props.handleClose();
              }}
            />
          </div>
        </>
      )}
    </>
  );
};

const ShareDialogInner = (props: ShareDialogProps) => {
  const activeRoomLink = useAtomValue(activeRoomLinkAtom);

  return (
    <Dialog size="regular" onCloseRequest={props.handleClose} title={false}>
      <div className="ShareDialog">
        {props.collabAPI && activeRoomLink ? (
          <ActiveRoomDialog
            collabAPI={props.collabAPI}
            activeRoomLink={activeRoomLink}
            handleClose={props.handleClose}
            inputTargetId={props.inputTargetId}
          />
        ) : (
          <ShareDialogPicker {...props} />
        )}
      </div>
    </Dialog>
  );
};

export const ShareDialog = (props: {
  activeCloudScene?: ShareDialogCloudSceneInfo | null;
  collabAPI: CollabAPI | null;
  onExportToBackend: OnExportToBackend;
  onSaveCloudScene?: () => void | Promise<void>;
  onStartCollabRoom?: (room: {
    roomId: string;
    roomKey: string;
  }) => void | Promise<void>;
  collabRoomRefreshKey?: number;
  onCollabRoomChanged?: () => void;
  onCollabRoomRevoked?: (room: CollabRoomRecord) => void | Promise<void>;
}) => {
  const [shareDialogState, setShareDialogState] = useAtom(shareDialogStateAtom);

  const { openDialog } = useUIAppState();

  useEffect(() => {
    if (openDialog) {
      setShareDialogState({ isOpen: false });
    }
  }, [openDialog, setShareDialogState]);

  if (!shareDialogState.isOpen) {
    return null;
  }

  return (
    <ShareDialogInner
      handleClose={() => setShareDialogState({ isOpen: false })}
      activeCloudScene={props.activeCloudScene}
      collabAPI={props.collabAPI}
      inputTargetId={
        shareDialogState.type === "inputInvite"
          ? shareDialogState.inputTargetId
          : null
      }
      onExportToBackend={props.onExportToBackend}
      onSaveCloudScene={props.onSaveCloudScene}
      onStartCollabRoom={props.onStartCollabRoom}
      collabRoomRefreshKey={props.collabRoomRefreshKey}
      onCollabRoomChanged={props.onCollabRoomChanged}
      onCollabRoomRevoked={props.onCollabRoomRevoked}
      type={shareDialogState.type}
    />
  );
};
