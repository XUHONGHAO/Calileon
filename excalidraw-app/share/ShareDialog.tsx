import { trackEvent } from "@excalidraw/excalidraw/analytics";
import { copyTextToSystemClipboard } from "@excalidraw/excalidraw/clipboard";
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

import {
  AppDialog,
  Badge,
  Callout,
  ListRow,
  UiButton,
  confirmAction,
} from "../components/ui";

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
  /** Opens cloud sign-in (shown when sharing needs an account). */
  onSignIn?: () => void;
  /**
   * Starts the live session for a freshly created room binding. Throw when it
   * did not start: the dialog then revokes the binding.
   */
  onStartCollabRoom?: (room: {
    roomId: string;
    roomKey: string;
  }) => void | Promise<void>;
  /** Why a live session can't start now; checked before creating a binding. */
  getCollabRoomStartBlocker?: () => string | null;
  collabRoomRefreshKey?: number;
  onCollabRoomChanged?: () => void;
  onCollabRoomRevoked?: (room: CollabRoomRecord) => void | Promise<void>;
  type: ShareDialogType;
  /** Guidance that must survive the switch to the active-room view. */
  onRoomNotice?: (notice: string | null) => void;
};

const ActiveRoomDialog = ({
  collabAPI,
  activeRoomLink,
  handleClose,
  inputTargetId,
  notice,
}: {
  collabAPI: CollabAPI;
  activeRoomLink: string;
  handleClose: () => void;
  inputTargetId: string | null;
  notice?: string | null;
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

  /** Resolves false when the clipboard write failed. */
  const copyRoomLink = async () => {
    try {
      await copyTextToSystemClipboard(linkToShare);
    } catch (e) {
      collabAPI.setCollabError(t("errors.copyToSystemClipboardFailed"));
      ref.current?.select();
      return false;
    }

    setJustCopied(true);

    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
    }

    timerRef.current = window.setTimeout(() => {
      setJustCopied(false);
    }, 3000);

    ref.current?.select();
    return true;
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
        onKeyDown={(event) => {
          // The name is saved as you type; Enter just finishes editing
          // instead of closing the whole dialog.
          if (event.key === KEYS.ENTER && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
      {notice && <Callout tone="warning">{notice}</Callout>}
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
          onClick={async () => {
            if (await copyRoomLink()) {
              onCopy();
            }
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
          onClick={async () => {
            trackEvent("share", "room closed");
            // Resolves after the user answers the stop prompt.
            await collabAPI.stopCollaboration();
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
  // Non-error guidance shown inside the card it belongs to.
  const [roomNotice, setRoomNotice] = useState<string | null>(null);
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const [savingCloudScene, setSavingCloudScene] = useState(false);
  const [shareLinks, setShareLinks] = useState<ShareLink[]>([]);
  const [shareLoading, setShareLoading] = useState(false);
  // Listing failed: show it instead of a misleading "no links yet".
  const [shareListError, setShareListError] = useState<string | null>(null);
  const [busyShareId, setBusyShareId] = useState<string | null>(null);
  // Synchronous guard: two quick clicks both run before a re-render.
  const startingSessionRef = useRef(false);
  const [startingSession, setStartingSession] = useState(false);
  const [collabRoomStats, setCollabRoomStats] = useState<
    | { status: "idle" | "loading" | "unavailable" }
    | { status: "ready"; room: CollabRoomRecord | null }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const [collabRoomLink, setCollabRoomLink] = useState<string | null>(null);
  const [creatingCollabRoom, setCreatingCollabRoom] = useState(false);
  const [revokingCollabRoom, setRevokingCollabRoom] = useState(false);

  const activeCloudSceneTitle =
    activeCloudScene?.title ?? t("cloud.auth.currentCloudWhiteboard");
  // Why share links can't be managed here, if they can't.
  const cloudShareBlockedReason = !isSignedIn
    ? t("cloud.share.signInRequired")
    : !backend.capabilities.share
    ? t("cloud.share.unavailable")
    : null;

  const loadCloudShareLinks = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      // Signed out / not configured: the card shows the reason instead.
      if (!isSignedIn || !activeCloudScene || !backend.capabilities.share) {
        setShareLinks([]);
        setShareListError(null);
        return;
      }

      setShareLoading(true);
      setShareListError(null);
      try {
        const links = await backend.shares.listByScene(activeCloudScene.id);
        if (!isCancelled()) {
          setShareLinks(links);
        }
      } catch (error) {
        if (!isCancelled()) {
          setShareListError(
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
    setShareNotice(null);
    try {
      const link = await backend.shares.create({
        sceneId: activeCloudScene.id,
        mode,
      });
      // The link exists now. A clipboard failure must not read as a create
      // failure (users would retry and make duplicates) or skip the refresh.
      let copied = true;
      try {
        await copyCloudShare(link);
      } catch {
        copied = false;
      }
      await loadCloudShareLinks();
      if (!copied) {
        setShareNotice(t("cloud.share.createdCopyFailed"));
      }
    } catch (error) {
      setCloudError(
        error instanceof Error ? error.message : t("cloud.share.unavailable"),
      );
    } finally {
      setBusyShareId(null);
    }
  };

  const handleCopyCloudShare = async (link: ShareLink) => {
    setBusyShareId(`copy-${link.id}`);
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
    if (
      !(await confirmAction(
        t("cloud.share.revokeConfirmScene", { title: activeCloudSceneTitle }),
        {
          title: t("cloud.share.revokeConfirmTitle"),
          confirmLabel: t("cloud.share.revoke"),
        },
      ))
    ) {
      return;
    }

    setBusyShareId(`revoke-${link.id}`);
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
      setCloudError(null);
      setRoomNotice(null);
      props.onRoomNotice?.(null);
      // Check before creating the binding: a blocked start would otherwise
      // leave a binding (and a copied link) that nobody hosts.
      const blocker = props.getCollabRoomStartBlocker?.() ?? null;
      if (blocker) {
        setRoomNotice(blocker);
        return;
      }

      setCreatingCollabRoom(true);
      try {
        const { roomId, roomKey } =
          await shareLink.generateCollaborationLinkData();
        const created = await backend.collabRooms.createForScene({
          sceneId: activeCloudScene.id,
          roomId,
        });
        const link = shareLink.getCollaborationLink({ roomId, roomKey });
        try {
          if (props.onStartCollabRoom) {
            await props.onStartCollabRoom({ roomId, roomKey });
          } else {
            await collabAPI.startCollaboration(
              { roomId, roomKey },
              { preserveLocalScene: true },
            );
          }
        } catch (error) {
          // The session didn't start: drop the binding we just made.
          await backend.collabRooms.revoke(created.id).catch(() => {});
          await loadCollabRoomStats();
          throw error;
        }
        setCollabRoomLink(link);
        try {
          await copyTextToSystemClipboard(link);
        } catch {
          // The dialog switches to the active-room view, which shows the
          // link with its own copy button: say so there.
          props.onRoomNotice?.(t("cloud.collabRooms.createdCopyFailed"));
        }
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

    await startLocalSession();
  };

  // Plain (non-cloud) session. Guarded so a double click can't start twice.
  const startLocalSession = async () => {
    if (!collabAPI || startingSessionRef.current) {
      return;
    }
    startingSessionRef.current = true;
    setStartingSession(true);
    trackEvent("share", "room creation", `ui (${getFrame()})`);
    try {
      await collabAPI.startCollaboration(null);
    } finally {
      startingSessionRef.current = false;
      setStartingSession(false);
    }
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
      !(await confirmAction(
        t("cloud.collabRooms.revokeConfirmScene", {
          title: activeCloudSceneTitle,
        }),
        {
          title: t("cloud.collabRooms.revokeConfirmTitle"),
          confirmLabel: t("cloud.collabRooms.revoke"),
        },
      ))
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
            status={startingSession ? "loading" : null}
            onClick={() => startLocalSession()}
          />
        </div>
      ) : (
        <div className="ShareDialog__options">
          <section className="ShareDialog__option">
            <div className="ShareDialog__optionHeader">
              <strong>{t("roomDialog.realtimeRoomTitle")}</strong>
              <Badge tone="info">{t("roomDialog.realtimeRoomBadge")}</Badge>
            </div>
            <p>{t("roomDialog.realtimeRoomDescription")}</p>
            {activeCloudScene &&
              isSignedIn &&
              (collabRoomStats.status === "error" ? (
                <Callout tone="danger" live={false}>
                  {collabRoomStats.message}
                </Callout>
              ) : (
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
              ))}
            {collabRoomStats.status === "ready" &&
              collabRoomStats.room &&
              !collabRoomLink && (
                <small>{t("cloud.collabRooms.keyNotStored")}</small>
              )}
            {roomNotice && <Callout tone="warning">{roomNotice}</Callout>}
            <div className="ShareDialog__optionActions">
              <UiButton
                variant="primary"
                icon={playerPlayIcon}
                loading={creatingCollabRoom || startingSession}
                onClick={() => void handleCreateRealtimeRoom()}
                disabled={revokingCollabRoom}
              >
                {creatingCollabRoom
                  ? t("cloud.collabRooms.creating")
                  : t("roomDialog.button_startSession")}
              </UiButton>
              <UiButton
                icon={copyIcon}
                onClick={() => void handleCopyCollabRoom()}
                disabled={!collabRoomLink || creatingCollabRoom}
              >
                {t("cloud.collabRooms.copyLink")}
              </UiButton>
              {activeCloudScene && isSignedIn && (
                <UiButton
                  variant="danger"
                  loading={revokingCollabRoom}
                  onClick={() => void handleRevokeCollabRoom()}
                  disabled={
                    collabRoomStats.status !== "ready" ||
                    !collabRoomStats.room ||
                    creatingCollabRoom
                  }
                >
                  {revokingCollabRoom
                    ? t("cloud.collabRooms.revoking")
                    : t("cloud.collabRooms.revoke")}
                </UiButton>
              )}
            </div>
          </section>

          <section className="ShareDialog__option">
            <div className="ShareDialog__optionHeader">
              <strong>{t("roomDialog.cloudShareTitle")}</strong>
              <Badge tone="info">{t("roomDialog.cloudShareBadge")}</Badge>
            </div>
            <p>{t("roomDialog.cloudShareDescription")}</p>
            {activeCloudScene ? (
              <small title={activeCloudSceneTitle}>
                {t("roomDialog.cloudShareCurrentScene", {
                  title: activeCloudSceneTitle,
                })}
              </small>
            ) : (
              !cloudShareBlockedReason && (
                <small>{t("roomDialog.cloudShareSaveFirst")}</small>
              )
            )}

            {cloudShareBlockedReason && (
              <Callout
                tone="info"
                live={false}
                action={
                  !isSignedIn &&
                  props.onSignIn && (
                    <UiButton
                      size="sm"
                      onClick={() => {
                        props.handleClose();
                        props.onSignIn?.();
                      }}
                    >
                      {t("cloud.auth.signInAction")}
                    </UiButton>
                  )
                }
              >
                {cloudShareBlockedReason}
              </Callout>
            )}

            {activeCloudScene && !cloudShareBlockedReason && (
              <div className="ShareDialog__cloudShareActions">
                <UiButton
                  icon={LinkIcon}
                  loading={busyShareId === "create-read"}
                  onClick={() => void handleCreateCloudShare("read")}
                  disabled={
                    shareLoading ||
                    (busyShareId !== null && busyShareId !== "create-read")
                  }
                >
                  {t("cloud.share.createRead")}
                </UiButton>
                <UiButton
                  icon={LinkIcon}
                  loading={busyShareId === "create-write"}
                  onClick={() => void handleCreateCloudShare("write")}
                  disabled={
                    shareLoading ||
                    (busyShareId !== null && busyShareId !== "create-write")
                  }
                >
                  {t("cloud.share.createWrite")}
                </UiButton>
              </div>
            )}

            {!activeCloudScene && isSignedIn && props.onSaveCloudScene && (
              <div className="ShareDialog__cloudShareActions">
                <UiButton
                  variant="primary"
                  icon={LinkIcon}
                  loading={savingCloudScene}
                  onClick={() => void handleSaveCloudScene()}
                >
                  {savingCloudScene
                    ? t("cloud.scenes.saving")
                    : t("cloud.scenes.saveToCloud")}
                </UiButton>
              </div>
            )}

            {shareNotice && <Callout tone="warning">{shareNotice}</Callout>}

            {activeCloudScene &&
              !cloudShareBlockedReason &&
              (shareLoading ? (
                <div className="ShareDialog__status">
                  {t("cloud.share.loading")}
                </div>
              ) : shareListError ? (
                <Callout tone="danger" live={false}>
                  {shareListError}
                </Callout>
              ) : shareLinks.length === 0 ? (
                <div className="ShareDialog__status">
                  {t("cloud.share.empty")}
                </div>
              ) : (
                <ul className="ShareDialog__linkList">
                  {shareLinks.map((link) => (
                    <ListRow
                      key={link.id}
                      title={
                        link.mode === "read"
                          ? t("cloud.share.modeRead")
                          : t("cloud.share.modeWrite")
                      }
                      badges={
                        <Badge tone={link.revoked ? "neutral" : "success"}>
                          {link.revoked
                            ? t("cloud.share.revoked")
                            : t("cloud.share.active")}
                        </Badge>
                      }
                      actions={
                        // A revoked link has nothing left to do.
                        !link.revoked && (
                          <>
                            <UiButton
                              size="sm"
                              variant="ghost"
                              icon={copyIcon}
                              loading={busyShareId === `copy-${link.id}`}
                              onClick={() => void handleCopyCloudShare(link)}
                              disabled={busyShareId !== null}
                            >
                              {t("cloud.share.copy")}
                            </UiButton>
                            <UiButton
                              size="sm"
                              variant="danger"
                              loading={busyShareId === `revoke-${link.id}`}
                              onClick={() => void handleRevokeCloudShare(link)}
                              disabled={busyShareId !== null}
                            >
                              {t("cloud.share.revoke")}
                            </UiButton>
                          </>
                        )
                      }
                    />
                  ))}
                </ul>
              ))}
          </section>
        </div>
      )}

      {cloudError && <Callout tone="danger">{cloudError}</Callout>}

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
  const { t } = useI18n();
  const activeRoomLink = useAtomValue(activeRoomLinkAtom);
  // Lives here so a notice set by the picker survives its unmount.
  const [roomNotice, setRoomNotice] = useState<string | null>(null);

  return (
    <AppDialog
      size="regular"
      onCloseRequest={props.handleClose}
      // The picker and the active-room view render their own headings.
      title={false}
      ariaLabel={t("labels.share")}
    >
      <div className="ShareDialog">
        {props.collabAPI && activeRoomLink ? (
          <ActiveRoomDialog
            collabAPI={props.collabAPI}
            activeRoomLink={activeRoomLink}
            handleClose={props.handleClose}
            inputTargetId={props.inputTargetId}
            notice={roomNotice}
          />
        ) : (
          <ShareDialogPicker {...props} onRoomNotice={setRoomNotice} />
        )}
      </div>
    </AppDialog>
  );
};

export const ShareDialog = (
  props: Omit<
    ShareDialogProps,
    "handleClose" | "inputTargetId" | "type" | "onRoomNotice"
  >,
) => {
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
      onSignIn={props.onSignIn}
      getCollabRoomStartBlocker={props.getCollabRoomStartBlocker}
      onStartCollabRoom={props.onStartCollabRoom}
      collabRoomRefreshKey={props.collabRoomRefreshKey}
      onCollabRoomChanged={props.onCollabRoomChanged}
      onCollabRoomRevoked={props.onCollabRoomRevoked}
      type={shareDialogState.type}
    />
  );
};
