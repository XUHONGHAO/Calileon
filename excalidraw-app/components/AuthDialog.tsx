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

import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { Button } from "@excalidraw/excalidraw/components/Button";
import { CloseIcon } from "@excalidraw/excalidraw/components/icons";
import { t } from "@excalidraw/excalidraw/i18n";
import React, { useCallback, useEffect, useState } from "react";

import { useCloudAuth } from "../auth/useCloudAuth";
import {
  getCloudBackend,
  type AITaskStatus,
  type CastSessionStatus,
  type EmbedMode,
  type SceneSummary,
} from "../data/cloud";

import "./AuthDialog.scss";

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
  /** Current account-owned cloud whiteboard, if the local canvas is bound. */
  activeCloudScene?: ActiveCloudSceneInfo | null;
  /** Latest lightweight remote-version check result for the current whiteboard. */
  cloudSceneRemoteUpdate?: CloudSceneRemoteUpdateState;
  /** Checks whether the current cloud whiteboard has a newer remote version. */
  onCheckCurrentCloudScene?: () => void | Promise<void>;
  /** Reloads the current cloud whiteboard from the backend. */
  onRefreshCurrentCloudScene?: () => void | Promise<void>;
}

export const AuthDialog: React.FC<AuthDialogProps> = ({
  open,
  onClose,
  onSignedIn,
  onOpenCloudScenes,
  onOpenAITasks,
  onOpenEmbeds,
  onSaveCloudScene,
  activeCloudScene,
  cloudSceneRemoteUpdate = { status: "idle" },
  onCheckCurrentCloudScene,
  onRefreshCurrentCloudScene,
}) => {
  const { isSignedIn, user, signIn, signOut } = useCloudAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [savingCloudScene, setSavingCloudScene] = useState(false);
  const [checkingCurrentScene, setCheckingCurrentScene] = useState(false);
  const [refreshingCurrentScene, setRefreshingCurrentScene] = useState(false);
  const [refreshingCastStats, setRefreshingCastStats] = useState(false);
  const [refreshingEmbedStats, setRefreshingEmbedStats] = useState(false);
  const [sceneStats, setSceneStats] = useState<
    | { status: "idle" | "loading" | "unavailable" }
    | {
        status: "ready";
        count: number;
        latestTitle: string | null;
      }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const [taskStats, setTaskStats] = useState<
    | { status: "idle" | "loading" | "unavailable" }
    | {
        status: "ready";
        count: number;
        latestStatus: AITaskStatus | null;
      }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const [castStats, setCastStats] = useState<
    | { status: "idle" | "loading" | "unavailable" }
    | {
        status: "ready";
        sessionCount: number;
        exportCount: number;
        latestStatus: CastSessionStatus | null;
      }
    | { status: "error"; message: string }
  >({ status: "idle" });
  const [embedStats, setEmbedStats] = useState<
    | { status: "idle" | "loading" | "unavailable" }
    | {
        status: "ready";
        count: number;
        latestMode: EmbedMode | null;
      }
    | { status: "error"; message: string }
  >({ status: "idle" });

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
          message:
            err instanceof Error ? err.message : t("cloud.scenes.genericError"),
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
          message:
            err instanceof Error
              ? err.message
              : t("cloud.aiTasks.genericError"),
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
          message:
            err instanceof Error
              ? err.message
              : t("cloud.castArtifacts.genericError"),
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
          message:
            err instanceof Error ? err.message : t("cloud.embed.genericError"),
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
      return;
    }

    let cancelled = false;
    void loadSceneStats(() => cancelled);
    void loadTaskStats(() => cancelled);
    void loadCastStats(() => cancelled);
    void loadEmbedStats(() => cancelled);

    return () => {
      cancelled = true;
    };
  }, [
    isSignedIn,
    loadCastStats,
    loadEmbedStats,
    loadSceneStats,
    loadTaskStats,
    open,
  ]);

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
  };

  const handleClose = () => {
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
    reset();
    onClose();
  };

  const stopShortcutPropagation = (event: React.KeyboardEvent) => {
    event.stopPropagation();
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
      setError(
        err instanceof Error ? err.message : t("cloud.auth.genericError"),
      );
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
      setError(
        err instanceof Error ? err.message : t("cloud.auth.genericError"),
      );
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
    try {
      await onSaveCloudScene();
      await loadSceneStats();
    } finally {
      setSavingCloudScene(false);
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

  const accountLabel =
    user?.email || user?.displayName || t("cloud.auth.account");

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

  const closeButton = (
    <button
      className="AuthDialog__close"
      type="button"
      aria-label={t("buttons.close")}
      title={t("buttons.close")}
      onClick={handleClose}
      disabled={
        submitting ||
        signingOut ||
        savingCloudScene ||
        checkingCurrentScene ||
        refreshingCurrentScene
      }
    >
      {CloseIcon}
    </button>
  );

  return (
    <Dialog
      className="AuthDialogModal"
      size="small"
      closeOnClickOutside={false}
      onCloseRequest={handleClose}
      title={
        isSignedIn ? t("cloud.auth.accountTitle") : t("cloud.auth.signInTitle")
      }
    >
      {isSignedIn ? (
        <div className="AuthDialog AuthDialog--account">
          {closeButton}
          <p className="AuthDialog__intro">{t("cloud.auth.accountIntro")}</p>

          <div className="AuthDialog__accountGrid">
            <div className="AuthDialog__accountCard">
              <span>{t("cloud.auth.signedInAs")}</span>
              <strong title={accountLabel}>{accountLabel}</strong>
              <button
                className="AuthDialog__cardAction"
                type="button"
                onClick={handleSignOut}
                disabled={
                  signingOut ||
                  savingCloudScene ||
                  checkingCurrentScene ||
                  refreshingCurrentScene
                }
              >
                {signingOut
                  ? t("cloud.auth.signingOut")
                  : t("cloud.auth.signOutShort")}
              </button>
            </div>

            <button
              className="AuthDialog__accountCard AuthDialog__accountCard--button"
              type="button"
              onClick={handleOpenCloudScenes}
              disabled={
                !onOpenCloudScenes ||
                signingOut ||
                savingCloudScene ||
                checkingCurrentScene ||
                refreshingCurrentScene
              }
            >
              <span>{t("cloud.auth.cloudWhiteboards")}</span>
              <strong>{cloudSceneCountLabel}</strong>
              {sceneStats.status === "ready" && sceneStats.latestTitle && (
                <small title={sceneStats.latestTitle}>
                  {t("cloud.auth.latestCloudWhiteboard", {
                    title: sceneStats.latestTitle,
                  })}
                </small>
              )}
              {sceneStats.status === "error" && (
                <small>{sceneStats.message}</small>
              )}
            </button>

            <button
              className="AuthDialog__accountCard AuthDialog__accountCard--button"
              type="button"
              onClick={handleOpenAITasks}
              disabled={
                !onOpenAITasks ||
                signingOut ||
                savingCloudScene ||
                checkingCurrentScene ||
                refreshingCurrentScene
              }
            >
              <span>{t("cloud.auth.cloudAITasks")}</span>
              <strong>{cloudTaskCountLabel}</strong>
              {taskStats.status === "ready" && taskStats.latestStatus && (
                <small>
                  {t("cloud.auth.latestCloudAITask", {
                    status: getAITaskStatusLabel(taskStats.latestStatus),
                  })}
                </small>
              )}
              {taskStats.status === "error" && (
                <small>{taskStats.message}</small>
              )}
            </button>

            {activeCloudScene && (
              <div
                className={`AuthDialog__accountCard AuthDialog__currentSceneCard ${
                  cloudSceneRemoteUpdate.status === "remote-newer"
                    ? "AuthDialog__currentSceneCard--stale"
                    : ""
                }`}
              >
                <span>{t("cloud.auth.currentCloudWhiteboard")}</span>
                <strong title={activeCloudScene.title}>
                  {activeCloudScene.title}
                </strong>
                <small>
                  {t("cloud.auth.currentCloudWhiteboardVersion", {
                    version: activeCloudScene.version,
                  })}
                </small>
                <small>{currentSceneStatusLabel}</small>
                <div className="AuthDialog__cardActions">
                  <button
                    className="AuthDialog__cardAction"
                    type="button"
                    onClick={() => void handleCheckCurrentCloudScene()}
                    disabled={!canCheckCurrentScene}
                  >
                    {checkingCurrentScene
                      ? t("cloud.auth.currentCloudWhiteboardChecking")
                      : t("cloud.auth.checkCurrentCloudWhiteboard")}
                  </button>
                  {cloudSceneRemoteUpdate.status === "remote-newer" && (
                    <button
                      className="AuthDialog__cardAction"
                      type="button"
                      onClick={() => void handleRefreshCurrentCloudScene()}
                      disabled={!canRefreshCurrentScene}
                    >
                      {refreshingCurrentScene
                        ? t("cloud.auth.refreshingCurrentCloudWhiteboard")
                        : t("cloud.auth.refreshCurrentCloudWhiteboard")}
                    </button>
                  )}
                </div>
              </div>
            )}

            {activeCloudScene && (
              <div className="AuthDialog__accountCard AuthDialog__castCard">
                <span>{t("cloud.castArtifacts.title")}</span>
                <strong>{castStatsLabel}</strong>
                {castStats.status === "ready" && castStats.latestStatus && (
                  <small>
                    {t("cloud.castArtifacts.latest", {
                      status: getCastSessionStatusLabel(castStats.latestStatus),
                    })}
                  </small>
                )}
                {castStats.status === "ready" && !castStats.latestStatus && (
                  <small>{t("cloud.castArtifacts.empty")}</small>
                )}
                {castStats.status === "error" && (
                  <small>{castStats.message}</small>
                )}
                <div className="AuthDialog__cardActions">
                  <button
                    className="AuthDialog__cardAction"
                    type="button"
                    onClick={() => void handleRefreshCastStats()}
                    disabled={
                      signingOut ||
                      savingCloudScene ||
                      checkingCurrentScene ||
                      refreshingCurrentScene ||
                      refreshingCastStats ||
                      refreshingEmbedStats
                    }
                  >
                    {refreshingCastStats
                      ? t("cloud.castArtifacts.loading")
                      : t("cloud.castArtifacts.refresh")}
                  </button>
                </div>
              </div>
            )}

            {activeCloudScene && (
              <div className="AuthDialog__accountCard AuthDialog__embedCard">
                <span>{t("cloud.embed.title")}</span>
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
                {embedStats.status === "error" && (
                  <small>{embedStats.message}</small>
                )}
                <div className="AuthDialog__cardActions">
                  <button
                    className="AuthDialog__cardAction"
                    type="button"
                    onClick={handleOpenEmbeds}
                    disabled={
                      !onOpenEmbeds ||
                      signingOut ||
                      savingCloudScene ||
                      checkingCurrentScene ||
                      refreshingCurrentScene
                    }
                  >
                    {t("cloud.embed.manage")}
                  </button>
                  <button
                    className="AuthDialog__cardAction"
                    type="button"
                    onClick={() => void handleRefreshEmbedStats()}
                    disabled={
                      signingOut ||
                      savingCloudScene ||
                      checkingCurrentScene ||
                      refreshingCurrentScene ||
                      refreshingEmbedStats
                    }
                  >
                    {refreshingEmbedStats
                      ? t("cloud.embed.loading")
                      : t("cloud.embed.refresh")}
                  </button>
                </div>
              </div>
            )}
          </div>

          {error && (
            <p className="AuthDialog__error" role="alert">
              {error}
            </p>
          )}

          <div className="AuthDialog__actions">
            {onSaveCloudScene && (
              <Button
                onSelect={() => void handleSaveCloudScene()}
                disabled={
                  signingOut ||
                  savingCloudScene ||
                  checkingCurrentScene ||
                  refreshingCurrentScene
                }
              >
                {t("cloud.scenes.saveToCloud")}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <form
          className="AuthDialog"
          onSubmit={handleSubmit}
          onKeyDown={stopShortcutPropagation}
        >
          {closeButton}
          <p className="AuthDialog__intro">{t("cloud.auth.signInIntro")}</p>

          <div className="AuthDialog__field">
            <label htmlFor="cloud-auth-email">{t("cloud.auth.email")}</label>
            <input
              id="cloud-auth-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              disabled={submitting}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={stopShortcutPropagation}
            />
          </div>

          <div className="AuthDialog__field">
            <label htmlFor="cloud-auth-password">
              {t("cloud.auth.password")}
            </label>
            <input
              id="cloud-auth-password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              disabled={submitting}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={stopShortcutPropagation}
            />
          </div>

          {error && (
            <p className="AuthDialog__error" role="alert">
              {error}
            </p>
          )}

          <div className="AuthDialog__actions">
            <Button onSelect={handleClose} disabled={submitting}>
              {t("cloud.auth.cancel")}
            </Button>
            <Button
              type="submit"
              // Submission is handled by the form's onSubmit (so Enter works too);
              // onSelect is a required prop on Button, kept as a noop here.
              onSelect={() => {}}
              disabled={submitting || !email.trim() || !password}
            >
              {submitting
                ? t("cloud.auth.signingIn")
                : t("cloud.auth.signInAction")}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
};
