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
import { getCloudBackend } from "../data/cloud";

import "./AuthDialog.scss";

export interface AuthDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful sign-in (e.g. to open the scene list). */
  onSignedIn?: () => void;
  /** Opens the user's cloud whiteboard list from the account panel. */
  onOpenCloudScenes?: () => void;
  /** Saves the current whiteboard to the signed-in cloud account. */
  onSaveCloudScene?: () => void | Promise<void>;
}

export const AuthDialog: React.FC<AuthDialogProps> = ({
  open,
  onClose,
  onSignedIn,
  onOpenCloudScenes,
  onSaveCloudScene,
}) => {
  const { isSignedIn, user, signIn, signOut } = useCloudAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [savingCloudScene, setSavingCloudScene] = useState(false);
  const [sceneStats, setSceneStats] = useState<
    | { status: "idle" | "loading" | "unavailable" }
    | {
        status: "ready";
        count: number;
        latestTitle: string | null;
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

  useEffect(() => {
    if (!open || !isSignedIn) {
      setSceneStats({ status: "idle" });
      return;
    }

    let cancelled = false;
    void loadSceneStats(() => cancelled);

    return () => {
      cancelled = true;
    };
  }, [isSignedIn, loadSceneStats, open]);

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
  };

  const handleClose = () => {
    if (submitting || signingOut || savingCloudScene) {
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
    if (submitting || signingOut || !onOpenCloudScenes) {
      return;
    }
    reset();
    onClose();
    onOpenCloudScenes();
  };

  const handleSaveCloudScene = async () => {
    if (submitting || signingOut || savingCloudScene || !onSaveCloudScene) {
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

  const closeButton = (
    <button
      className="AuthDialog__close"
      type="button"
      aria-label={t("buttons.close")}
      title={t("buttons.close")}
      onClick={handleClose}
      disabled={submitting || signingOut || savingCloudScene}
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
                disabled={signingOut || savingCloudScene}
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
              disabled={!onOpenCloudScenes || signingOut || savingCloudScene}
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
                disabled={signingOut || savingCloudScene}
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
