/**
 * Capability detection (decision 0006 §2).
 *
 * Capabilities are derived from environment variables. A missing value
 * defaults to `false` — meaning that capability degrades, it never makes the
 * app fail (NFR-AVAIL). In Phase 0 nothing gates behavior on these flags yet;
 * they exist so Phase 1+ UI can hide/show entry points and so `getCloudBackend`
 * can report what the current deployment can do.
 */

import type { BackendCapabilities, DeploymentTier } from "./types";

const hasEnv = (value: string | undefined): boolean =>
  typeof value === "string" && value.trim().length > 0;

const hasFirebaseConfig = (): boolean => {
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

export const readCapabilities = (): BackendCapabilities => {
  // Phase 0: no Supabase yet, so we are always "local" tier. Phase 1 flips
  // this to "self-hosted" / "cloud" once a Supabase URL is configured.
  const tier: DeploymentTier = "local";

  // Legacy share link backend (json.excalidraw.com style).
  const share = hasEnv(import.meta.env.VITE_APP_BACKEND_V2_POST_URL);
  // Existing collaboration: realtime socket server + firebase persistence.
  const realtime =
    hasEnv(import.meta.env.VITE_APP_WS_SERVER_URL) && hasFirebaseConfig();
  // Collaboration also stores files/scenes in firebase storage/firestore.
  const assetStorage = hasFirebaseConfig();

  return {
    tier,
    auth: false, // Phase 1
    sceneStorage: false, // Phase 1 (cloud scene CRUD)
    assetStorage,
    share,
    realtime,
    cast: false, // Phase 3
    embed: false, // Phase 3
    aiGateway: false, // Phase 2 (browser-direct AI is the default, not a gateway)
  };
};
