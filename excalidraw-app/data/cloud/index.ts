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
import { readCollabPersistenceBackend } from "./capabilities";
import { createCloudEncryptionService } from "./CloudEncryptionService";
import { createFirebaseCollabPersistenceService } from "./FirebaseCollabPersistenceService";
import {
  createLocalAITaskService,
  createLocalAiGateway,
  createLocalAssetStorage,
  createLocalAuthProvider,
  createLocalCastService,
  createLocalCloudEncryptionService,
  createLocalCollabPersistenceService,
  createLocalCollabRoomService,
  createLocalEmbedService,
  createLocalRealtimeService,
  createLocalSceneActivityService,
  createLocalSceneStorage,
  createLocalShareService,
} from "./LocalAdapter";
import { createSupabaseAssetStorage } from "./supabase/SupabaseAssetStorage";
import { createSupabaseAuthProvider } from "./supabase/SupabaseAuthProvider";
import { createSupabaseAITaskService } from "./supabase/SupabaseAITaskService";
import { createSupabaseCastService } from "./supabase/SupabaseCastService";
import { createSupabaseCollabPersistenceService } from "./supabase/SupabaseCollabPersistenceService";
import { createSupabaseCollabRoomService } from "./supabase/SupabaseCollabRoomService";
import { createSupabaseEmbedService } from "./supabase/SupabaseEmbedService";
import { createSupabaseSceneActivityService } from "./supabase/SupabaseSceneActivityService";
import { createSupabaseSceneStorage } from "./supabase/SupabaseSceneStorage";
import { createSupabaseShareService } from "./supabase/SupabaseShareService";

import type { BackendCapabilities, CloudBackend } from "./types";

let _backend: CloudBackend | null = null;

const ensureBackendShape = (backend: CloudBackend): CloudBackend => {
  const legacyBackend = backend as Partial<CloudBackend>;
  if (!legacyBackend.encryption) {
    backend.encryption = backend.capabilities.encryptedCloudStorage
      ? createCloudEncryptionService(true)
      : createLocalCloudEncryptionService();
  }
  return backend;
};

const assembleLocalBackend = (): CloudBackend => ({
  capabilities: readCapabilities(),
  auth: createLocalAuthProvider(),
  scenes: createLocalSceneStorage(),
  assets: createLocalAssetStorage(),
  shares: createLocalShareService(),
  aiTasks: createLocalAITaskService(),
  activity: createLocalSceneActivityService(),
  realtime: createLocalRealtimeService(),
  collabRooms: createLocalCollabRoomService(),
  collabPersistence:
    readCollabPersistenceBackend() === "firebase"
      ? createFirebaseCollabPersistenceService()
      : createLocalCollabPersistenceService(),
  encryption: createLocalCloudEncryptionService(),
  cast: createLocalCastService(),
  embed: createLocalEmbedService(),
  ai: createLocalAiGateway(),
});

/**
 * Supabase assembly: Phase 1 backs `auth` and `scenes`; later phases add
 * assets/shares/AI tasks/activity/cast/embed metadata. Realtime/ai gateway keep
 * the Phase 0 Local implementations until their own phases.
 */
const assembleSupabaseBackend = (
  capabilities: BackendCapabilities,
): CloudBackend => ({
  capabilities,
  auth: createSupabaseAuthProvider(),
  scenes: createSupabaseSceneStorage(),
  assets: createSupabaseAssetStorage(),
  shares: createSupabaseShareService(),
  aiTasks: createSupabaseAITaskService(),
  activity: createSupabaseSceneActivityService(),
  realtime: createLocalRealtimeService(),
  collabRooms: capabilities.collabRoomBinding
    ? createSupabaseCollabRoomService()
    : createLocalCollabRoomService(),
  collabPersistence: capabilities.collabPersistence
    ? readCollabPersistenceBackend() === "firebase"
      ? createFirebaseCollabPersistenceService()
      : createSupabaseCollabPersistenceService()
    : createLocalCollabPersistenceService(),
  encryption: createCloudEncryptionService(capabilities.encryptedCloudStorage),
  cast: createSupabaseCastService(),
  embed: createSupabaseEmbedService(),
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
  return ensureBackendShape(_backend);
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
export { readCloudDeploymentConfig } from "./deploymentConfig";

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
