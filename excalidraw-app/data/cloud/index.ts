/**
 * Cloud backend assembly entry (decision 0006 §5).
 *
 * Upper layers import the frozen contract only from here — never an adapter or
 * a platform SDK directly. Phase 0 always assembles `LocalAdapter`; Phase 1
 * will select Supabase implementations based on `capabilities`.
 *
 * NOTE: today's actual local/share/collab operations are exposed separately
 * via `./passthrough/*` (re-exported below for a single import surface). They
 * keep their current signatures and behavior verbatim (zero behavior change).
 */

import { readCapabilities } from "./capabilities";
import {
  createLocalAiGateway,
  createLocalAssetStorage,
  createLocalAuthProvider,
  createLocalCastService,
  createLocalEmbedService,
  createLocalRealtimeService,
  createLocalSceneStorage,
  createLocalShareService,
} from "./LocalAdapter";
import { createSupabaseAuthProvider } from "./supabase/SupabaseAuthProvider";
import { createSupabaseSceneStorage } from "./supabase/SupabaseSceneStorage";

import type { BackendCapabilities, CloudBackend } from "./types";

let _backend: CloudBackend | null = null;

const assembleLocalBackend = (): CloudBackend => ({
  capabilities: readCapabilities(),
  auth: createLocalAuthProvider(),
  scenes: createLocalSceneStorage(),
  assets: createLocalAssetStorage(),
  shares: createLocalShareService(),
  realtime: createLocalRealtimeService(),
  cast: createLocalCastService(),
  embed: createLocalEmbedService(),
  ai: createLocalAiGateway(),
});

/**
 * Phase 1 Supabase assembly: only the `auth` and `scenes` slots are backed by
 * Supabase (decision 0008 §4.3). Assets/shares/realtime/cast/embed/ai keep the
 * Phase 0 Local implementations (they report `not-configured` / `false` until
 * their own phases). The frozen contract shape is identical — only the two
 * slots differ.
 */
const assembleSupabaseBackend = (
  capabilities: BackendCapabilities,
): CloudBackend => ({
  capabilities,
  auth: createSupabaseAuthProvider(),
  scenes: createSupabaseSceneStorage(),
  assets: createLocalAssetStorage(),
  shares: createLocalShareService(),
  realtime: createLocalRealtimeService(),
  cast: createLocalCastService(),
  embed: createLocalEmbedService(),
  ai: createLocalAiGateway(),
});

/**
 * Returns the active cloud backend singleton. Selects the Supabase assembly
 * when the deployment has cloud scenes configured (decision 0008 §1.3:
 * `hasSupabase` → Supabase adapter; otherwise stay pure-local, never fall back
 * mid-flight). Local-first: no Supabase config means zero behavior change.
 */
export const getCloudBackend = (): CloudBackend => {
  if (!_backend) {
    const capabilities = readCapabilities();
    _backend = capabilities.sceneStorage
      ? assembleSupabaseBackend(capabilities)
      : assembleLocalBackend();
  }
  return _backend;
};

/** Test-only: reset the assembled singleton between tests. */
export const __resetCloudBackendForTests = (): void => {
  _backend = null;
};

// —— Frozen contract re-exports ——
export * from "./types";
export { BackendError } from "./errors";
export type { BackendErrorCode } from "./errors";
export { readCapabilities } from "./capabilities";

// —— Phase 0 passthrough surface (today's behavior, verbatim) ——
export * as localStore from "./passthrough/localStore";
export * as shareLink from "./passthrough/shareLink";
export * as firebaseStore from "./passthrough/firebaseStore";

// Realtime wire-protocol types (live in data/index.ts; surfaced here so collab
// has a single import surface). Not part of the frozen contract.
export type {
  SyncableExcalidrawElement,
  SocketUpdateData,
  SocketUpdateDataIncoming,
  SocketUpdateDataSource,
  EncryptedData,
} from "..";
