/**
 * CloudAuthButton: standalone, layout-agnostic cloud auth entry (Phase 1).
 *
 * Renders nothing when cloud auth isn't configured. Signed-out users get a
 * sign-in trigger; signed-in users get an account trigger. Sign-out lives
 * inside AuthDialog so menus do not expose account actions directly.
 */

import { Button } from "@excalidraw/excalidraw/components/Button";
import { loginIcon } from "@excalidraw/excalidraw/components/icons";
import { t } from "@excalidraw/excalidraw/i18n";
import React, { useState } from "react";

import { useCloudAuth } from "../auth/useCloudAuth";

import {
  AuthDialog,
  type ActiveCloudSceneInfo,
  type CloudSceneRemoteUpdateState,
} from "./AuthDialog";

import "./CloudAuthButton.scss";

export interface CloudAuthButtonProps {
  /** Called after a successful sign-in (e.g. open the scene list). */
  onSignedIn?: () => void;
  /** Opens the user's cloud whiteboard list from the account panel. */
  onOpenCloudScenes?: () => void;
  /** Opens the user's cloud AI task list from the account panel. */
  onOpenAITasks?: () => void;
  /** Saves the current whiteboard to the signed-in cloud account. */
  onSaveCloudScene?: () => void | Promise<void>;
  activeCloudScene?: ActiveCloudSceneInfo | null;
  cloudSceneRemoteUpdate?: CloudSceneRemoteUpdateState;
  onCheckCurrentCloudScene?: () => void | Promise<void>;
  onRefreshCurrentCloudScene?: () => void | Promise<void>;
  className?: string;
}

export const CloudAuthButton: React.FC<CloudAuthButtonProps> = ({
  onSignedIn,
  onOpenCloudScenes,
  onOpenAITasks,
  onSaveCloudScene,
  activeCloudScene,
  cloudSceneRemoteUpdate,
  onCheckCurrentCloudScene,
  onRefreshCurrentCloudScene,
  className,
}) => {
  const { isAuthAvailable, status, isSignedIn } = useCloudAuth();
  const [dialogOpen, setDialogOpen] = useState(false);

  // Pure-local mode: no cloud backend, no cloud auth entry point.
  if (!isAuthAvailable) {
    return null;
  }

  // Avoid flicker while the persisted session is still hydrating.
  if (status === "loading") {
    return null;
  }

  if (isSignedIn) {
    return (
      <div className={`CloudAuthButton ${className ?? ""}`}>
        <Button onSelect={() => setDialogOpen(true)}>
          {loginIcon}
          <span>{t("cloud.auth.accountMenu")}</span>
        </Button>
        <AuthDialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          onSignedIn={onSignedIn}
          onOpenCloudScenes={onOpenCloudScenes}
          onOpenAITasks={onOpenAITasks}
          onSaveCloudScene={onSaveCloudScene}
          activeCloudScene={activeCloudScene}
          cloudSceneRemoteUpdate={cloudSceneRemoteUpdate}
          onCheckCurrentCloudScene={onCheckCurrentCloudScene}
          onRefreshCurrentCloudScene={onRefreshCurrentCloudScene}
        />
      </div>
    );
  }

  return (
    <div className={`CloudAuthButton ${className ?? ""}`}>
      <Button onSelect={() => setDialogOpen(true)}>
        {loginIcon}
        <span>{t("cloud.auth.signIn")}</span>
      </Button>
      <AuthDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSignedIn={onSignedIn}
        onOpenCloudScenes={onOpenCloudScenes}
        onOpenAITasks={onOpenAITasks}
        onSaveCloudScene={onSaveCloudScene}
        activeCloudScene={activeCloudScene}
        cloudSceneRemoteUpdate={cloudSceneRemoteUpdate}
        onCheckCurrentCloudScene={onCheckCurrentCloudScene}
        onRefreshCurrentCloudScene={onRefreshCurrentCloudScene}
      />
    </div>
  );
};
