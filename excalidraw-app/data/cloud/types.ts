import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type { AppState, BinaryFileData } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";

import type { Socket } from "socket.io-client";

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
  aiTasks: boolean;
  collaborationMetadata: boolean;
  realtime: boolean;
  collabRoomBinding: boolean;
  collabPersistence: boolean;
  cast: boolean;
  embed: boolean;
  encryptedCloudStorage: boolean;
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

export interface EncryptedScenePayloadV1 {
  version: 1;
  algorithm: "AES-GCM";
  iv: string;
  ciphertext: string;
}

export interface CloudKeyringEntry {
  sceneId: string;
  key: string;
  createdAt: number;
  updatedAt: number;
}

export interface SceneSummary {
  id: string;
  title: string;
  version: number;
  updatedAt: number;
  thumbnailMeta?: SceneRecord["thumbnailMeta"];
}

export type SceneMetadata = SceneSummary;

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

export type EmbedMode = "read" | "write" | "collab";

export type EmbedTheme = "light" | "dark" | "system";

export type EmbedSize = "responsive" | "wide" | "compact";

export type CollabPersistenceBackend = "none" | "firebase" | "supabase";

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

export interface EmbedRecord {
  id: string;
  ownerId: string;
  sceneId: string;
  mode: EmbedMode;
  token: string;
  allowedOrigins: string[];
  theme: EmbedTheme;
  size: EmbedSize;
  revoked: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface EmbedCreateInput {
  sceneId: string;
  mode: EmbedMode;
  allowedOrigins: string[];
  theme?: EmbedTheme;
  size?: EmbedSize;
}

export interface EmbedUpdateInput {
  mode?: EmbedMode;
  allowedOrigins?: string[];
  theme?: EmbedTheme;
  size?: EmbedSize;
  revoked?: boolean;
}

export interface EmbedResolution {
  sceneId: string;
  mode: EmbedMode;
  allowedOrigins: string[];
  theme: EmbedTheme;
  size: EmbedSize;
}

export interface EmbeddedSceneLoadResult {
  scene: SceneRecord;
  mode: EmbedMode;
  assets: AssetRef[];
  embed: EmbedResolution;
}

export type AITaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface AITaskRecord {
  id: string;
  ownerId: string;
  sceneId: string;
  featureSource: string;
  mediaType: "image" | "video" | "audio";
  mode: string;
  status: AITaskStatus;
  modelId: string;
  modelLabel: string | null;
  providerLabel: string | null;
  promptSummary: string;
  negativePromptSummary: string | null;
  params: unknown;
  inputAssetIds: string[];
  outputAssetIds: string[];
  sourceElementIds: string[];
  insertedElementIds: string[];
  errorCode: string | null;
  errorMessage: string | null;
  submittedAt: number;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export type AITaskCreateInput = Omit<
  AITaskRecord,
  "id" | "ownerId" | "createdAt" | "updatedAt" | "deletedAt"
>;

export type SceneActivityOperation =
  | "create"
  | "update"
  | "delete"
  | "bind"
  | "status-change"
  | "tone-change";

export interface SceneActivityRecord {
  id: string;
  ownerId: string;
  sceneId: string;
  elementId: string | null;
  actorId: string;
  operation: SceneActivityOperation;
  summary: string | null;
  createdAt: number;
}

export type SceneActivityCreateInput = Omit<
  SceneActivityRecord,
  "id" | "ownerId" | "createdAt"
>;

export type CastSessionStatus = "draft" | "ready" | "exported" | "archived";

export type CastExportType = "gif" | "mp4" | "webm" | "interactive";

export interface CastSessionRecord {
  id: string;
  ownerId: string;
  sceneId: string;
  title: string;
  status: CastSessionStatus;
  scriptAssetId: string | null;
  coverAssetId: string | null;
  durationMs: number | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface CastSessionCreateInput {
  sceneId: string;
  title: string;
  status?: CastSessionStatus;
  scriptAssetId?: string | null;
  coverAssetId?: string | null;
  durationMs?: number | null;
}

export interface CastScriptAttachInput {
  scriptAssetId: string;
  coverAssetId?: string | null;
  durationMs?: number | null;
}

export interface CastExportRecord {
  id: string;
  ownerId: string;
  sceneId: string;
  sessionId: string;
  assetId: string;
  type: CastExportType;
  label: string | null;
  mimeType: string | null;
  bytes: number;
  createdAt: number;
  deletedAt: number | null;
}

export type CastExportCreateInput = Omit<
  CastExportRecord,
  "id" | "ownerId" | "createdAt" | "deletedAt"
>;

export type CollabRoomStatus = "active" | "revoked";

export interface CollabRoomRecord {
  id: string;
  ownerId: string;
  sceneId: string;
  roomId: string;
  status: CollabRoomStatus;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
}

export interface CollabRoomCreateInput {
  sceneId: string;
  roomId: string;
}

export interface CollabPersistenceSnapshot {
  roomId: string;
  encryptedData: ArrayBuffer;
  iv: Uint8Array;
  updatedAt: number;
}

export interface CollabPersistenceRoomRef {
  roomId: string | null;
  roomKey: string | null;
  socket: Socket | null;
}

export interface CollabPersistenceSaveSceneInput
  extends CollabPersistenceRoomRef {
  elements: readonly OrderedExcalidrawElement[];
  appState: AppState;
}

export interface CollabPersistenceFilesInput extends CollabPersistenceRoomRef {
  files: { id: FileId; buffer: Uint8Array }[];
}

export interface CollabPersistenceLoadFilesInput
  extends CollabPersistenceRoomRef {
  fileIds: readonly FileId[];
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
  getMetadata(id: string): Promise<SceneMetadata>;
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

// —— AI task metadata (BR-AI, Phase 2C) ——
export interface AITaskService {
  create(input: AITaskCreateInput): Promise<AITaskRecord>;
  list(opts?: { sceneId?: string; limit?: number }): Promise<AITaskRecord[]>;
  remove(id: string): Promise<void>;
}

// —— Collaboration metadata (BR-META, Phase 3A) ——
export interface SceneActivityService {
  create(input: SceneActivityCreateInput): Promise<SceneActivityRecord>;
  listByScene(
    sceneId: string,
    opts?: { limit?: number },
  ): Promise<SceneActivityRecord[]>;
}

// —— Realtime (BR-RT, Phase 3/4; Phase 0 only declares existence) ——
export interface RealtimeService {
  isAvailable(): boolean;
  // Phase 0 placeholder + surface capture; collab methods land in Phase 3/4.
}

// —— Cloud scene ↔ realtime collaboration room binding (BR-RT, Phase 4B) ——
export interface CollabRoomService {
  isAvailable(): boolean;
  createForScene(input: CollabRoomCreateInput): Promise<CollabRoomRecord>;
  getByScene(sceneId: string): Promise<CollabRoomRecord | null>;
  getByRoomId(roomId: string): Promise<CollabRoomRecord | null>;
  revoke(id: string): Promise<void>;
  touch(id: string): Promise<CollabRoomRecord>;
}

// —— Collaboration persistence adapter (BR-RT, Phase 4C) ——
export interface CollabPersistenceService {
  isAvailable(): boolean;
  backend: CollabPersistenceBackend;
  isRoomActive(roomId: string): Promise<boolean>;
  isSaved(
    input: CollabPersistenceRoomRef & {
      elements: readonly ExcalidrawElement[];
    },
  ): boolean;
  saveScene(
    input: CollabPersistenceSaveSceneInput,
  ): Promise<readonly RemoteExcalidrawElement[] | null>;
  loadScene(
    input: CollabPersistenceRoomRef,
  ): Promise<readonly OrderedExcalidrawElement[] | null>;
  saveFiles(input: CollabPersistenceFilesInput): Promise<{
    savedFiles: FileId[];
    erroredFiles: FileId[];
  }>;
  loadFiles(input: CollabPersistenceLoadFilesInput): Promise<{
    loadedFiles: BinaryFileData[];
    erroredFiles: Map<FileId, true>;
  }>;
  saveSnapshot(input: CollabPersistenceSnapshot): Promise<void>;
  loadSnapshot(roomId: string): Promise<CollabPersistenceSnapshot | null>;
}

// —— End-to-end encrypted cloud storage (BR-E2E, Phase 4D) ——
export interface CloudEncryptionService {
  isAvailable(): boolean;
  generateKey(): Promise<string>;
  encryptScenePayload(
    payload: unknown,
    key: string,
  ): Promise<EncryptedScenePayloadV1>;
  decryptScenePayload(
    payload: EncryptedScenePayloadV1,
    key: string,
  ): Promise<unknown>;
  encryptBlob(blob: Blob, key: string): Promise<Blob>;
  decryptBlob(blob: Blob, key: string): Promise<Blob>;
  saveKey(entry: CloudKeyringEntry): void;
  getKey(sceneId: string): CloudKeyringEntry | null;
  removeKey(sceneId: string): void;
}

// —— Cast (BR-CAST, Phase 3B) ——
export interface CastService {
  isAvailable(): boolean;
  createSession(input: CastSessionCreateInput): Promise<CastSessionRecord>;
  listByScene(
    sceneId: string,
    opts?: { limit?: number },
  ): Promise<CastSessionRecord[]>;
  attachScript(
    sessionId: string,
    input: CastScriptAttachInput,
  ): Promise<CastSessionRecord>;
  registerExport(input: CastExportCreateInput): Promise<CastExportRecord>;
  listExportsByScene(
    sceneId: string,
    opts?: { limit?: number },
  ): Promise<CastExportRecord[]>;
  remove(sessionId: string): Promise<void>;
}

// —— Embed (BR-EMBED, Phase 3C; D6: iframe + JS API) ——
export interface EmbedService {
  isAvailable(): boolean;
  create(input: EmbedCreateInput): Promise<EmbedRecord>;
  listByScene(
    sceneId: string,
    opts?: { limit?: number },
  ): Promise<EmbedRecord[]>;
  update(id: string, input: EmbedUpdateInput): Promise<EmbedRecord>;
  revoke(id: string): Promise<void>;
  resolve(token: string, origin: string): Promise<EmbedResolution>;
  loadScene(token: string, origin: string): Promise<EmbeddedSceneLoadResult>;
  saveScene(
    token: string,
    origin: string,
    scene: SceneRecord,
  ): Promise<{ id: string; version: number }>;
  uploadAsset(input: {
    token: string;
    origin: string;
    blob: Blob;
    type: AssetType;
    sceneId: string;
    fileId?: string;
    mimeType?: string;
  }): Promise<AssetRef>;
}

// —— AiGateway: Phase 0 only declares placeholders. ——
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
  aiTasks: AITaskService;
  activity: SceneActivityService;
  realtime: RealtimeService;
  collabRooms: CollabRoomService;
  collabPersistence: CollabPersistenceService;
  encryption: CloudEncryptionService;
  cast: CastService;
  embed: EmbedService;
  ai: AiGateway;
}
