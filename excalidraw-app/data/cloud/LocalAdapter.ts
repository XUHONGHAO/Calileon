/**
 * LocalAdapter — Phase 0 default implementation of the frozen `CloudBackend`
 * contract.
 *
 * Phase 0 intentionally has NO cloud backend, so every cloud-only method here
 * reports `not-configured` (decision 0006 §7.3: pure-local returns all
 * LocalAdapter implementations with capabilities mostly `false`).
 *
 * The app's *actual* local persistence, legacy share link, and firebase
 * collaboration behavior is NOT here — it lives unchanged in
 * `./passthrough/*` and is consumed directly by callers. This adapter only
 * exists so the frozen interface is concretely instantiable and so Phase 1
 * (SupabaseAdapter) has a shape to slot into.
 */

import { notConfigured } from "./errors";

import type {
  AiGateway,
  AITaskService,
  AssetStorage,
  AuthProvider,
  CastService,
  CloudEncryptionService,
  CollabPersistenceService,
  CollabRoomService,
  EmbedService,
  RealtimeService,
  SceneActivityService,
  SceneStorage,
  ShareService,
  VideoAssetService,
} from "./types";

export const createLocalAuthProvider = (): AuthProvider => ({
  getCurrentUser: async () => null,
  signIn: async () => notConfigured(),
  signOut: async () => {},
  onAuthStateChange: (cb) => {
    // No backend auth in local mode: report signed-out once, no-op unsubscribe.
    cb(null);
    return () => {};
  },
});

export const createLocalSceneStorage = (): SceneStorage => ({
  save: async () => notConfigured(),
  load: async () => notConfigured(),
  getMetadata: async () => notConfigured(),
  list: async () => notConfigured(),
  rename: async () => notConfigured(),
  remove: async () => notConfigured(),
});

export const createLocalAssetStorage = (): AssetStorage => ({
  upload: async () => notConfigured(),
  getUrl: async () => notConfigured(),
  remove: async () => notConfigured(),
  listByScene: async () => notConfigured(),
});

export const createLocalVideoAssetService = (): VideoAssetService => ({
  isAvailable: () => false,
  ingest: async () => notConfigured(),
  resolve: async () => notConfigured(),
});

export const createLocalShareService = (): ShareService => ({
  create: async () => notConfigured(),
  resolve: async () => notConfigured(),
  revoke: async () => notConfigured(),
  listByScene: async () => notConfigured(),
  loadScene: async () => notConfigured(),
  saveScene: async () => notConfigured(),
  uploadAsset: async () => notConfigured(),
});

export const createLocalAITaskService = (): AITaskService => ({
  create: async () => notConfigured(),
  list: async () => notConfigured(),
  remove: async () => notConfigured(),
});

export const createLocalSceneActivityService = (): SceneActivityService => ({
  create: async () => notConfigured(),
  listByScene: async () => notConfigured(),
});

export const createLocalRealtimeService = (): RealtimeService => ({
  isAvailable: () => false,
});

export const createLocalCollabRoomService = (): CollabRoomService => ({
  isAvailable: () => false,
  createForScene: async () => notConfigured(),
  getByScene: async () => notConfigured(),
  getByRoomId: async () => notConfigured(),
  revoke: async () => notConfigured(),
  touch: async () => notConfigured(),
});

export const createLocalCollabPersistenceService =
  (): CollabPersistenceService => ({
    isAvailable: () => false,
    backend: "none",
    isRoomActive: async () => true,
    isSaved: () => true,
    saveScene: async () => notConfigured(),
    loadScene: async () => notConfigured(),
    saveFiles: async () => notConfigured(),
    loadFiles: async () => notConfigured(),
    saveSnapshot: async () => notConfigured(),
    loadSnapshot: async () => notConfigured(),
  });

export const createLocalCloudEncryptionService =
  (): CloudEncryptionService => ({
    isAvailable: () => false,
    generateKey: async () => notConfigured(),
    encryptScenePayload: async () => notConfigured(),
    decryptScenePayload: async () => notConfigured(),
    encryptBlob: async () => notConfigured(),
    decryptBlob: async () => notConfigured(),
    saveKey: () => notConfigured(),
    getKey: () => null,
    removeKey: () => notConfigured(),
  });

export const createLocalCastService = (): CastService => ({
  isAvailable: () => false,
  createSession: async () => notConfigured(),
  listByScene: async () => notConfigured(),
  attachScript: async () => notConfigured(),
  registerExport: async () => notConfigured(),
  listExportsByScene: async () => notConfigured(),
  remove: async () => notConfigured(),
});

export const createLocalEmbedService = (): EmbedService => ({
  isAvailable: () => false,
  create: async () => notConfigured(),
  listByScene: async () => notConfigured(),
  update: async () => notConfigured(),
  revoke: async () => notConfigured(),
  resolve: async () => notConfigured(),
  loadScene: async () => notConfigured(),
  saveScene: async () => notConfigured(),
  uploadAsset: async () => notConfigured(),
});

export const createLocalAiGateway = (): AiGateway => ({
  isEnabled: () => false,
});
