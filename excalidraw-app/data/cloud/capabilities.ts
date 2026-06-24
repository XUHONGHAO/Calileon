/**
 * Capability detection (decision 0006 §2).
 *
 * Capabilities are derived from environment variables. A missing value
 * defaults to `false` — meaning that capability degrades, it never makes the
 * app fail (NFR-AVAIL). In Phase 0 nothing gates behavior on these flags yet;
 * they exist so Phase 1+ UI can hide/show entry points and so `getCloudBackend`
 * can report what the current deployment can do.
 */

import { hasSupabaseConfig } from "./supabase/client";

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
  // Supabase configured → account + cloud scenes become available and the
  // deployment is at least "self-hosted" tier (decision 0008 §1.3). Without it
  // we stay "local" tier with auth/sceneStorage off — pure-local, zero behavior
  // change.
  const hasSupabase = hasSupabaseConfig();
  const tier: DeploymentTier = hasSupabase ? "self-hosted" : "local";

  // Supabase cloud shares (Phase 2B) or legacy share link backend
  // (json.excalidraw.com style).
  const share =
    hasSupabase || hasEnv(import.meta.env.VITE_APP_BACKEND_V2_POST_URL);
  // Existing collaboration: realtime socket server + firebase persistence.
  const hasFirebase = hasFirebaseConfig();
  const realtime =
    hasEnv(import.meta.env.VITE_APP_WS_SERVER_URL) && hasFirebase;
  // Phase 2A: Supabase stores cloud whiteboard assets. Firebase file storage
  // remains a legacy collaboration/share-link capability.
  const assetStorage = hasSupabase || hasFirebase;

  return {
    tier,
    auth: hasSupabase, // Phase 1: Supabase email/password
    sceneStorage: hasSupabase, // Phase 1: Supabase cloud scene CRUD
    assetStorage,
    share,
    aiTasks: hasSupabase, // Phase 2C: Supabase AI task metadata/index
    collaborationMetadata: hasSupabase, // Phase 3A: activity_log metadata
    realtime,
    cast: false, // Phase 3
    embed: false, // Phase 3
    aiGateway: false, // Phase 2 (browser-direct AI is the default, not a gateway)
  };
};
