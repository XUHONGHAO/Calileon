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
  AssetStorage,
  AuthProvider,
  CastService,
  EmbedService,
  RealtimeService,
  SceneStorage,
  ShareService,
} from "./types";

export const createLocalAuthProvider = (): AuthProvider => ({
  getCurrentUser: async () => null,
  signIn: async () => notConfigured("账号登录"),
  signOut: async () => {},
  onAuthStateChange: (cb) => {
    // No backend auth in local mode: report signed-out once, no-op unsubscribe.
    cb(null);
    return () => {};
  },
});

export const createLocalSceneStorage = (): SceneStorage => ({
  save: async () => notConfigured("云端白板保存"),
  load: async () => notConfigured("云端白板加载"),
  list: async () => notConfigured("云端白板列表"),
  rename: async () => notConfigured("云端白板重命名"),
  remove: async () => notConfigured("云端白板删除"),
});

export const createLocalAssetStorage = (): AssetStorage => ({
  upload: async () => notConfigured("云端资产上传"),
  getUrl: async () => notConfigured("云端资产地址"),
  remove: async () => notConfigured("云端资产删除"),
  listByScene: async () => notConfigured("云端资产列表"),
});

export const createLocalShareService = (): ShareService => ({
  create: async () => notConfigured("分享链接创建"),
  resolve: async () => notConfigured("分享链接解析"),
  revoke: async () => notConfigured("分享链接撤销"),
  listByScene: async () => notConfigured("分享链接列表"),
});

export const createLocalRealtimeService = (): RealtimeService => ({
  isAvailable: () => false,
});

export const createLocalCastService = (): CastService => ({
  isAvailable: () => false,
});

export const createLocalEmbedService = (): EmbedService => ({
  isAvailable: () => false,
});

export const createLocalAiGateway = (): AiGateway => ({
  isEnabled: () => false,
});
