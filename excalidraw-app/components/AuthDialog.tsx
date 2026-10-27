/**
 * AuthDialog — standalone, controlled cloud sign-in dialog (Phase 1, decision
 * 0008 §5).
 *
 * Self-contained on purpose: the parent only controls `open`/`onClose` and is
 * notified via `onSignedIn`. It owns NO layout assumptions, so it can be
 * triggered from a menu item, a toolbar button, or anywhere the final layout
 * lands. State/auth flows through `useCloudAuth` (the single source of truth).
 *
 * First version is email + password only (the frozen contract reserves
 * oauth/magic-link; 0006 §8). Errors are shown via `BackendError.message`,
 * which is already sanitized for direct display (NFR-SEC).
 */

import { THEME } from "@excalidraw/common";
import { chevronRight } from "@excalidraw/excalidraw/components/icons";
import { useUIAppState } from "@excalidraw/excalidraw/context/ui-appState";
import { t } from "@excalidraw/excalidraw/i18n";
import { AudioAvatar } from "@excalidraw/excalidraw/voice/AudioAvatar";
import { getDefaultAudioAvatar } from "@excalidraw/element";
import React, { useCallback, useEffect, useId, useState } from "react";

import { useCloudAuth } from "../auth/useCloudAuth";
import {
  BackendError,
  getCloudBackend,
  shareLink,
  type AITaskStatus,
  type CastSessionStatus,
  type CollabRoomRecord,
  type EmbedMode,
  type SceneSummary,
} from "../data/cloud";
import { readCloudDeploymentConfig } from "../data/cloud/deploymentConfig";

import { AccountAISettingsSync } from "./AccountAISettingsSync";
import { AccountAvatarSettings } from "./AccountAvatarSettings";
import {
  AppDialog,
  Callout,
  DialogActions,
  DialogSection,
  Field,
  TabList,
  TextInput,
  UiButton,
  confirmAction,
  getTabPanelProps,
} from "./ui";

import "./AuthDialog.scss";

type DialogError = { message: string; code?: string };

const toDialogError = (err: unknown, fallback: string): DialogError => ({
  message: err instanceof Error ? err.message : fallback,
  code: err instanceof BackendError ? err.code : undefined,
});

const getAITaskStatusLabel = (status: AITaskStatus) => {
  if (status === "succeeded") {
    return t("cloud.aiTasks.statusSucceeded");
  }
  if (status === "failed") {
    return t("cloud.aiTasks.statusFailed");
  }
  if (status === "cancelled") {
    return t("cloud.aiTasks.statusCancelled");
  }
  if (status === "running") {
    return t("cloud.aiTasks.statusRunning");
  }
  return t("cloud.aiTasks.statusQueued");
};

const getCastSessionStatusLabel = (status: CastSessionStatus) => {
  if (status === "ready") {
    return t("cloud.castArtifacts.statusReady");
  }
  if (status === "exported") {
    return t("cloud.castArtifacts.statusExported");
  }
  if (status === "archived") {
    return t("cloud.castArtifacts.statusArchived");
  }
  return t("cloud.castArtifacts.statusDraft");
};

const getEmbedModeLabel = (mode: EmbedMode) => {
  if (mode === "write") {
    return t("cloud.embed.modeWrite");
  }
  if (mode === "collab") {
    return t("cloud.embed.modeCollab");
  }
  return t("cloud.embed.modeRead");
};

const getAvailabilityLabel = (available: boolean) =>
  available
    ? t("cloud.deployment.available")
    : t("cloud.deployment.unavailable");

const getCollabRoomStatusLabel = (room: CollabRoomRecord | null) =>
  room ? t("cloud.collabRooms.active") : t("cloud.collabRooms.empty");

/** Resolves false instead of throwing; no clipboard API counts as a failure. */
const copyText = async (text: string) => {
  try {
    if (!navigator.clipboard?.writeText) {
      return false;
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

export type CloudSceneRemoteUpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "up-to-date"; checkedAt: number }
  | { status: "remote-newer"; metadata: SceneSummary; checkedAt: number }
  | { status: "error"; message: string; checkedAt: number };

export interface ActiveCloudSceneInfo {
  id: string;
  title: string;
  version: number;
  updatedAt: number;
}

export interface AuthDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful sign-in (e.g. to open the scene list). */
  onSignedIn?: () => void;
  /** Opens the user's cloud whiteboard list from the account panel. */
  onOpenCloudScenes?: () => void;
  /** Opens the user's cloud AI task list from the account panel. */
  onOpenAITasks?: () => void;
  /** Opens embed management for the current cloud whiteboard. */
  onOpenEmbeds?: () => void;
  /** Saves the current whiteboard to the signed-in cloud account. */
  onSaveCloudScene?: () => void | Promise<void>;
  /** Saves the current whiteboard as a new end-to-end encrypted cloud scene. */
  onSaveEncryptedCloudScene?: () => void | Promise<void>;
  /** Current account-owned cloud whiteboard, if the local canvas is bound. */
  activeCloudScene?: ActiveCloudSceneInfo | null;
  /** Whether a realtime collaboration room is currently active. */
  isCollaborationActive?: boolean;
  /** Latest lightweight remote-version check result for the current whiteboard. */
  cloudSceneRemoteUpdate?: CloudSceneRemoteUpdateState;
  /** Checks whether the current cloud whiteboard has a newer remote version. */
  onCheckCurrentCloudScene?: () => void | Promise<void>;
  /** Reloads the current cloud whiteboard from the backend. */
  onRefreshCurrentCloudScene?: () => void | Promise<void>;
  /**
   * Starts local realtime collaboration after creating a cloud room binding.
   * Throw when the session did not start: the dialog then revokes the binding.
   */
  onStartCollabRoom?: (room: {
    roomId: string;
    roomKey: string;
  }) => void | Promise<void>;
  /**
   * Returns why a live session can't start right now (already collaborating,
   * AI video on the canvas, ...). Checked before any room binding is created.
   */
  getCollabRoomStartBlocker?: () => string | null;
  /** Refresh token shared with other collaboration controls. */
  collabRoomRefreshKey?: number;
  /** Called after a cloud collaboration room binding changes. */
  onCollabRoomChanged?: () => void;
  /** Called after a cloud collaboration room binding is revoked. */
  onCollabRoomRevoked?: (room: CollabRoomRecord) => void | Promise<void>;
}

export const AuthDialog: React.FC<AuthDialogProps> = ({
  open,
  onClose,
  onSignedIn,
  onOpenCloudScenes,
  onOpenAITasks,
  onOpenEmbeds,
  onSaveCloudScene,
  onSaveEncryptedCloudScene,
  activeCloudScene,
  cloudSceneRemoteUpdate = { status: "idle" },
  onCheckCurrentCloudScene,
  onRefreshCurrentCloudScene,
  onStartCollabRoom,
  getCollabRoomStartBlocker,
  collabRoomRefreshKey,
  onCollabRoomChanged,
  onCollabRoomRevoked,
  isCollaborationActive = false,
}) => {
  const { isSignedIn, user, signIn, signOut } = useCloudAuth();
  const uiAppState = useUIAppState() as ReturnType<typeof useUIAppState> | null;
  const theme = uiAppState?.theme ?? THEME.LIGHT;
  const tabIdPrefix = useId();
  // the component stays mounted while closed, so reopening keeps the tab
  const [activeTab, setActiveTab] = useState<
    "account" | "whiteboard" | "deployment"
  >("account");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<DialogError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [savingCloudScene, setSavingCloudScene] = useState(false);
  const [savingEncryptedCloudScene, setSavingEncryptedCloudScene] =
    useState(false);
  const [checkingCurrentScene, setCheckingCurrentScene] = useState(false);
  const [refreshingCurrentScene, setRefreshingCurrentScene] = useState(false);
  const [refreshingCastStats, setRefreshingCastStats] = useState(false);
  const [refreshingEmbedStats, setRefreshingEmbedStats] = useState(false);
  const [refreshingCollabRoom, setRefreshingCollabRoom] = useState(false);
  const [creatingCollabRoom, setCreatingCollabRoom] = useState(false);
  const [revokingCollabRoom, setRevokingCollabRoom] = useState(false);
  const [collabRoomLink, setCollabRoomLink] = useState<string | null>(null);
  // Non-error guidance shown inside the room card (start blocked, copy failed).
  const [collabRoomNotice, setCollabRoomNotice] = useState<string | null>(null);
  const [sceneStats, setSceneStats] = useState<
    | { status: "idle" | "loading" | "unavailable" }
    | {
        status: "ready";
        count: number;
        latestTitle: string | null;
      }
    | { status: "error"; message: string; code?: string }
  >({ status: "idle" });
  const [taskStats, setTaskStats] = useState<
    | { status: "idle" | "loading" | "unavailable" }
    | {
        status: "ready";
        count: number;
        latestStatus: AITaskStatus | null;
      }
    | { status: "error"; message: string; code?: string }
  >({ status: "idle" });
  const [castStats, setCastStats] = useState<
    | { status: "idle" | "loading" | "unavailable" }
    | {
        status: "ready";
        sessionCount: number;
        exportCount: number;
        latestStatus: CastSessionStatus | null;
      }
    | { status: "error"; message: string; code?: string }
  >({ status: "idle" });
  const [embedStats, setEmbedStats] = useState<
    | { status: "idle" | "loading" | "unavailable" }
    | {
        status: "ready";
        count: number;
        latestMode: EmbedMode | null;
      }
    | { status: "error"; message: string; code?: string }
  >({ status: "idle" });
  const [collabRoomStats, setCollabRoomStats] = useState<
    | { status: "idle" | "loading" | "unavailable" }
    | { status: "ready"; room: CollabRoomRecord | null }
    | { status: "error"; message: string; code?: string }
  >({ status: "idle" });

  const deploymentConfig = readCloudDeploymentConfig();

  const loadSceneStats = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      if (!isSignedIn) {
        setSceneStats({ status: "idle" });
        return;
      }

      const backend = getCloudBackend();
      if (!backend.capabilities.sceneStorage) {
        setSceneStats({ status: "unavailable" });
        return;
      }

      setSceneStats({ status: "loading" });
      try {
        const scenes = await backend.scenes.list({ sort: "updatedAt" });
        if (isCancelled()) {
          return;
        }

        setSceneStats({
          status: "ready",
          count: scenes.length,
          latestTitle: scenes[0]?.title ?? null,
        });
      } catch (err) {
        if (isCancelled()) {
          return;
        }

        setSceneStats({
          status: "error",
          ...toDialogError(err, t("cloud.scenes.genericError")),
        });
      }
    },
    [isSignedIn],
  );

  const loadTaskStats = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      if (!isSignedIn) {
        setTaskStats({ status: "idle" });
        return;
      }

      const backend = getCloudBackend();
      if (!backend.capabilities.aiTasks) {
        setTaskStats({ status: "unavailable" });
        return;
      }

      setTaskStats({ status: "loading" });
      try {
        const tasks = await backend.aiTasks.list({ limit: 20 });
        if (isCancelled()) {
          return;
        }

        setTaskStats({
          status: "ready",
          count: tasks.length,
          latestStatus: tasks[0]?.status ?? null,
        });
      } catch (err) {
        if (isCancelled()) {
          return;
        }

        setTaskStats({
          status: "error",
          ...toDialogError(err, t("cloud.aiTasks.genericError")),
        });
      }
    },
    [isSignedIn],
  );

  const loadCastStats = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      if (!isSignedIn || !activeCloudScene) {
        setCastStats({ status: "idle" });
        return;
      }

      const backend = getCloudBackend();
      if (!backend.capabilities.cast) {
        setCastStats({ status: "unavailable" });
        return;
      }

      setCastStats({ status: "loading" });
      try {
        const [sessions, exports] = await Promise.all([
          backend.cast.listByScene(activeCloudScene.id, { limit: 20 }),
          backend.cast.listExportsByScene(activeCloudScene.id, { limit: 20 }),
        ]);
        if (isCancelled()) {
          return;
        }

        setCastStats({
          status: "ready",
          sessionCount: sessions.length,
          exportCount: exports.length,
          latestStatus: sessions[0]?.status ?? null,
        });
      } catch (err) {
        if (isCancelled()) {
          return;
        }

        setCastStats({
          status: "error",
          ...toDialogError(err, t("cloud.castArtifacts.genericError")),
        });
      }
    },
    [activeCloudScene, isSignedIn],
  );

  const loadEmbedStats = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      if (!isSignedIn || !activeCloudScene) {
        setEmbedStats({ status: "idle" });
        return;
      }

      const backend = getCloudBackend();
      if (!backend.capabilities.embed) {
        setEmbedStats({ status: "unavailable" });
        return;
      }

      setEmbedStats({ status: "loading" });
      try {
        const embeds = await backend.embed.listByScene(activeCloudScene.id, {
          limit: 20,
        });
        if (isCancelled()) {
          return;
        }

        setEmbedStats({
          status: "ready",
          count: embeds.length,
          latestMode: embeds[0]?.mode ?? null,
        });
      } catch (err) {
        if (isCancelled()) {
          return;
        }

        setEmbedStats({
          status: "error",
          ...toDialogError(err, t("cloud.embed.genericError")),
        });
      }
    },
    [activeCloudScene, isSignedIn],
  );

  const loadCollabRoomStats = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      if (!isSignedIn || !activeCloudScene) {
        setCollabRoomStats({ status: "idle" });
        return;
      }

      const backend = getCloudBackend();
      if (!backend.capabilities.collabRoomBinding) {
        setCollabRoomStats({ status: "unavailable" });
        return;
      }

      setCollabRoomStats({ status: "loading" });
      try {
        const room = await backend.collabRooms.getByScene(activeCloudScene.id);
        if (isCancelled()) {
          return;
        }

        setCollabRoomStats({ status: "ready", room });
      } catch (err) {
        if (isCancelled()) {
          return;
        }

        setCollabRoomStats({
          status: "error",
          ...toDialogError(err, t("cloud.collabRooms.genericError")),
        });
      }
    },
    [activeCloudScene, isSignedIn],
  );

  useEffect(() => {
    if (!open || !isSignedIn) {
      setSceneStats({ status: "idle" });
      setTaskStats({ status: "idle" });
      setCastStats({ status: "idle" });
      setEmbedStats({ status: "idle" });
      setCollabRoomStats({ status: "idle" });
      return;
    }

    let cancelled = false;
    void loadSceneStats(() => cancelled);
    void loadTaskStats(() => cancelled);
    void loadCastStats(() => cancelled);
    void loadEmbedStats(() => cancelled);
    void loadCollabRoomStats(() => cancelled);

    return () => {
      cancelled = true;
    };
  }, [
    isSignedIn,
    loadCastStats,
    loadCollabRoomStats,
    loadEmbedStats,
    loadSceneStats,
    loadTaskStats,
    open,
  ]);

  useEffect(() => {
    if (!open || !isSignedIn || !collabRoomRefreshKey) {
      return;
    }

    void loadCollabRoomStats();
  }, [collabRoomRefreshKey, isSignedIn, loadCollabRoomStats, open]);

  if (!open) {
    return null;
  }

  const reset = () => {
    setEmail("");
    setPassword("");
    setError(null);
    setSubmitting(false);
    setSigningOut(false);
    setSavingCloudScene(false);
    setCheckingCurrentScene(false);
    setRefreshingCurrentScene(false);
    setRefreshingCastStats(false);
    setRefreshingEmbedStats(false);
    setRefreshingCollabRoom(false);
    setCreatingCollabRoom(false);
    setRevokingCollabRoom(false);
    setSavingEncryptedCloudScene(false);
    setCollabRoomNotice(null);
  };

  const dialogBusy =
    submitting ||
    signingOut ||
    savingCloudScene ||
    checkingCurrentScene ||
    refreshingCurrentScene ||
    refreshingEmbedStats ||
    refreshingCollabRoom ||
    creatingCollabRoom ||
    revokingCollabRoom ||
    savingEncryptedCloudScene;

  const handleClose = () => {
    if (dialogBusy) {
      return;
    }
    reset();
    onClose();
  };

  // Keep typing from triggering editor shortcuts, but let Escape through so
  // it still closes the dialog.
  const stopShortcutPropagation = (event: React.KeyboardEvent) => {
    if (event.key !== "Escape") {
      event.stopPropagation();
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) {
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await signIn(email.trim(), password);
      reset();
      onClose();
      onSignedIn?.();
    } catch (err) {
      // BackendError.message is already sanitized for display.
      setError(toDialogError(err, t("cloud.auth.genericError")));
      setSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    if (signingOut) {
      return;
    }

    setError(null);
    setSigningOut(true);
    try {
      await signOut();
      reset();
      onClose();
    } catch (err) {
      setError(toDialogError(err, t("cloud.auth.genericError")));
      setSigningOut(false);
    }
  };

  const handleOpenCloudScenes = () => {
    if (
      submitting ||
      signingOut ||
      checkingCurrentScene ||
      refreshingCurrentScene ||
      !onOpenCloudScenes
    ) {
      return;
    }
    reset();
    onClose();
    onOpenCloudScenes();
  };

  const handleOpenAITasks = () => {
    if (
      submitting ||
      signingOut ||
      checkingCurrentScene ||
      refreshingCurrentScene ||
      !onOpenAITasks
    ) {
      return;
    }
    reset();
    onClose();
    onOpenAITasks();
  };

  const handleOpenEmbeds = () => {
    if (
      submitting ||
      signingOut ||
      checkingCurrentScene ||
      refreshingCurrentScene ||
      !onOpenEmbeds
    ) {
      return;
    }
    reset();
    onClose();
    onOpenEmbeds();
  };

  const handleSaveCloudScene = async () => {
    if (
      submitting ||
      signingOut ||
      savingCloudScene ||
      checkingCurrentScene ||
      refreshingCurrentScene ||
      !onSaveCloudScene
    ) {
      return;
    }

    setSavingCloudScene(true);
    setError(null);
    try {
      await onSaveCloudScene();
      await loadSceneStats();
    } catch (err) {
      // A toast would render under this dialog; show the failure here.
      setError(toDialogError(err, t("cloud.scenes.saveFailed")));
    } finally {
      setSavingCloudScene(false);
    }
  };

  const handleSaveEncryptedCloudScene = async () => {
    if (
      submitting ||
      signingOut ||
      savingCloudScene ||
      savingEncryptedCloudScene ||
      checkingCurrentScene ||
      refreshingCurrentScene ||
      !onSaveEncryptedCloudScene
    ) {
      return;
    }

    setSavingEncryptedCloudScene(true);
    setError(null);
    try {
      await onSaveEncryptedCloudScene();
      await loadSceneStats();
    } catch (err) {
      setError(toDialogError(err, t("cloud.e2e.saveFailed")));
    } finally {
      setSavingEncryptedCloudScene(false);
    }
  };

  const handleCheckCurrentCloudScene = async () => {
    if (
      submitting ||
      signingOut ||
      checkingCurrentScene ||
      refreshingCurrentScene ||
      !onCheckCurrentCloudScene
    ) {
      return;
    }

    setCheckingCurrentScene(true);
    try {
      await onCheckCurrentCloudScene();
    } finally {
      setCheckingCurrentScene(false);
    }
  };

  const handleRefreshCurrentCloudScene = async () => {
    if (
      submitting ||
      signingOut ||
      checkingCurrentScene ||
      refreshingCurrentScene ||
      !onRefreshCurrentCloudScene
    ) {
      return;
    }

    setRefreshingCurrentScene(true);
    try {
      await onRefreshCurrentCloudScene();
      await loadSceneStats();
    } finally {
      setRefreshingCurrentScene(false);
    }
  };

  const handleRefreshCastStats = async () => {
    if (
      submitting ||
      signingOut ||
      savingCloudScene ||
      checkingCurrentScene ||
      refreshingCurrentScene ||
      refreshingCastStats
    ) {
      return;
    }

    setRefreshingCastStats(true);
    try {
      await loadCastStats();
    } finally {
      setRefreshingCastStats(false);
    }
  };

  const handleRefreshEmbedStats = async () => {
    if (
      submitting ||
      signingOut ||
      savingCloudScene ||
      checkingCurrentScene ||
      refreshingCurrentScene ||
      refreshingEmbedStats
    ) {
      return;
    }

    setRefreshingEmbedStats(true);
    try {
      await loadEmbedStats();
    } finally {
      setRefreshingEmbedStats(false);
    }
  };

  const handleRefreshCollabRoom = async () => {
    if (
      submitting ||
      signingOut ||
      savingCloudScene ||
      checkingCurrentScene ||
      refreshingCurrentScene ||
      refreshingCollabRoom ||
      creatingCollabRoom ||
      revokingCollabRoom
    ) {
      return;
    }

    setRefreshingCollabRoom(true);
    try {
      await loadCollabRoomStats();
    } finally {
      setRefreshingCollabRoom(false);
    }
  };

  const handleCreateCollabRoom = async () => {
    if (
      submitting ||
      signingOut ||
      savingCloudScene ||
      checkingCurrentScene ||
      refreshingCurrentScene ||
      refreshingCollabRoom ||
      creatingCollabRoom ||
      revokingCollabRoom ||
      !activeCloudScene
    ) {
      return;
    }

    const backend = getCloudBackend();
    if (!backend.capabilities.collabRoomBinding) {
      return;
    }

    setError(null);
    setCollabRoomNotice(null);
    // Check before creating the binding: a blocked start would otherwise
    // leave a binding (and a copied link) that nobody hosts.
    const blocker = getCollabRoomStartBlocker?.() ?? null;
    if (blocker) {
      setCollabRoomNotice(blocker);
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
      try {
        await onStartCollabRoom?.({ roomId, roomKey });
      } catch (err) {
        // The session didn't start: drop the binding we just made.
        await backend.collabRooms.revoke(created.id).catch(() => {});
        await loadCollabRoomStats();
        throw err;
      }
      const link = shareLink.getCollaborationLink({ roomId, roomKey });
      setCollabRoomLink(link);
      // The room exists now; a clipboard failure must not look like a
      // create failure or skip the refresh below.
      if (!(await copyText(link))) {
        setCollabRoomNotice(t("cloud.collabRooms.createdCopyFailed"));
      }
      await loadCollabRoomStats();
      onCollabRoomChanged?.();
    } catch (err) {
      setError(toDialogError(err, t("cloud.collabRooms.genericError")));
    } finally {
      setCreatingCollabRoom(false);
    }
  };

  const handleCopyCollabRoom = async () => {
    if (!collabRoomLink) {
      return;
    }
    setCollabRoomNotice(null);
    if (!(await copyText(collabRoomLink))) {
      setCollabRoomNotice(t("cloud.collabRooms.copyFailed"));
    }
  };

  const handleRevokeCollabRoom = async () => {
    if (
      submitting ||
      signingOut ||
      savingCloudScene ||
      checkingCurrentScene ||
      refreshingCurrentScene ||
      refreshingCollabRoom ||
      creatingCollabRoom ||
      revokingCollabRoom ||
      collabRoomStats.status !== "ready" ||
      !collabRoomStats.room ||
      !(await confirmAction(
        t("cloud.collabRooms.revokeConfirmScene", {
          title:
            activeCloudScene?.title ?? t("cloud.auth.currentCloudWhiteboard"),
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
    setError(null);
    setCollabRoomNotice(null);
    try {
      const room = collabRoomStats.room;
      await getCloudBackend().collabRooms.revoke(room.id);
      await onCollabRoomRevoked?.(room);
      setCollabRoomLink(null);
      await loadCollabRoomStats();
      onCollabRoomChanged?.();
    } catch (err) {
      setError(toDialogError(err, t("cloud.collabRooms.genericError")));
    } finally {
      setRevokingCollabRoom(false);
    }
  };

  const accountLabel =
    user?.email || user?.displayName || t("cloud.auth.account");
  // same fallback the avatar settings use, so the header matches the bubble
  const identityName = user?.displayName || user?.email || null;

  const cloudSceneCountLabel =
    sceneStats.status === "loading"
      ? t("cloud.auth.cloudWhiteboardsLoading")
      : sceneStats.status === "unavailable"
      ? t("cloud.auth.cloudWhiteboardsUnavailable")
      : sceneStats.status === "error"
      ? t("cloud.auth.cloudWhiteboardsUnavailable")
      : sceneStats.status === "ready"
      ? t("cloud.auth.cloudWhiteboardsCount", {
          count: sceneStats.count,
        })
      : t("cloud.auth.cloudWhiteboardsLoading");

  const cloudTaskCountLabel =
    taskStats.status === "loading"
      ? t("cloud.auth.cloudAITasksLoading")
      : taskStats.status === "unavailable"
      ? t("cloud.auth.cloudAITasksUnavailable")
      : taskStats.status === "error"
      ? t("cloud.auth.cloudAITasksUnavailable")
      : taskStats.status === "ready"
      ? t("cloud.auth.cloudAITasksCount", {
          count: taskStats.count,
        })
      : t("cloud.auth.cloudAITasksLoading");

  const currentSceneStatusLabel =
    cloudSceneRemoteUpdate.status === "checking" || checkingCurrentScene
      ? t("cloud.auth.currentCloudWhiteboardChecking")
      : cloudSceneRemoteUpdate.status === "remote-newer"
      ? t("cloud.auth.currentCloudWhiteboardRemoteNewer")
      : cloudSceneRemoteUpdate.status === "up-to-date"
      ? t("cloud.auth.currentCloudWhiteboardUpToDate")
      : cloudSceneRemoteUpdate.status === "error"
      ? cloudSceneRemoteUpdate.message
      : t("cloud.auth.currentCloudWhiteboardIdle");

  const castStatsLabel =
    castStats.status === "loading" || refreshingCastStats
      ? t("cloud.castArtifacts.loading")
      : castStats.status === "unavailable"
      ? t("cloud.castArtifacts.unavailable")
      : castStats.status === "error"
      ? t("cloud.castArtifacts.unavailable")
      : castStats.status === "ready"
      ? t("cloud.castArtifacts.count", {
          sessions: castStats.sessionCount,
          exports: castStats.exportCount,
        })
      : t("cloud.castArtifacts.loading");

  const embedStatsLabel =
    embedStats.status === "loading" || refreshingEmbedStats
      ? t("cloud.embed.loading")
      : embedStats.status === "unavailable"
      ? t("cloud.embed.unavailable")
      : embedStats.status === "error"
      ? t("cloud.embed.unavailable")
      : embedStats.status === "ready"
      ? t("cloud.embed.count", {
          count: embedStats.count,
        })
      : t("cloud.embed.loading");

  const collabRoomStatsLabel =
    collabRoomStats.status === "loading" || refreshingCollabRoom
      ? t("cloud.collabRooms.loading")
      : collabRoomStats.status === "unavailable"
      ? t("cloud.collabRooms.unavailable")
      : collabRoomStats.status === "error"
      ? t("cloud.collabRooms.unavailable")
      : collabRoomStats.status === "ready"
      ? getCollabRoomStatusLabel(collabRoomStats.room)
      : t("cloud.collabRooms.loading");

  const canCheckCurrentScene =
    !!activeCloudScene &&
    !!onCheckCurrentCloudScene &&
    !signingOut &&
    !savingCloudScene &&
    !checkingCurrentScene &&
    !refreshingCurrentScene;

  const canRefreshCurrentScene =
    !!activeCloudScene &&
    !!onRefreshCurrentCloudScene &&
    cloudSceneRemoteUpdate.status === "remote-newer" &&
    !signingOut &&
    !savingCloudScene &&
    !checkingCurrentScene &&
    !refreshingCurrentScene;

  const sceneBusy =
    signingOut ||
    savingCloudScene ||
    checkingCurrentScene ||
    refreshingCurrentScene;
  const roomBusy =
    sceneBusy ||
    refreshingCollabRoom ||
    creatingCollabRoom ||
    revokingCollabRoom;

  const dialogTitle = isSignedIn
    ? t("cloud.auth.accountTitle")
    : t("cloud.auth.signInTitle");

  const errorCallout = error && (
    <Callout tone="danger" details={error.code}>
      {error.message}
    </Callout>
  );

  const renderStatsError = (stats: { message: string; code?: string }) => (
    <Callout tone="danger" live={false} details={stats.code}>
      {stats.message}
    </Callout>
  );

  if (!isSignedIn) {
    return (
      <AppDialog
        className="AuthDialogModal"
        size="small"
        closeOnClickOutside={false}
        busy={dialogBusy}
        onCloseRequest={handleClose}
        title={dialogTitle}
      >
        <form
          className="AuthDialog"
          onSubmit={handleSubmit}
          onKeyDown={stopShortcutPropagation}
        >
          <div className="AuthDialog__scrollBody">
            <p className="AuthDialog__intro">{t("cloud.auth.signInIntro")}</p>

            <Field label={t("cloud.auth.email")}>
              <TextInput
                id="cloud-auth-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                disabled={submitting}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={stopShortcutPropagation}
              />
            </Field>

            <Field label={t("cloud.auth.password")}>
              <TextInput
                id="cloud-auth-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                disabled={submitting}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={stopShortcutPropagation}
              />
            </Field>

            {errorCallout}
          </div>

          <DialogActions className="AuthDialog__actions">
            <UiButton onClick={handleClose} disabled={submitting}>
              {t("cloud.auth.cancel")}
            </UiButton>
            <UiButton
              type="submit"
              variant="primary"
              loading={submitting}
              disabled={!email.trim() || !password}
            >
              {submitting
                ? t("cloud.auth.signingIn")
                : t("cloud.auth.signInAction")}
            </UiButton>
          </DialogActions>
        </form>
      </AppDialog>
    );
  }

  const accountTabs = [
    { value: "account" as const, label: t("cloud.auth.tabAccount") },
    { value: "whiteboard" as const, label: t("cloud.auth.tabWhiteboard") },
    { value: "deployment" as const, label: t("cloud.auth.tabDeployment") },
  ];

  return (
    <AppDialog
      className="AuthDialogModal"
      size="small"
      closeOnClickOutside={false}
      busy={dialogBusy}
      onCloseRequest={handleClose}
      title={dialogTitle}
    >
      <div className="AuthDialog AuthDialog--account">
        <div className="AuthDialog__scrollBody">
          <div className="AuthDialog__identity">
            <AudioAvatar
              avatar={user?.avatar ?? getDefaultAudioAvatar(identityName)}
              size={40}
              theme={theme}
            />
            <div className="AuthDialog__accountIdentity">
              <strong title={accountLabel}>{accountLabel}</strong>
              <span>{t("cloud.auth.signedInAs")}</span>
            </div>
            <UiButton
              variant="ghost"
              size="sm"
              className="AuthDialog__signOut"
              onClick={handleSignOut}
              loading={signingOut}
              disabled={sceneBusy}
            >
              {signingOut
                ? t("cloud.auth.signingOut")
                : t("cloud.auth.signOutShort")}
            </UiButton>
          </div>

          <TabList
            tabs={accountTabs}
            value={activeTab}
            onChange={setActiveTab}
            label={t("cloud.auth.tabsLabel")}
            idPrefix={tabIdPrefix}
            className="AuthDialog__tabs"
          />

          {activeTab === "account" && (
            <div
              className="AuthDialog__panel"
              {...getTabPanelProps(tabIdPrefix, "account")}
            >
              <div className="AuthDialog__accountGrid">
                <button
                  className="AuthDialog__accountCard AuthDialog__accountCard--button"
                  type="button"
                  onClick={handleOpenCloudScenes}
                  disabled={!onOpenCloudScenes || sceneBusy}
                >
                  <span className="AuthDialog__cardLabel">
                    {t("cloud.auth.cloudWhiteboards")}
                    <span
                      className="AuthDialog__cardChevron"
                      aria-hidden="true"
                    >
                      {chevronRight}
                    </span>
                  </span>
                  <strong>{cloudSceneCountLabel}</strong>
                  {sceneStats.status === "ready" && sceneStats.latestTitle && (
                    <small title={sceneStats.latestTitle}>
                      {t("cloud.auth.latestCloudWhiteboard", {
                        title: sceneStats.latestTitle,
                      })}
                    </small>
                  )}
                  {sceneStats.status === "error" && (
                    <small className="AuthDialog__cardError">
                      {sceneStats.message}
                    </small>
                  )}
                </button>

                <button
                  className="AuthDialog__accountCard AuthDialog__accountCard--button"
                  type="button"
                  onClick={handleOpenAITasks}
                  disabled={!onOpenAITasks || sceneBusy}
                >
                  <span className="AuthDialog__cardLabel">
                    {t("cloud.auth.cloudAITasks")}
                    <span
                      className="AuthDialog__cardChevron"
                      aria-hidden="true"
                    >
                      {chevronRight}
                    </span>
                  </span>
                  <strong>{cloudTaskCountLabel}</strong>
                  {taskStats.status === "ready" && taskStats.latestStatus && (
                    <small>
                      {t("cloud.auth.latestCloudAITask", {
                        status: getAITaskStatusLabel(taskStats.latestStatus),
                      })}
                    </small>
                  )}
                  {taskStats.status === "error" && (
                    <small className="AuthDialog__cardError">
                      {taskStats.message}
                    </small>
                  )}
                </button>
              </div>

              <section
                className="AuthDialog__group"
                aria-labelledby={`${tabIdPrefix}-preferences`}
              >
                <h3
                  className="AuthDialog__groupTitle"
                  id={`${tabIdPrefix}-preferences`}
                >
                  {t("cloud.auth.preferences")}
                </h3>
                <div className="AuthDialog__groupBody">
                  <AccountAvatarSettings />
                  <AccountAISettingsSync />
                </div>
              </section>
            </div>
          )}

          {activeTab === "whiteboard" && !activeCloudScene && (
            <div
              className="AuthDialog__panel"
              {...getTabPanelProps(tabIdPrefix, "whiteboard")}
            >
              <p className="AuthDialog__empty">
                {t("cloud.auth.noCloudWhiteboard")}
              </p>
            </div>
          )}

          {activeTab === "whiteboard" && activeCloudScene && (
            <div
              className="AuthDialog__panel"
              {...getTabPanelProps(tabIdPrefix, "whiteboard")}
            >
              <DialogSection
                className="AuthDialog__section AuthDialog__currentScene"
                title={t("cloud.auth.currentCloudWhiteboard")}
              >
                <div className="AuthDialog__summary">
                  <strong title={activeCloudScene.title}>
                    {activeCloudScene.title}
                  </strong>
                  <small>
                    {t("cloud.auth.currentCloudWhiteboardVersion", {
                      version: activeCloudScene.version,
                    })}
                  </small>
                  {cloudSceneRemoteUpdate.status !== "remote-newer" &&
                    cloudSceneRemoteUpdate.status !== "error" && (
                      <small>{currentSceneStatusLabel}</small>
                    )}
                </div>
                {cloudSceneRemoteUpdate.status === "remote-newer" && (
                  <Callout tone="warning">{currentSceneStatusLabel}</Callout>
                )}
                {cloudSceneRemoteUpdate.status === "error" && (
                  <Callout tone="danger" live={false}>
                    {currentSceneStatusLabel}
                  </Callout>
                )}
                <div className="AuthDialog__sectionActions">
                  <UiButton
                    size="sm"
                    onClick={() => void handleCheckCurrentCloudScene()}
                    loading={checkingCurrentScene}
                    disabled={!canCheckCurrentScene}
                  >
                    {checkingCurrentScene
                      ? t("cloud.auth.currentCloudWhiteboardChecking")
                      : t("cloud.auth.checkCurrentCloudWhiteboard")}
                  </UiButton>
                  {cloudSceneRemoteUpdate.status === "remote-newer" && (
                    <UiButton
                      size="sm"
                      variant="primary"
                      onClick={() => void handleRefreshCurrentCloudScene()}
                      loading={refreshingCurrentScene}
                      disabled={!canRefreshCurrentScene}
                    >
                      {refreshingCurrentScene
                        ? t("cloud.auth.refreshingCurrentCloudWhiteboard")
                        : t("cloud.auth.refreshCurrentCloudWhiteboard")}
                    </UiButton>
                  )}
                </div>
              </DialogSection>

              <DialogSection
                className="AuthDialog__section AuthDialog__castCard"
                title={t("cloud.castArtifacts.title")}
              >
                <div className="AuthDialog__summary">
                  <strong>{castStatsLabel}</strong>
                  {castStats.status === "ready" && castStats.latestStatus && (
                    <small>
                      {t("cloud.castArtifacts.latest", {
                        status: getCastSessionStatusLabel(
                          castStats.latestStatus,
                        ),
                      })}
                    </small>
                  )}
                  {castStats.status === "ready" && !castStats.latestStatus && (
                    <small>{t("cloud.castArtifacts.empty")}</small>
                  )}
                </div>
                {castStats.status === "error" && renderStatsError(castStats)}
                <div className="AuthDialog__sectionActions">
                  <UiButton
                    size="sm"
                    variant="ghost"
                    onClick={() => void handleRefreshCastStats()}
                    disabled={
                      sceneBusy || refreshingCastStats || refreshingEmbedStats
                    }
                  >
                    {refreshingCastStats
                      ? t("cloud.castArtifacts.loading")
                      : t("cloud.castArtifacts.refresh")}
                  </UiButton>
                </div>
              </DialogSection>

              <DialogSection
                className="AuthDialog__section AuthDialog__collabRoomCard"
                title={t("cloud.collabRooms.title")}
              >
                <div className="AuthDialog__summary">
                  <strong>{collabRoomStatsLabel}</strong>
                  {collabRoomStats.status === "ready" && collabRoomStats.room && (
                    <small title={collabRoomStats.room.roomId}>
                      {t("cloud.collabRooms.roomId", {
                        roomId: collabRoomStats.room.roomId,
                      })}
                    </small>
                  )}
                  {collabRoomStats.status === "ready" &&
                    collabRoomStats.room &&
                    !collabRoomLink && (
                      <small>{t("cloud.collabRooms.keyNotStored")}</small>
                    )}
                </div>
                {collabRoomStats.status === "error" &&
                  renderStatsError(collabRoomStats)}
                {collabRoomNotice && (
                  <Callout tone="warning">{collabRoomNotice}</Callout>
                )}
                <div className="AuthDialog__sectionActions">
                  <UiButton
                    size="sm"
                    variant="primary"
                    onClick={() => void handleCreateCollabRoom()}
                    loading={creatingCollabRoom}
                    disabled={
                      roomBusy ||
                      !getCloudBackend().capabilities.collabRoomBinding
                    }
                  >
                    {creatingCollabRoom
                      ? t("cloud.collabRooms.creating")
                      : t("cloud.collabRooms.create")}
                  </UiButton>
                  <UiButton
                    size="sm"
                    onClick={() => void handleCopyCollabRoom()}
                    disabled={!collabRoomLink || roomBusy}
                  >
                    {t("cloud.collabRooms.copyLink")}
                  </UiButton>
                  <UiButton
                    size="sm"
                    variant="ghost"
                    onClick={() => void handleRefreshCollabRoom()}
                    disabled={roomBusy}
                  >
                    {refreshingCollabRoom
                      ? t("cloud.collabRooms.loading")
                      : t("cloud.collabRooms.refresh")}
                  </UiButton>
                  <UiButton
                    size="sm"
                    variant="danger"
                    className="AuthDialog__actionEnd"
                    onClick={() => void handleRevokeCollabRoom()}
                    loading={revokingCollabRoom}
                    disabled={
                      collabRoomStats.status !== "ready" ||
                      !collabRoomStats.room ||
                      roomBusy
                    }
                  >
                    {revokingCollabRoom
                      ? t("cloud.collabRooms.revoking")
                      : t("cloud.collabRooms.revoke")}
                  </UiButton>
                </div>
              </DialogSection>

              <DialogSection
                className="AuthDialog__section AuthDialog__embedCard"
                title={t("cloud.embed.title")}
              >
                <div className="AuthDialog__summary">
                  <strong>{embedStatsLabel}</strong>
                  {embedStats.status === "ready" && embedStats.latestMode && (
                    <small>
                      {t("cloud.embed.latest", {
                        mode: getEmbedModeLabel(embedStats.latestMode),
                      })}
                    </small>
                  )}
                  {embedStats.status === "ready" && !embedStats.latestMode && (
                    <small>{t("cloud.embed.empty")}</small>
                  )}
                </div>
                {embedStats.status === "error" && renderStatsError(embedStats)}
                <div className="AuthDialog__sectionActions">
                  <UiButton
                    size="sm"
                    onClick={handleOpenEmbeds}
                    disabled={!onOpenEmbeds || sceneBusy}
                  >
                    {t("cloud.embed.manage")}
                  </UiButton>
                  <UiButton
                    size="sm"
                    variant="ghost"
                    onClick={() => void handleRefreshEmbedStats()}
                    disabled={sceneBusy || refreshingEmbedStats}
                  >
                    {refreshingEmbedStats
                      ? t("cloud.embed.loading")
                      : t("cloud.embed.refresh")}
                  </UiButton>
                </div>
              </DialogSection>
            </div>
          )}

          {activeTab === "deployment" && (
            <div
              className="AuthDialog__panel"
              {...getTabPanelProps(tabIdPrefix, "deployment")}
            >
              <DialogSection
                className="AuthDialog__section AuthDialog__deploymentCard"
                title={t("cloud.deployment.title")}
                description={t("cloud.deployment.selfHosted")}
              >
                <ul className="AuthDialog__statusList">
                  <li>
                    {t("cloud.deployment.supabase", {
                      status: getAvailabilityLabel(
                        deploymentConfig.hasSupabase,
                      ),
                    })}
                  </li>
                  <li>
                    {t("cloud.deployment.roomServer", {
                      status: getAvailabilityLabel(
                        deploymentConfig.hasRoomServer,
                      ),
                    })}
                  </li>
                  <li>
                    {t("cloud.deployment.collabPersistence", {
                      backend: deploymentConfig.collabPersistenceBackend,
                      status: getAvailabilityLabel(
                        getCloudBackend().capabilities.collabPersistence,
                      ),
                    })}
                  </li>
                  <li>
                    {t("cloud.deployment.e2e", {
                      status: getAvailabilityLabel(
                        deploymentConfig.e2eCloudStorageEnabled,
                      ),
                    })}
                  </li>
                </ul>
              </DialogSection>
            </div>
          )}

          {errorCallout}
        </div>

        {(onSaveCloudScene || onSaveEncryptedCloudScene) && (
          <DialogActions
            className="AuthDialog__actions"
            leading={
              isCollaborationActive && (
                <p
                  className="AuthDialog__actionsHint"
                  id="cloud-auth-save-hint"
                >
                  {t("cloud.scenes.saveSkippedCollab")}
                </p>
              )
            }
          >
            {onSaveEncryptedCloudScene && (
              <UiButton
                onClick={() => void handleSaveEncryptedCloudScene()}
                loading={savingEncryptedCloudScene}
                disabled={
                  sceneBusy ||
                  savingEncryptedCloudScene ||
                  isCollaborationActive ||
                  !getCloudBackend().capabilities.encryptedCloudStorage
                }
                aria-describedby={
                  isCollaborationActive ? "cloud-auth-save-hint" : undefined
                }
              >
                {savingEncryptedCloudScene
                  ? t("cloud.e2e.saving")
                  : t("cloud.e2e.saveEncrypted")}
              </UiButton>
            )}
            {onSaveCloudScene && (
              <UiButton
                variant="primary"
                onClick={() => void handleSaveCloudScene()}
                loading={savingCloudScene}
                disabled={
                  sceneBusy ||
                  savingEncryptedCloudScene ||
                  isCollaborationActive
                }
                aria-describedby={
                  isCollaborationActive ? "cloud-auth-save-hint" : undefined
                }
              >
                {t("cloud.scenes.saveToCloud")}
              </UiButton>
            )}
          </DialogActions>
        )}
      </div>
    </AppDialog>
  );
};
