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

import type { CollabRoomRecord } from "../data/cloud";

export interface CloudAuthButtonProps {
  /** Called after a successful sign-in (e.g. open the scene list). */
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
  /** Starts local realtime collaboration after creating a cloud room binding. */
  onStartCollabRoom?: (room: {
    roomId: string;
    roomKey: string;
  }) => void | Promise<void>;
  collabRoomRefreshKey?: number;
  onCollabRoomChanged?: () => void;
  onCollabRoomRevoked?: (room: CollabRoomRecord) => void | Promise<void>;
  activeCloudScene?: ActiveCloudSceneInfo | null;
  isCollaborationActive?: boolean;
  cloudSceneRemoteUpdate?: CloudSceneRemoteUpdateState;
  onCheckCurrentCloudScene?: () => void | Promise<void>;
  onRefreshCurrentCloudScene?: () => void | Promise<void>;
  className?: string;
}

export const CloudAuthButton: React.FC<CloudAuthButtonProps> = ({
  onSignedIn,
  onOpenCloudScenes,
  onOpenAITasks,
  onOpenEmbeds,
  onSaveCloudScene,
  onSaveEncryptedCloudScene,
  onStartCollabRoom,
  collabRoomRefreshKey,
  onCollabRoomChanged,
  onCollabRoomRevoked,
  activeCloudScene,
  isCollaborationActive,
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
          onOpenEmbeds={onOpenEmbeds}
          onSaveCloudScene={onSaveCloudScene}
          onSaveEncryptedCloudScene={onSaveEncryptedCloudScene}
          onStartCollabRoom={onStartCollabRoom}
          collabRoomRefreshKey={collabRoomRefreshKey}
          onCollabRoomChanged={onCollabRoomChanged}
          onCollabRoomRevoked={onCollabRoomRevoked}
          activeCloudScene={activeCloudScene}
          isCollaborationActive={isCollaborationActive}
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
        onOpenEmbeds={onOpenEmbeds}
        onSaveCloudScene={onSaveCloudScene}
        onSaveEncryptedCloudScene={onSaveEncryptedCloudScene}
        onStartCollabRoom={onStartCollabRoom}
        collabRoomRefreshKey={collabRoomRefreshKey}
        onCollabRoomChanged={onCollabRoomChanged}
        onCollabRoomRevoked={onCollabRoomRevoked}
        activeCloudScene={activeCloudScene}
        isCollaborationActive={isCollaborationActive}
        cloudSceneRemoteUpdate={cloudSceneRemoteUpdate}
        onCheckCurrentCloudScene={onCheckCurrentCloudScene}
        onRefreshCurrentCloudScene={onRefreshCurrentCloudScene}
      />
    </div>
  );
};
