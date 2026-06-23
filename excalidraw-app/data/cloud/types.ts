/**
 * Phase 0 frozen adapter contract.
 *
 * These types are the frozen backend interface from decision 0006
 * (`03-decisions/0006-phase0-interface-freeze.md`). Once frozen, Phase 1–4
 * may only add optional fields or new methods — never change/remove an
 * existing signature.
 *
 * In Phase 0 these interfaces are dormant: the local deployment returns a
 * `LocalAdapter` whose cloud-only methods report `not-configured`. Today's
 * actual local/share/collab behavior lives in `./passthrough/*`, not here.
 */

// —— Deployment tier & capability flags (BR-CFG) ——
export type DeploymentTier = "local" | "self-hosted" | "cloud";

export interface BackendCapabilities {
  tier: DeploymentTier;
  auth: boolean;
  sceneStorage: boolean;
  assetStorage: boolean;
  share: boolean;
  realtime: boolean;
  cast: boolean;
  embed: boolean;
  aiGateway: boolean;
}

// —— Domain types (shared across interfaces) ——
export interface AuthUser {
  id: string;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
  createdAt: number; // epoch ms
  lastSignInAt: number | null;
}

// Cloud scene payload: plaintext in the first version (decision 0004 / D1).
export type ScenePayloadKind = "plain" | "encrypted"; // encrypted reserved for P4

export interface SceneRecord {
  id: string | null; // null = new, backfilled by save
  ownerId: string;
  title: string;
  payloadKind: ScenePayloadKind;
  payload: unknown; // plain: ExcalidrawScene JSON; encrypted: {iv,ciphertext}
  version: number;
  thumbnailMeta?: { width: number; height: number; assetId?: string };
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null; // soft delete
}

export interface SceneSummary {
  id: string;
  title: string;
  version: number;
  updatedAt: number;
  thumbnailMeta?: SceneRecord["thumbnailMeta"];
}

export type AssetType =
  | "image"
  | "ai-output"
  | "recording"
  | "export"
  | "embed-preview";

export interface AssetRef {
  id: string;
  ownerId: string;
  sceneId: string | null;
  fileId?: string;
  type: AssetType;
  url: string; // signed URL for private assets
  mimeType?: string;
  bytes: number;
  createdAt: number;
  updatedAt?: number;
}

export type ShareMode = "read" | "write";

export interface ShareLink {
  id: string;
  sceneId: string;
  mode: ShareMode;
  token: string;
  revoked: boolean;
  expiresAt: number | null; // reserved; first version may leave unset
  createdAt: number;
}

export interface SharedSceneLoadResult {
  scene: SceneRecord;
  mode: ShareMode;
  assets: AssetRef[];
}

// —— Auth (BR-AUTH, Phase 1) ——
// First version implements password sign-in only; oauth / magic-link
// signatures are reserved and not implemented in Phase 1.
export type SignInMethod =
  | { kind: "password"; email: string; password: string }
  | { kind: "oauth"; provider: "github" | "google" } // reserved
  | { kind: "magic-link"; email: string }; // reserved

export interface AuthProvider {
  getCurrentUser(): Promise<AuthUser | null>;
  signIn(method: SignInMethod): Promise<AuthUser>;
  signOut(): Promise<void>;
  onAuthStateChange(cb: (user: AuthUser | null) => void): () => void; // returns unsubscribe
}

// —— Cloud scenes (BR-SCENE, Phase 1) ——
export interface SceneStorage {
  save(scene: SceneRecord): Promise<{ id: string; version: number }>;
  load(id: string): Promise<SceneRecord>;
  list(opts?: { sort?: "updatedAt" }): Promise<SceneSummary[]>;
  rename(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>; // soft delete
}

// —— Assets (BR-ASSET, Phase 2) ——
export interface AssetStorage {
  upload(input: {
    blob: Blob;
    type: AssetType;
    sceneId?: string;
    fileId?: string;
    mimeType?: string;
  }): Promise<AssetRef>;
  getUrl(id: string): Promise<string>;
  remove(id: string): Promise<void>;
  listByScene(sceneId: string): Promise<AssetRef[]>;
}

// —— Share (BR-SHARE, Phase 2; D5: read/write/revocable) ——
export interface ShareService {
  create(input: { sceneId: string; mode: ShareMode }): Promise<ShareLink>;
  resolve(token: string): Promise<{ sceneId: string; mode: ShareMode }>;
  revoke(id: string): Promise<void>;
  listByScene(sceneId: string): Promise<ShareLink[]>;
  loadScene(token: string): Promise<SharedSceneLoadResult>;
  saveScene(
    token: string,
    scene: SceneRecord,
  ): Promise<{ id: string; version: number }>;
  uploadAsset(input: {
    token: string;
    blob: Blob;
    type: AssetType;
    sceneId: string;
    fileId?: string;
    mimeType?: string;
  }): Promise<AssetRef>;
}

// —— Realtime (BR-RT, Phase 3/4; Phase 0 only declares existence) ——
export interface RealtimeService {
  isAvailable(): boolean;
  // Phase 0 placeholder + surface capture; collab methods land in Phase 3/4.
}

// —— Cast / Embed / AiGateway: Phase 0 only declares placeholders. ——
export interface CastService {
  isAvailable(): boolean;
}
export interface EmbedService {
  isAvailable(): boolean;
}
export interface AiGateway {
  isEnabled(): boolean;
}

// —— Assembly entry (upper layers import only this) ——
export interface CloudBackend {
  capabilities: BackendCapabilities;
  auth: AuthProvider;
  scenes: SceneStorage;
  assets: AssetStorage;
  shares: ShareService;
  realtime: RealtimeService;
  cast: CastService;
  embed: EmbedService;
  ai: AiGateway;
}
