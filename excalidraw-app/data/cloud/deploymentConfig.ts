import { readCapabilities, readCollabPersistenceBackend } from "./capabilities";
import { hasSupabaseConfig } from "./supabase/client";

import type { CollabPersistenceBackend } from "./types";

const hasEnv = (value: string | undefined): boolean =>
  typeof value === "string" && value.trim().length > 0;

export interface CloudDeploymentConfig {
  hasSupabase: boolean;
  hasRoomServer: boolean;
  hasFirebase: boolean;
  collabPersistenceBackend: CollabPersistenceBackend;
  e2eCloudStorageEnabled: boolean;
}

export const hasFirebaseConfig = (): boolean => {
  const raw = import.meta.env.VITE_APP_FIREBASE_CONFIG;
  if (!hasEnv(raw)) {
    return false;
  }
  try {
    const parsed = JSON.parse(raw);
    return (
      parsed && typeof parsed === "object" && Object.keys(parsed).length > 0
    );
  } catch {
    return false;
  }
};

export const readCloudDeploymentConfig = (): CloudDeploymentConfig => {
  const capabilities = readCapabilities();
  return {
    hasSupabase: hasSupabaseConfig(),
    hasRoomServer: hasEnv(import.meta.env.VITE_APP_WS_SERVER_URL),
    hasFirebase: hasFirebaseConfig(),
    collabPersistenceBackend: readCollabPersistenceBackend(),
    e2eCloudStorageEnabled: capabilities.encryptedCloudStorage,
  };
};
