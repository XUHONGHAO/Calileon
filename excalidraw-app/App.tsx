import {
  Excalidraw,
  LiveCollaborationTrigger,
  TTDDialogTrigger,
  CaptureUpdateAction,
  reconcileElements,
  useEditorInterface,
  ExcalidrawAPIProvider,
  useExcalidrawAPI,
} from "@excalidraw/excalidraw";
import { trackEvent } from "@excalidraw/excalidraw/analytics";
import { getDefaultAppState } from "@excalidraw/excalidraw/appState";
import {
  CommandPalette,
  DEFAULT_CATEGORIES,
} from "@excalidraw/excalidraw/components/CommandPalette/CommandPalette";
import { ErrorDialog } from "@excalidraw/excalidraw/components/ErrorDialog";
import { Button } from "@excalidraw/excalidraw/components/Button";
import { OverwriteConfirmDialog } from "@excalidraw/excalidraw/components/OverwriteConfirm/OverwriteConfirm";
import { openConfirmModal } from "@excalidraw/excalidraw/components/OverwriteConfirm/OverwriteConfirmState";
import { ShareableLinkDialog } from "@excalidraw/excalidraw/components/ShareableLinkDialog";
import Trans from "@excalidraw/excalidraw/components/Trans";
import {
  APP_NAME,
  DEFAULT_SIDEBAR,
  EVENT,
  VERSION_TIMEOUT,
  debounce,
  getVersion,
  getFrame,
  isTestEnv,
  preventUnload,
  resolvablePromise,
  isRunningInIframe,
  isDevEnv,
} from "@excalidraw/common";
import polyfill from "@excalidraw/excalidraw/polyfill";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { loadFromBlob } from "@excalidraw/excalidraw/data/blob";
import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";
import { t } from "@excalidraw/excalidraw/i18n";

import {
  GithubIcon,
  XBrandIcon,
  DiscordIcon,
  ExcalLogo,
  exportToPlus,
  youtubeIcon,
} from "@excalidraw/excalidraw/components/icons";
import { isElementLink } from "@excalidraw/element";
import {
  bumpElementVersions,
  restoreAppState,
  restoreElements,
} from "@excalidraw/excalidraw/data/restore";
import { newElementWith } from "@excalidraw/element";
import { isInitializedFileBackedElement } from "@excalidraw/element";
import clsx from "clsx";
import {
  parseLibraryTokensFromUrl,
  useHandleLibrary,
} from "@excalidraw/excalidraw/data/library";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  AudioAvatar,
  FileId,
  ExcalidrawEmbeddableElement,
  ExcalidrawFreeDrawElement,
  ExcalidrawElement,
  NonDeleted,
  NonDeletedExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  ExcalidrawImperativeAPI,
  BinaryFileData,
  BinaryFiles,
  ExcalidrawInitialDataState,
  UIAppState,
  ExcalidrawProps,
} from "@excalidraw/excalidraw/types";
import type { ResolutionType } from "@excalidraw/common/utility-types";
import type { ResolvablePromise } from "@excalidraw/common/utils";

import CustomStats from "./CustomStats";
import {
  Provider,
  useAtom,
  useAtomValue,
  useAtomWithInitialValue,
  appJotaiStore,
} from "./app-jotai";
import {
  FIREBASE_STORAGE_PREFIXES,
  isExcalidrawPlusSignedUser,
  STORAGE_KEYS,
  SYNC_BROWSER_TABS_TIMEOUT,
} from "./app_constants";
import Collab, {
  collabAPIAtom,
  isCollaboratingAtom,
  isOfflineAtom,
} from "./collab/Collab";
import { AppFooter } from "./components/AppFooter";
import { AppMainMenu } from "./components/AppMainMenu";
import { SingleFileDialog } from "./components/SingleFileDialog";
import { AppWelcomeScreen } from "./components/AppWelcomeScreen";
import { AITaskListDialog } from "./components/AITaskListDialog";
import { AuthDialog } from "./components/AuthDialog";
import { EmbedListDialog } from "./components/EmbedListDialog";
import { SceneListDialog } from "./components/SceneListDialog";
import {
  ExportToExcalidrawPlus,
  exportToExcalidrawPlus,
} from "./components/ExportToExcalidrawPlus";
import { TopErrorBoundary } from "./components/TopErrorBoundary";
import { VaultStatus } from "./components/VaultStatus";
import { VaultV2Status } from "./components/VaultV2Status";
import { VaultConflictDialog } from "./components/VaultConflictDialog";
import { VaultShareDialog } from "./components/VaultShareDialog";
import { VaultManagedAI } from "./components/VaultManagedAI";
import { VaultMigrationControl } from "./components/VaultMigrationControl";
import { AIDeviceApproval } from "./components/AIDeviceApproval";
import {
  AI_AGENT_CONFIG_UPDATED_EVENT,
  loadAIAgentConfig,
} from "./ai/agentConfig";
import {
  AI_GENERATION_LOGS_UPDATED_EVENT,
  loadAIGenerationLogs,
} from "./ai/generationLog";
import {
  AI_PROMPT_TEMPLATES_UPDATED_EVENT,
  getAllPromptTemplates,
} from "./ai/promptTemplates";
import {
  createAIGenerationLogCommands,
  createAIPromptTemplateCommands,
  createAISkillCommands,
  createAISettingsCommands,
  createCoreAIWorkflowCommands,
  createOfficeWorkflowCommands,
} from "./ai/workflowCommands";
import {
  getOrCreateLocalDocumentId,
  resolveAIWorkbenchPersistenceScope,
  rotateLocalDocumentId,
  shouldRotateLocalDocumentId,
} from "./ai/workbenchPersistenceScope";

import { localStore, shareLink, firebaseStore } from "./data/cloud";
import { createSupabaseVaultBackend, getCloudBackend } from "./data/cloud";
import {
  loadAssetRefsForElements,
  loadEncryptedAssetRefsForElements,
  loadEncryptedSceneAssets,
  loadSceneAssets,
  uploadEncryptedEmbeddedSceneAssets,
  uploadEncryptedSharedSceneAssets,
  uploadEncryptedSceneAssets,
  uploadSceneAssets,
  uploadEmbeddedSceneAssets,
  uploadSharedSceneAssets,
} from "./data/cloud/cloudAssets";
import { recordCloudAITask } from "./data/cloud/cloudAITasks";
import { forwardCastEditorPointerUpdate } from "./cast";
import { getCloudEmbedAccessFromUrl } from "./data/cloud/cloudEmbedLinks";
import { getCloudShareAccessFromUrl } from "./data/cloud/cloudShareLinks";
import {
  createEmbedError,
  createEmbedEvent,
  createEmbedResponse,
  isEmbedApiEnvelope,
} from "./data/cloud/embedPostMessage";
import { getEmbedParentOrigin } from "./data/cloud/embedOrigin";
import {
  getCloudSceneFingerprint,
  getCloudPayloadHash,
  loadCloudSceneBinding,
  saveCloudSceneBinding,
} from "./data/cloud/sceneBinding";
import { isEncryptedScenePayloadV1 } from "./data/cloud/CloudEncryptionService";
import {
  assertVaultClientConfig,
  createVaultSnapshotAutosaveController,
  createHttpVaultDeploymentDiscoveryTransport,
  deriveVaultRecoveryState,
  discoverVaultDeployment,
  isVaultRecoveryBlockedCode,
  getVaultLinkData,
  hasVaultUrlMarker,
  openVault,
  readVaultClientConfig,
  readVaultSessionSecrets,
  VaultLocalStore,
  VaultError,
} from "./data/vault";

import { getSceneFileIds, updateStaleImageStatuses } from "./data/FileManager";
import { FileStatusStore } from "./data/fileStatusStore";
import { isBrowserStorageStateNewer } from "./data/tabSync";
import { ShareDialog, shareDialogStateAtom } from "./share/ShareDialog";
import CollabError, { collabErrorIndicatorAtom } from "./collab/CollabError";
import { useHandleAppTheme } from "./useHandleAppTheme";
import { getPreferredLanguage } from "./app-language/language-detector";
import { useAppLangCode } from "./app-language/language-state";
import DebugCanvas, {
  debugRenderer,
  isVisualDebuggerEnabled,
  loadSavedDebugState,
} from "./components/DebugCanvas";
import { AIComponents } from "./components/AI";
import {
  AIMaskEditingController,
  type AIMaskEditingControllerHandle,
} from "./components/AIMaskEditingController";
import { ExcalidrawPlusIframeExport } from "./ExcalidrawPlusIframeExport";
import { useCloudAuth } from "./auth/useCloudAuth";

import "./index.scss";

import { ExcalidrawPlusPromoBanner } from "./components/ExcalidrawPlusPromoBanner";
import { AppSidebar } from "./components/AppSidebar";
import { ConfirmHost } from "./components/ui";
import { AIVideoAssetPlayer } from "./components/AIVideoAssetPlayer";

import {
  buildAIVideoAssetLink,
  getAIVideoAssetIdFromEmbeddable,
  getAIVideoGenerationMetadataFromEmbeddable,
  getAIVideoURLFromEmbeddable,
  isValidAIVideoEmbeddable,
} from "./ai/videoCanvas";
import { seedVideoPlaybackURLCache } from "./ai/videoPlaybackURLCache";
import {
  assertAIVideoPersistenceContext,
  resolveAIVideoPersistenceContextToken,
} from "./ai/videoPersistenceContext";
import { createAIVideoAssetMetadata } from "./ai/metadata";
import {
  createAIVideoMigrationSnapshot,
  hasAIVideoGenerationMarker,
  hasNonPortableAIVideo,
  omitAIVideoMarkersForInitialCloudSave,
  replaceAIVideoAssetIfCurrent,
  sanitizeDeletedAIVideoMarkersForPersistence,
} from "./ai/videoAssetMigration";
import {
  loadLocalAIVideoAsset,
  persistLocalAIVideoURL,
} from "./data/AIVideoURLVault";

import { isVaultV2Enabled, isVaultV2Route } from "./data/vault/v2/flag";

import { confirmAction } from "./components/ui";

import type { CollabAPI } from "./collab/Collab";
import type {
  AIGenerationLogEntry,
  AIMaskReadyPayload,
  AISkill,
  PromptTemplate,
} from "./ai/types";
import type {
  AIReferenceAddRequest,
  AssistantSkillRequest,
  GenerationLogReuseRequest,
  PromptTemplateRequest,
} from "./components/AppSidebar";
import type { PersistAIVideoOutputInput } from "./components/AIImageWorkbench";
import type {
  CollabRoomRecord,
  EmbedMode,
  ScenePayloadKind,
  SceneRecord,
  SceneSummary,
  VideoAssetIngestResult,
} from "./data/cloud";
import type { CloudAITaskRun } from "./data/cloud/cloudAITasks";
import type { VaultBackend } from "./data/cloud";
import type { VaultConflictInfo } from "./components/VaultConflictDialog";
import type {
  OpenedVault,
  VaultAttachmentQueueState,
  VaultClientConfig,
  VaultClientSession,
  VaultDeploymentDiscoveryTransport,
  VaultDeploymentReady,
  VaultLinkData,
  VaultOwnerService,
  VaultPersistenceService,
  VaultAutosaveUnsyncedReason,
  VaultEncryptedAssetService,
  VaultErrorCode,
  VaultRecoveryState,
  VaultSnapshotAutosaveController,
  VaultSnapshotAutosaveState,
  VaultSyncStatus,
} from "./data/vault";

import type { VaultMigrationApi } from "./components/VaultMigrationControl";
// type-only: erased, so the v2 code stays in its lazy chunk
import type { VaultV2AppSession as VaultV2Session } from "./data/vault/v2/appBinding";
import type { VaultV2UiState } from "./data/vault/v2/uiState";

polyfill();

const CLOUD_AUTOSAVE_DEBOUNCE_MS = 3000;
const CLOUD_BINDING_SYNC_DEBOUNCE_MS = 500;
const CLOUD_REMOTE_UPDATE_CHECK_MS = 60000;

type ActiveCloudScene = {
  id: string;
  ownerId: string;
  title: string;
  payloadKind: ScenePayloadKind;
  version: number;
  createdAt: number;
  updatedAt: number;
};

type ActiveSharedScene = ActiveCloudScene & {
  token: string;
  mode: "read" | "write";
  encryptionKey: string | null;
};

type ActiveEmbeddedScene = ActiveCloudScene & {
  token: string;
  mode: EmbedMode;
  origin: string;
  encryptionKey: string | null;
};

export type VaultAutosaveSnapshot = {
  readonly elements: readonly OrderedExcalidrawElement[];
  readonly appState: Partial<AppState>;
  readonly files: BinaryFiles;
};

export type ActiveVault = {
  readonly session: VaultClientSession;
  readonly owner: VaultOwnerService;
  readonly persistence: VaultPersistenceService;
  readonly assets: VaultEncryptedAssetService;
  readonly localStore?: VaultLocalStore;
  readonly generation: number;
  readonly syncStatus: VaultSyncStatus;
  readonly autosaveErrorCode?: VaultErrorCode | null;
  readonly autosaveUnsyncedReason?: VaultAutosaveUnsyncedReason | null;
  readonly autosaveLocalPersistence?:
    | "not-persisted"
    | "local-persisted"
    | "remote-confirmed";
  readonly autosaveBeforeUnloadState?:
    | "none"
    | "local-persistence-pending"
    | "local-persisted-unsynced";
  readonly attachmentPending?: number;
  readonly attachmentFailed?: number;
  /** False once the realtime room link dropped; reset by reopening the Vault. */
  readonly realtimeAvailable?: boolean;
  /**
   * Non-secret diagnostic trail of why the realtime link was lost, e.g.
   * "disconnected>reconnect-failed". Error codes only, never messages.
   */
  readonly realtimeLostReason?: string;
  readonly realtimeLostCode?: VaultErrorCode | null;
};

/** Why the realtime room link stopped being available (diagnostics only). */
export type VaultRealtimeLostReason =
  | "join-failed"
  | "disconnected"
  | "reconnect-failed"
  | "message-error"
  | "teardown";

const VAULT_REALTIME_LOST_TRAIL_MAX = 4;

const createVaultAutosaveSnapshot = (
  elements: readonly ExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
) => {
  const serializedScene = JSON.parse(
    serializeAsJSON(elements, appState, files, "database"),
  ) as Partial<VaultAutosaveSnapshot>;
  const snapshot: VaultAutosaveSnapshot = {
    elements: serializedScene.elements ?? [],
    appState: serializedScene.appState ?? {},
    files: serializedScene.files ?? {},
  };
  return {
    serializedSnapshot: JSON.stringify(snapshot),
    snapshot,
  };
};

export const reconcileVaultAutosaveSnapshots = (
  pendingSnapshot: VaultAutosaveSnapshot,
  latestSnapshot: VaultAutosaveSnapshot,
  localAppState: AppState,
): VaultAutosaveSnapshot => ({
  elements: reconcileElements(
    pendingSnapshot.elements,
    latestSnapshot.elements as readonly RemoteExcalidrawElement[],
    localAppState,
  ),
  appState: pendingSnapshot.appState,
  files: { ...latestSnapshot.files, ...pendingSnapshot.files },
});

/**
 * Fail-closed codes that must surface as `blocked` (never as merely unsynced)
 * for the current Vault session.
 */
export const getVaultRecoveryBlockedCode = (
  vault: Pick<ActiveVault, "syncStatus" | "autosaveErrorCode">,
): VaultErrorCode | null => {
  if (vault.syncStatus === "revoked") {
    return "VAULT_CAPABILITY_REVOKED";
  }
  if (vault.syncStatus === "expired") {
    return "VAULT_CAPABILITY_EXPIRED";
  }
  if (vault.syncStatus === "closed") {
    return "VAULT_CAPABILITY_FORBIDDEN";
  }
  return vault.autosaveErrorCode ?? null;
};

/** Derived recovery state shared by the status UI and the conflict dialog. */
export const deriveActiveVaultRecoveryState = (
  vault: Pick<
    ActiveVault,
    | "session"
    | "syncStatus"
    | "autosaveUnsyncedReason"
    | "autosaveErrorCode"
    | "autosaveLocalPersistence"
    | "localStore"
    | "attachmentPending"
    | "attachmentFailed"
    | "realtimeAvailable"
  >,
  isOnline: boolean,
): VaultRecoveryState =>
  deriveVaultRecoveryState({
    opening: vault.syncStatus === "loading",
    snapshot: {
      status:
        vault.syncStatus === "synced"
          ? "synced"
          : vault.syncStatus === "syncing"
          ? "syncing"
          : "unsynced",
      unsyncedReason: vault.autosaveUnsyncedReason ?? null,
      errorCode: vault.autosaveErrorCode ?? null,
      localPersistence: vault.autosaveLocalPersistence ?? "not-persisted",
    },
    attachments: {
      pending: vault.attachmentPending ?? 0,
      failed: vault.attachmentFailed ?? 0,
    },
    isOnline,
    localStorageAvailable: Boolean(vault.localStore),
    blockedCode: getVaultRecoveryBlockedCode(vault),
    readOnly: vault.session.role !== "editor",
    realtimeAvailable: vault.realtimeAvailable ?? true,
  });

/**
 * Status after the realtime transport tore down. Only fail-closed codes may
 * present the session as revoked or expired; a transient failure such as an
 * admission timeout is a lost realtime link, not lost access.
 */
export const getVaultRealtimeTeardownStatus = (
  code: VaultErrorCode,
): VaultSyncStatus => {
  if (code === "VAULT_CAPABILITY_EXPIRED") {
    return "expired";
  }
  return isVaultRecoveryBlockedCode(code) ? "revoked" : "unsynced";
};

/**
 * Applies a realtime status change. Terminal session states are never
 * downgraded to a mere realtime loss, and the first loss reason and code are
 * kept while later steps are appended to a bounded diagnostic trail.
 */
export const applyVaultRealtimeStatus = (
  vault: ActiveVault,
  syncStatus: VaultSyncStatus,
  lost?: { reason: VaultRealtimeLostReason; code: VaultErrorCode | null },
): ActiveVault => {
  const terminal =
    vault.syncStatus === "revoked" ||
    vault.syncStatus === "expired" ||
    vault.syncStatus === "closed";
  const trail = vault.realtimeLostReason?.split(">") ?? [];
  if (
    lost &&
    trail[trail.length - 1] !== lost.reason &&
    trail.length < VAULT_REALTIME_LOST_TRAIL_MAX
  ) {
    trail.push(lost.reason);
  }
  return Object.freeze({
    ...vault,
    syncStatus:
      terminal && syncStatus === "unsynced" ? vault.syncStatus : syncStatus,
    realtimeAvailable: syncStatus === "synced",
    realtimeLostReason: trail.length ? trail.join(">") : undefined,
    realtimeLostCode: vault.realtimeLostCode ?? lost?.code ?? null,
  });
};

// Only the persisted-state fields matter for room recovery: a reconnect may
// proceed once the local snapshot is fully flushed and nothing is pending.
// Narrowing here keeps the contract honest and lets callers (incl. tests) pass
// minimal flush results without the full VaultSnapshotAutosaveState.
export type VaultRoomRecoveryAutosave = {
  flush(): Promise<
    Pick<VaultSnapshotAutosaveState, "status" | "hasPendingChanges">
  >;
};

export const recoverVaultAfterRoomReconnect = async (
  autosave: VaultRoomRecoveryAutosave | null,
  reload: () => void,
) => {
  if (autosave) {
    const state = await autosave.flush();
    if (state.status !== "synced" || state.hasPendingChanges) {
      throw new VaultError(
        "VAULT_PERSISTENCE_UNAVAILABLE",
        "Vault room recovery requires a fully persisted snapshot.",
      );
    }
  }
  reload();
};

export const prepareVaultAutosaveSnapshot = (
  previousSerializedSnapshot: string | null,
  elements: readonly ExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
) => {
  const prepared = createVaultAutosaveSnapshot(elements, appState, files);
  if (prepared.serializedSnapshot === previousSerializedSnapshot) {
    return null;
  }
  return prepared;
};

type CloudSceneRemoteUpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "up-to-date"; checkedAt: number }
  | { status: "remote-newer"; metadata: SceneSummary; checkedAt: number }
  | { status: "error"; message: string; checkedAt: number };

// Phase 0: all backend/persistence access goes through the `data/cloud`
// adapter layer. These bindings keep today's call sites unchanged while
// removing direct imports of `data/{localStorage,LocalData,firebase,index}`
// from this component (decision 0001 / DoD §2).
const {
  importFromLocalStorage,
  importUsernameFromLocalStorage,
  LocalData,
  LibraryIndexedDBAdapter,
  LibraryLocalStorageMigrationAdapter,
  localStorageQuotaExceededAtom,
} = localStore;
const {
  exportToBackend,
  importFromBackend,
  getCollaborationLinkData,
  isCollaborationLink,
} = shareLink;
const { loadFilesFromFirebase } = firebaseStore;

window.EXCALIDRAW_THROTTLE_RENDER = true;

declare global {
  interface BeforeInstallPromptEventChoiceResult {
    outcome: "accepted" | "dismissed";
  }

  interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<BeforeInstallPromptEventChoiceResult>;
  }

  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
  }
}

let pwaEvent: BeforeInstallPromptEvent | null = null;

// Adding a listener outside of the component as it may (?) need to be
// subscribed early to catch the event.
//
// Also note that it will fire only if certain heuristics are met (user has
// used the app for some time, etc.)
window.addEventListener(
  "beforeinstallprompt",
  (event: BeforeInstallPromptEvent) => {
    // prevent Chrome <= 67 from automatically showing the prompt
    event.preventDefault();
    // cache for later use
    pwaEvent = event;
  },
);

let isSelfEmbedding = false;

if (window.self !== window.top) {
  try {
    const parentUrl = new URL(document.referrer);
    const currentUrl = new URL(window.location.href);
    if (parentUrl.origin === currentUrl.origin) {
      isSelfEmbedding = true;
    }
  } catch (error) {
    // ignore
  }
}

const shareableLinkConfirmDialog = {
  title: t("overwriteConfirm.modal.shareableLink.title"),
  description: (
    <Trans
      i18nKey="overwriteConfirm.modal.shareableLink.description"
      bold={(text) => <strong>{text}</strong>}
      br={() => <br />}
    />
  ),
  actionLabel: t("overwriteConfirm.modal.shareableLink.button"),
  color: "danger",
} as const;

const getVaultRouteErrorMessage = (code: VaultError["code"]) => {
  switch (code) {
    case "VAULT_URL_INVALID":
      return t("vault.errors.invalidUrl");
    case "VAULT_PROTOCOL_UNSUPPORTED":
      return t("vault.errors.protocolUnsupported");
    case "VAULT_DECRYPT_FAILED":
      return t("vault.errors.decryptFailed");
    case "VAULT_ENVELOPE_INVALID":
      return t("vault.errors.integrityFailed");
    case "VAULT_CAPABILITY_EXPIRED":
      return t("vault.errors.expired");
    case "VAULT_CAPABILITY_REVOKED":
      return t("vault.errors.revoked");
    case "VAULT_CAPABILITY_INVALID":
    case "VAULT_CAPABILITY_FORBIDDEN":
      return t("vault.errors.accessDenied");
    case "VAULT_LOCAL_STORAGE_UNAVAILABLE":
      return t("vault.errors.localStorageUnavailable");
    default:
      return t("vault.errors.unavailable");
  }
};

const subscribeNothing = () => () => {};

/** W6: the v2 session's pill state (null without a v2 session) */
const useVaultV2UiState = (
  session: VaultV2Session | null,
): VaultV2UiState | null =>
  useSyncExternalStore(
    session?.ui.subscribe ?? subscribeNothing,
    () => session?.ui.get() ?? null,
  );

const getBlockedVaultScene = (code: VaultError["code"], vaultId?: string) => ({
  scene: {
    elements: [],
    files: {},
    appState: restoreAppState(
      {
        isLoading: false,
        viewModeEnabled: true,
        errorMessage: getVaultRouteErrorMessage(code),
      },
      null,
    ),
  },
  isExternalScene: true as const,
  id: vaultId ?? "vault",
  key: "",
});

const isCurrentVaultRoute = () => hasVaultUrlMarker(window.location.href);

export const isVaultExternalFeatureDisabled = (
  activeVault: ActiveVault | null,
): boolean => Boolean(activeVault) || isCurrentVaultRoute();

type ReadyVaultClientConfig = VaultClientConfig & {
  enabled: true;
  persistenceCapabilitiesUrl: string;
  roomCapabilitiesUrl: string;
  roomProvisionUrl: string;
};

const readReadyVaultClientConfig = (): ReadyVaultClientConfig => {
  const config = readVaultClientConfig();
  assertVaultClientConfig(config);
  return config;
};

export interface VaultSceneRouteDependencies {
  readConfig(): ReadyVaultClientConfig;
  createDiscoveryTransport(input: {
    persistenceCapabilitiesUrl: string;
    roomCapabilitiesUrl: string;
  }): VaultDeploymentDiscoveryTransport;
  discover(
    transport: VaultDeploymentDiscoveryTransport,
  ): Promise<{ ready: VaultDeploymentReady }>;
  createBackend(deployment: VaultDeploymentReady): VaultBackend;
  open(input: {
    deployment: VaultDeploymentReady;
    persistence: VaultPersistenceService;
    link: VaultLinkData;
    createEmptySnapshot: () => unknown;
    localStore?: VaultLocalStore;
  }): Promise<OpenedVault<unknown>>;
  openLocalStore?: () => Promise<VaultLocalStore>;
}

const defaultVaultSceneRouteDependencies: VaultSceneRouteDependencies = {
  readConfig: readReadyVaultClientConfig,
  createDiscoveryTransport: createHttpVaultDeploymentDiscoveryTransport,
  discover: discoverVaultDeployment,
  createBackend: createSupabaseVaultBackend,
  open: openVault,
  openLocalStore: () => VaultLocalStore.open(),
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertVaultSceneSnapshot = (
  value: unknown,
  role: VaultClientSession["role"],
): ExcalidrawInitialDataState => {
  if (!isRecord(value)) {
    throw new VaultError("VAULT_ENVELOPE_INVALID", "Invalid Vault scene.");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 3 ||
    !["elements", "appState", "files"].every((key) => keys.includes(key)) ||
    !Array.isArray(value.elements) ||
    !isRecord(value.appState) ||
    !isRecord(value.files)
  ) {
    throw new VaultError("VAULT_ENVELOPE_INVALID", "Invalid Vault scene.");
  }

  const snapshotElements = value.elements;
  const elements = restoreElements(snapshotElements, null, {
    repairBindings: true,
    deleteInvisibleElements: true,
  });
  if (
    elements.length !== snapshotElements.length ||
    elements.some((element, index) => {
      const source = snapshotElements[index];
      return (
        !isRecord(source) ||
        source.id !== element.id ||
        source.type !== element.type
      );
    })
  ) {
    throw new VaultError("VAULT_ENVELOPE_INVALID", "Invalid Vault scene.");
  }

  for (const [fileId, file] of Object.entries(value.files)) {
    if (
      !isRecord(file) ||
      file.id !== fileId ||
      typeof file.mimeType !== "string" ||
      typeof file.dataURL !== "string" ||
      typeof file.created !== "number" ||
      !Number.isFinite(file.created) ||
      (file.lastRetrieved !== undefined &&
        (typeof file.lastRetrieved !== "number" ||
          !Number.isFinite(file.lastRetrieved))) ||
      (file.version !== undefined &&
        (typeof file.version !== "number" ||
          !Number.isSafeInteger(file.version)))
    ) {
      throw new VaultError("VAULT_ENVELOPE_INVALID", "Invalid Vault scene.");
    }
  }

  const appState = restoreAppState(value.appState as Partial<AppState>, null);
  return {
    elements,
    files: value.files as BinaryFiles,
    appState: {
      ...appState,
      isLoading: false,
      viewModeEnabled: role === "viewer" ? true : appState.viewModeEnabled,
    },
  };
};

export const openVaultSceneFromLink = async (
  link: VaultLinkData,
  dependencies: VaultSceneRouteDependencies = defaultVaultSceneRouteDependencies,
) => {
  const config = dependencies.readConfig();
  const transport = dependencies.createDiscoveryTransport({
    persistenceCapabilitiesUrl: config.persistenceCapabilitiesUrl,
    roomCapabilitiesUrl: config.roomCapabilitiesUrl,
  });
  const { ready } = await dependencies.discover(transport);
  const backend = dependencies.createBackend(ready);
  const localStore = dependencies.openLocalStore
    ? await dependencies.openLocalStore()
    : undefined;
  let opened: OpenedVault<unknown>;
  try {
    opened = await dependencies.open({
      deployment: ready,
      persistence: backend.persistence,
      link,
      createEmptySnapshot: () => ({ elements: [], appState: {}, files: {} }),
      localStore,
    });
  } catch (error) {
    localStore?.close();
    throw error;
  }
  let scene: ExcalidrawInitialDataState;
  try {
    scene = assertVaultSceneSnapshot(opened.snapshot, opened.session.role);
  } catch (error) {
    opened.localStore?.close();
    throw error;
  }
  return {
    scene,
    activeVault: Object.freeze({
      session: opened.session,
      owner: backend.owner,
      persistence: backend.persistence,
      assets: backend.assets,
      generation: opened.generation,
      syncStatus: opened.syncStatus,
      localStore: opened.localStore,
    }),
    isExternalScene: true as const,
    id: link.vaultId,
    key: "",
  };
};

/**
 * P4c W4: migration of the open v1 Vault (flag on only). The v2 code is
 * loaded on demand, so the main bundle stays free of Yjs.
 */
const createVaultMigrationApi = (
  vault: ActiveVault,
  excalidrawAPI: ExcalidrawImperativeAPI,
): VaultMigrationApi => {
  const { rootKey } = readVaultSessionSecrets(vault.session);
  const source = {
    vaultId: vault.session.vaultId,
    rootKey,
    role: vault.session.role,
    readScene: () => ({
      elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
      appState: excalidrawAPI.getAppState(),
    }),
    readFiles: () => excalidrawAPI.getFiles(),
  };
  return {
    readMigratedLink: async () =>
      (
        await import("./data/vault/v2/appBinding")
      ).readVaultV2MigratedLinkForApp(source),
    migrate: async () =>
      (await import("./data/vault/v2/appBinding")).migrateVaultToV2ForApp(
        source,
        { owner: vault.owner, assets: vault.assets },
      ),
    // the old Vault is now a pointer: read-only on this device (a prompt,
    // not enforcement — the server does not mark v1 Vaults)
    onMigrated: () =>
      excalidrawAPI.updateScene({ appState: { viewModeEnabled: true } }),
  };
};

export const initializeScene = async (opts: {
  collabAPI: CollabAPI | null;
  excalidrawAPI: ExcalidrawImperativeAPI;
  openVaultRoute?: typeof openVaultSceneFromLink;
}): Promise<
  {
    scene: ExcalidrawInitialDataState | null;
    didReplaceLocalScene?: boolean;
    activeCloudScene?: ActiveCloudScene | null;
    activeSharedScene?: ActiveSharedScene | null;
    activeEmbeddedScene?: ActiveEmbeddedScene | null;
    activeVault?: ActiveVault | null;
    vaultV2Session?: VaultV2Session | null;
    isCloudShareScene?: boolean;
    isCloudEmbedScene?: boolean;
  } & (
    | { isExternalScene: true; id: string; key: string }
    | { isExternalScene: false; id?: null; key?: null }
  )
> => {
  // P4c Vault v2: only with the flag on; otherwise a `vault=2` link falls
  // through to the v1 parser below, which refuses it (fail closed)
  if (isVaultV2Route(window.location.href)) {
    try {
      const { openVaultV2ForApp } = await import("./data/vault/v2/appBinding");
      const { session } = await openVaultV2ForApp(window.location.href, {
        onBlocked: (error) =>
          opts.excalidrawAPI.updateScene({
            appState: {
              viewModeEnabled: true,
              errorMessage: getVaultRouteErrorMessage(error.code),
            },
          }),
        onError: (error) => {
          if (import.meta.env.DEV) {
            console.error(error);
          }
        },
      });
      return {
        scene: {
          elements: [],
          files: {},
          appState: restoreAppState(
            { isLoading: false, viewModeEnabled: session.role === "viewer" },
            null,
          ),
        },
        vaultV2Session: session,
        isExternalScene: true as const,
        id: session.vaultId,
        key: "",
      };
    } catch (error) {
      return getBlockedVaultScene(
        error instanceof VaultError ? error.code : "VAULT_INTERNAL",
      );
    }
  }

  if (hasVaultUrlMarker(window.location.href)) {
    let vaultId: string | undefined;
    try {
      const vaultLinkData = getVaultLinkData(window.location.href);
      if (!vaultLinkData) {
        throw new VaultError("VAULT_URL_INVALID", "Invalid Vault URL.");
      }
      vaultId = vaultLinkData.vaultId;
      return await (opts.openVaultRoute ?? openVaultSceneFromLink)(
        vaultLinkData,
      );
    } catch (error) {
      return getBlockedVaultScene(
        error instanceof VaultError ? error.code : "VAULT_INTERNAL",
        vaultId,
      );
    }
  }

  const searchParams = new URLSearchParams(window.location.search);
  const id = searchParams.get("id");
  const jsonBackendMatch = window.location.hash.match(
    /^#json=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/,
  );
  const externalUrlMatch = window.location.hash.match(/^#url=(.*)$/);
  const cloudShareAccess = getCloudShareAccessFromUrl(window.location.href);
  const cloudEmbedAccess = getCloudEmbedAccessFromUrl(window.location.href);
  const cloudShareToken = cloudShareAccess?.token ?? null;
  const cloudEmbedToken = cloudEmbedAccess?.token ?? null;

  const localDataState = importFromLocalStorage();

  let scene: ExcalidrawInitialDataState & {
    scrollToContent?: boolean;
  } = {
    elements: restoreElements(localDataState?.elements, null, {
      repairBindings: true,
      deleteInvisibleElements: true,
    }),
    appState: restoreAppState(localDataState?.appState, null),
  };

  let roomLinkData = getCollaborationLinkData(window.location.href);
  let activeSharedScene: ActiveSharedScene | null = null;
  let activeEmbeddedScene: ActiveEmbeddedScene | null = null;
  let isCloudShareScene = false;
  let isCloudEmbedScene = false;
  let didReplaceLocalScene = false;
  const isExternalScene = !!(
    id ||
    jsonBackendMatch ||
    roomLinkData ||
    cloudShareToken ||
    cloudEmbedToken
  );
  if (isExternalScene) {
    if (
      // don't prompt if scene is empty
      !(scene.elements?.length ?? 0) ||
      // don't prompt for collab scenes because we don't override local storage
      roomLinkData ||
      // otherwise, prompt whether user wants to override current scene
      (await openConfirmModal(shareableLinkConfirmDialog))
    ) {
      const backend = getCloudBackend();
      if (cloudEmbedToken) {
        try {
          const origin = getEmbedParentOrigin({
            referrer: document.referrer,
            fallbackOrigin: window.location.origin,
          });
          if (!origin) {
            throw new Error(t("cloud.embed.forbiddenOrigin"));
          }

          const embedded = await backend.embed.loadScene(
            cloudEmbedToken,
            origin,
          );
          let payload = embedded.scene.payload as {
            elements?: any;
            appState?: any;
          };
          let encryptionKey: string | null = null;
          if (embedded.scene.payloadKind === "encrypted") {
            if (!isEncryptedScenePayloadV1(embedded.scene.payload)) {
              throw new Error(t("cloud.scenes.invalidPayload"));
            }
            encryptionKey =
              cloudEmbedAccess?.key ??
              (embedded.scene.id
                ? backend.encryption.getKey(embedded.scene.id)?.key ?? null
                : null);
            if (!encryptionKey) {
              throw new Error(t("cloud.e2e.missingKey"));
            }
            payload = (await backend.encryption.decryptScenePayload(
              embedded.scene.payload,
              encryptionKey,
            )) as {
              elements?: any;
              appState?: any;
            };
            if (embedded.scene.id) {
              backend.encryption.saveKey({
                sceneId: embedded.scene.id,
                key: encryptionKey,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              });
            }
          }
          const restoredElements = restoreElements(
            payload.elements ?? null,
            null,
            {
              repairBindings: true,
              deleteInvisibleElements: true,
            },
          );
          const assetResult = encryptionKey
            ? await loadEncryptedAssetRefsForElements({
                backend,
                assets: embedded.assets,
                elements: restoredElements,
                encryptionKey,
              })
            : await loadAssetRefsForElements({
                assets: embedded.assets,
                elements: restoredElements,
              });
          const files = assetResult.loadedFiles.reduce((acc, file) => {
            acc[file.id] = file;
            return acc;
          }, {} as BinaryFiles);
          scene = {
            elements: restoredElements,
            appState: {
              ...restoreAppState(payload.appState ?? null, null),
              isLoading: false,
              name: embedded.scene.title,
              viewModeEnabled: embedded.mode === "read",
              ...(embedded.embed.theme === "system"
                ? {}
                : { theme: embedded.embed.theme }),
            },
            files,
          };
          activeEmbeddedScene = {
            token: cloudEmbedToken,
            mode: embedded.mode,
            origin,
            id: embedded.scene.id ?? "",
            ownerId: embedded.scene.ownerId,
            title: embedded.scene.title,
            payloadKind: embedded.scene.payloadKind,
            version: embedded.scene.version,
            createdAt: embedded.scene.createdAt,
            updatedAt: embedded.scene.updatedAt,
            encryptionKey,
          };
          isCloudEmbedScene = true;
        } catch (error) {
          scene = {
            appState: restoreAppState(
              {
                errorMessage:
                  error instanceof Error
                    ? error.message
                    : t("cloud.embed.openFailed"),
              },
              null,
            ),
          };
        }
      } else if (cloudShareToken) {
        try {
          const shared = await backend.shares.loadScene(cloudShareToken);
          let payload = shared.scene.payload as {
            elements?: any;
            appState?: any;
          };
          let encryptionKey: string | null = null;
          if (shared.scene.payloadKind === "encrypted") {
            if (!isEncryptedScenePayloadV1(shared.scene.payload)) {
              throw new Error(t("cloud.scenes.invalidPayload"));
            }
            encryptionKey =
              cloudShareAccess?.key ??
              (shared.scene.id
                ? backend.encryption.getKey(shared.scene.id)?.key ?? null
                : null);
            if (!encryptionKey) {
              throw new Error(t("cloud.e2e.missingKey"));
            }
            payload = (await backend.encryption.decryptScenePayload(
              shared.scene.payload,
              encryptionKey,
            )) as {
              elements?: any;
              appState?: any;
            };
            if (shared.scene.id) {
              backend.encryption.saveKey({
                sceneId: shared.scene.id,
                key: encryptionKey,
                createdAt: Date.now(),
                updatedAt: Date.now(),
              });
            }
          }
          const restoredElements = restoreElements(
            payload.elements ?? null,
            null,
            {
              repairBindings: true,
              deleteInvisibleElements: true,
            },
          );
          const assetResult = encryptionKey
            ? await loadEncryptedAssetRefsForElements({
                backend,
                assets: shared.assets,
                elements: restoredElements,
                encryptionKey,
              })
            : await loadAssetRefsForElements({
                assets: shared.assets,
                elements: restoredElements,
              });
          const files = assetResult.loadedFiles.reduce((acc, file) => {
            acc[file.id] = file;
            return acc;
          }, {} as BinaryFiles);
          scene = {
            elements: restoredElements,
            appState: {
              ...restoreAppState(payload.appState ?? null, null),
              isLoading: false,
              name: shared.scene.title,
              viewModeEnabled: shared.mode === "read",
            },
            files,
          };
          activeSharedScene = {
            token: cloudShareToken,
            mode: shared.mode,
            id: shared.scene.id ?? "",
            ownerId: shared.scene.ownerId,
            title: shared.scene.title,
            payloadKind: shared.scene.payloadKind,
            version: shared.scene.version,
            createdAt: shared.scene.createdAt,
            updatedAt: shared.scene.updatedAt,
            encryptionKey,
          };
          isCloudShareScene = true;
        } catch (error) {
          scene = {
            appState: restoreAppState(
              {
                errorMessage:
                  error instanceof Error
                    ? error.message
                    : t("cloud.share.openFailed"),
              },
              null,
            ),
          };
        }
      } else if (jsonBackendMatch) {
        const imported = await importFromBackend(
          jsonBackendMatch[1],
          jsonBackendMatch[2],
        );

        scene = {
          elements: bumpElementVersions(
            restoreElements(imported.elements, null, {
              repairBindings: true,
              deleteInvisibleElements: true,
            }),
            localDataState?.elements,
          ),
          appState: restoreAppState(
            imported.appState,
            // local appState when importing from backend to ensure we restore
            // localStorage user settings which we do not persist on server.
            localDataState?.appState,
          ),
        };
        didReplaceLocalScene = true;
      }
      scene.scrollToContent = true;
      if (!roomLinkData && !cloudShareToken && !cloudEmbedToken) {
        window.history.replaceState({}, APP_NAME, window.location.origin);
      }
    } else {
      // https://github.com/excalidraw/excalidraw/issues/1919
      if (document.hidden) {
        return new Promise((resolve, reject) => {
          window.addEventListener(
            "focus",
            () => initializeScene(opts).then(resolve).catch(reject),
            {
              once: true,
            },
          );
        });
      }

      roomLinkData = null;
      window.history.replaceState({}, APP_NAME, window.location.origin);
    }
  } else if (externalUrlMatch) {
    window.history.replaceState({}, APP_NAME, window.location.origin);

    const url = externalUrlMatch[1];
    try {
      const request = await fetch(window.decodeURIComponent(url));
      const data = await loadFromBlob(await request.blob(), null, null);
      if (
        !(scene.elements?.length ?? 0) ||
        (await openConfirmModal(shareableLinkConfirmDialog))
      ) {
        return { scene: data, isExternalScene, didReplaceLocalScene: true };
      }
    } catch (error: any) {
      return {
        scene: {
          appState: {
            errorMessage: t("alerts.invalidSceneUrl"),
          },
        },
        isExternalScene,
      };
    }
  }

  if (roomLinkData && opts.collabAPI) {
    const { excalidrawAPI } = opts;

    const scene = await opts.collabAPI.startCollaboration(roomLinkData);
    let activeCloudScene: ActiveCloudScene | null = null;
    try {
      const backend = getCloudBackend();
      if (backend.capabilities.collabRoomBinding) {
        const room = await backend.collabRooms.getByRoomId(roomLinkData.roomId);
        if (room) {
          const record = await backend.scenes.load(room.sceneId);
          if (record.id) {
            activeCloudScene = {
              id: record.id,
              ownerId: record.ownerId,
              title: record.title,
              payloadKind: record.payloadKind,
              version: record.version,
              createdAt: record.createdAt,
              updatedAt: record.updatedAt,
            };
          }
        }
      }
    } catch (error) {
      // Only the room owner can resolve this metadata. Anonymous collaborators
      // should still be able to join the realtime room.
      console.warn(error);
    }

    return {
      // when collaborating, the state may have already been updated at this
      // point (we may have received updates from other clients), so reconcile
      // elements and appState with existing state
      scene: {
        ...scene,
        appState: {
          ...restoreAppState(
            {
              ...scene?.appState,
              theme: localDataState?.appState?.theme || scene?.appState?.theme,
            },
            excalidrawAPI.getAppState(),
          ),
          // necessary if we're invoking from a hashchange handler which doesn't
          // go through App.initializeScene() that resets this flag
          isLoading: false,
        },
        elements: reconcileElements(
          scene?.elements || [],
          excalidrawAPI.getSceneElementsIncludingDeleted() as RemoteExcalidrawElement[],
          excalidrawAPI.getAppState(),
        ),
      },
      isExternalScene: true,
      id: roomLinkData.roomId,
      key: roomLinkData.roomKey,
      activeCloudScene,
    };
  } else if (scene) {
    if (isCloudShareScene && activeSharedScene) {
      return {
        scene,
        isExternalScene: true,
        id: activeSharedScene.token,
        key: "",
        activeSharedScene,
        isCloudShareScene,
      };
    }

    if (isCloudEmbedScene && activeEmbeddedScene) {
      return {
        scene,
        isExternalScene: true,
        id: activeEmbeddedScene.token,
        key: "",
        activeEmbeddedScene,
        isCloudEmbedScene,
      };
    }

    return isExternalScene && jsonBackendMatch
      ? {
          scene,
          isExternalScene,
          id: jsonBackendMatch[1],
          key: jsonBackendMatch[2],
          didReplaceLocalScene,
        }
      : {
          scene,
          isExternalScene: false,
          activeSharedScene: null,
          activeEmbeddedScene: null,
        };
  }
  return {
    scene: null,
    isExternalScene: false,
    activeSharedScene: null,
    activeEmbeddedScene: null,
  };
};

const ExcalidrawWrapper = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const [localDocumentId, setLocalDocumentId] = useState(
    getOrCreateLocalDocumentId,
  );

  const [errorMessage, setErrorMessage] = useState("");
  const [isCloudAccountOpen, setIsCloudAccountOpen] = useState(false);
  const [isSingleFileDialogOpen, setIsSingleFileDialogOpen] = useState(false);
  const [isCloudSceneListOpen, setIsCloudSceneListOpen] = useState(false);
  const [isCloudAITaskListOpen, setIsCloudAITaskListOpen] = useState(false);
  const [isCloudEmbedListOpen, setIsCloudEmbedListOpen] = useState(false);
  const [embedListScene, setEmbedListScene] = useState<SceneSummary | null>(
    null,
  );
  const [embedListBackTarget, setEmbedListBackTarget] = useState<
    "account" | "scenes"
  >("account");
  const cloudAuth = useCloudAuth();
  const [activeCloudScene, setActiveCloudScene] =
    useState<ActiveCloudScene | null>(null);
  const activeCloudSceneRef = useRef<ActiveCloudScene | null>(null);
  const [cloudSceneRemoteUpdate, setCloudSceneRemoteUpdate] =
    useState<CloudSceneRemoteUpdateState>({ status: "idle" });
  const cloudSceneRemoteUpdateToastRef = useRef<string | null>(null);
  const [activeSharedScene, setActiveSharedScene] =
    useState<ActiveSharedScene | null>(null);
  const activeSharedSceneRef = useRef<ActiveSharedScene | null>(null);
  const [activeEmbeddedScene, setActiveEmbeddedScene] =
    useState<ActiveEmbeddedScene | null>(null);
  const activeEmbeddedSceneRef = useRef<ActiveEmbeddedScene | null>(null);
  const [activeVault, setActiveVault] = useState<ActiveVault | null>(null);
  const isVaultMode = isVaultExternalFeatureDisabled(activeVault);
  const [isVaultShareDialogOpen, setIsVaultShareDialogOpen] = useState(false);
  const activeVaultRef = useRef<ActiveVault | null>(null);
  const lastVaultSerializedSnapshotRef = useRef<string | null>(null);
  const vaultAutosaveRef =
    useRef<VaultSnapshotAutosaveController<VaultAutosaveSnapshot> | null>(null);
  // P4c Vault v2 (CRDT), behind VITE_APP_VAULT_V2_ENABLED (default off)
  const vaultV2SessionRef = useRef<VaultV2Session | null>(null);
  const [vaultV2Session, setVaultV2Session] = useState<VaultV2Session | null>(
    null,
  );
  const [isVaultV2ShareDialogOpen, setIsVaultV2ShareDialogOpen] =
    useState(false);
  const vaultLocalStoreRef = useRef<Promise<VaultLocalStore> | null>(null);
  const vaultRealtimeAvailableRef = useRef(true);
  const vaultAttachmentStateRef = useRef<VaultAttachmentQueueState>({
    status: "idle",
    pending: 0,
    failed: 0,
    total: 0,
  });
  const [isVaultConflictDialogOpen, setIsVaultConflictDialogOpen] =
    useState(false);
  const [vaultConflictInfo, setVaultConflictInfo] =
    useState<VaultConflictInfo | null>(null);
  const vaultConflictPromptedRef = useRef<string | null>(null);
  const lastCloudLocalPayloadHashRef = useRef<string | null>(null);
  const lastCloudSavedPayloadHashRef = useRef<string | null>(null);
  const lastSharedSavedPayloadHashRef = useRef<string | null>(null);
  const lastEmbeddedSavedPayloadHashRef = useRef<string | null>(null);
  const cloudAutosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const cloudBindingSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const cloudSaveInFlightRef = useRef(false);
  const migrateAIVideoAssetsRef = useRef<() => Promise<void>>(async () => {});
  const [aiPromptTemplates, setAIPromptTemplates] = useState<PromptTemplate[]>(
    getAllPromptTemplates,
  );
  const [aiGenerationLogs, setAIGenerationLogs] =
    useState<AIGenerationLogEntry[]>(loadAIGenerationLogs);
  const [aiSkills, setAISkills] = useState<AISkill[]>(
    () => loadAIAgentConfig().skills,
  );
  const maskEditingControllerRef = useRef<AIMaskEditingControllerHandle>(null);
  const workbenchMaskReadyHandlerRef = useRef<
    ((payload: AIMaskReadyPayload) => void) | null
  >(null);
  const pendingWorkbenchMaskPayloadRef = useRef<{
    payload: AIMaskReadyPayload;
    createdAt: number;
  } | null>(null);
  const isCollabDisabled = isRunningInIframe();

  const { editorTheme, appTheme, setAppTheme } = useHandleAppTheme();

  const [langCode, setLangCode] = useAppLangCode();

  const editorInterface = useEditorInterface();

  // initial state
  // ---------------------------------------------------------------------------

  const initialStatePromiseRef = useRef<{
    promise: ResolvablePromise<ExcalidrawInitialDataState | null>;
  }>({ promise: null! });
  if (!initialStatePromiseRef.current.promise) {
    initialStatePromiseRef.current.promise =
      resolvablePromise<ExcalidrawInitialDataState | null>();
  }

  const debugCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    activeCloudSceneRef.current = activeCloudScene;
  }, [activeCloudScene]);

  useEffect(() => {
    activeSharedSceneRef.current = activeSharedScene;
  }, [activeSharedScene]);

  useEffect(() => {
    activeEmbeddedSceneRef.current = activeEmbeddedScene;
  }, [activeEmbeddedScene]);

  useEffect(() => {
    if (cloudAuth.isSignedIn) {
      return;
    }

    setActiveCloudScene(null);
    activeCloudSceneRef.current = null;
    setCloudSceneRemoteUpdate({ status: "idle" });
    cloudSceneRemoteUpdateToastRef.current = null;
    lastCloudLocalPayloadHashRef.current = null;
    lastCloudSavedPayloadHashRef.current = null;

    if (cloudAutosaveTimerRef.current) {
      clearTimeout(cloudAutosaveTimerRef.current);
      cloudAutosaveTimerRef.current = null;
    }

    if (cloudBindingSyncTimerRef.current) {
      clearTimeout(cloudBindingSyncTimerRef.current);
      cloudBindingSyncTimerRef.current = null;
    }
  }, [cloudAuth.isSignedIn]);

  useEffect(() => {
    return () => {
      if (cloudAutosaveTimerRef.current) {
        clearTimeout(cloudAutosaveTimerRef.current);
      }
      if (cloudBindingSyncTimerRef.current) {
        clearTimeout(cloudBindingSyncTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    trackEvent("load", "frame", getFrame());
    // Delayed so that the app has a time to load the latest SW
    setTimeout(() => {
      trackEvent("load", "version", getVersion());
    }, VERSION_TIMEOUT);
  }, []);

  useEffect(() => {
    const reloadAICommandSources = () => {
      setAIPromptTemplates(getAllPromptTemplates());
      setAIGenerationLogs(loadAIGenerationLogs());
      setAISkills(loadAIAgentConfig().skills);
    };

    window.addEventListener(
      AI_PROMPT_TEMPLATES_UPDATED_EVENT,
      reloadAICommandSources,
    );
    window.addEventListener(
      AI_GENERATION_LOGS_UPDATED_EVENT,
      reloadAICommandSources,
    );
    window.addEventListener(
      AI_AGENT_CONFIG_UPDATED_EVENT,
      reloadAICommandSources,
    );
    window.addEventListener("storage", reloadAICommandSources);

    return () => {
      window.removeEventListener(
        AI_PROMPT_TEMPLATES_UPDATED_EVENT,
        reloadAICommandSources,
      );
      window.removeEventListener(
        AI_GENERATION_LOGS_UPDATED_EVENT,
        reloadAICommandSources,
      );
      window.removeEventListener(
        AI_AGENT_CONFIG_UPDATED_EVENT,
        reloadAICommandSources,
      );
      window.removeEventListener("storage", reloadAICommandSources);
    };
  }, []);

  const [, setShareDialogState] = useAtom(shareDialogStateAtom);
  const [collabAPI] = useAtom(collabAPIAtom);
  const [collabRoomRefreshKey, setCollabRoomRefreshKey] = useState(0);
  const commitNewAIWorkbenchLocalDocumentId = useCallback(() => {
    setLocalDocumentId(rotateLocalDocumentId());
  }, []);
  const handleLocalSceneReplace = useCallback(() => {
    if (
      !shouldRotateLocalDocumentId({
        hasActiveEmbeddedScene: !!activeEmbeddedSceneRef.current,
        hasActiveSharedScene: !!activeSharedSceneRef.current,
        hasActiveCloudScene: !!activeCloudSceneRef.current,
        isCollaborating: !!collabAPI?.isCollaborating(),
      })
    ) {
      return;
    }

    commitNewAIWorkbenchLocalDocumentId();
  }, [collabAPI, commitNewAIWorkbenchLocalDocumentId]);
  const activeCollaborationRoomId = (() => {
    if (!collabAPI?.isCollaborating()) {
      return null;
    }

    const activeRoomLink = collabAPI.getActiveRoomLink();
    return activeRoomLink
      ? getCollaborationLinkData(activeRoomLink)?.roomId ?? null
      : null;
  })();
  const aiWorkbenchPersistenceScopeIdRef = useRef<string | null>(null);
  const aiWorkbenchPersistenceScopeId = useMemo(
    () =>
      resolveAIWorkbenchPersistenceScope({
        activeEmbeddedScene,
        activeSharedScene,
        activeCloudScene,
        activeCollaboration: collabAPI?.isCollaborating()
          ? { roomId: activeCollaborationRoomId }
          : null,
        localDocumentId,
      }),
    [
      activeCollaborationRoomId,
      activeCloudScene,
      activeEmbeddedScene,
      activeSharedScene,
      collabAPI,
      localDocumentId,
    ],
  );
  aiWorkbenchPersistenceScopeIdRef.current = aiWorkbenchPersistenceScopeId;
  const [isCollaborating] = useAtomWithInitialValue(isCollaboratingAtom, () => {
    return isCollaborationLink(window.location.href);
  });
  const collabError = useAtomValue(collabErrorIndicatorAtom);

  const notifyCollabRoomChanged = useCallback(() => {
    setCollabRoomRefreshKey((key) => key + 1);
  }, []);

  const stopCurrentCollabRoomIfRevoked = useCallback(
    (room: CollabRoomRecord) => {
      const activeRoomLink = collabAPI?.getActiveRoomLink();
      if (
        collabAPI?.isCollaborating() &&
        activeRoomLink?.includes(`#room=${room.roomId},`)
      ) {
        collabAPI.stopCollaboration(false);
      }
    },
    [collabAPI],
  );

  const hydrateActiveCloudSceneFromLocalBinding = useCallback(() => {
    if (
      !excalidrawAPI ||
      !cloudAuth.isSignedIn ||
      !cloudAuth.user ||
      activeCloudSceneRef.current ||
      activeSharedSceneRef.current ||
      activeEmbeddedSceneRef.current ||
      collabAPI?.isCollaborating()
    ) {
      return false;
    }

    try {
      const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
      const appState = excalidrawAPI.getAppState();
      const files = excalidrawAPI.getFiles();
      const serializedPayload = serializeAsJSON(
        elements,
        appState,
        files,
        "database",
      );
      const payloadHash = getCloudPayloadHash(serializedPayload);
      const localFingerprint = getCloudSceneFingerprint(elements);
      const storedBinding = loadCloudSceneBinding(cloudAuth.user.id, {
        localPayloadHash: payloadHash,
        localFingerprint,
      });

      if (!storedBinding) {
        return false;
      }

      const nextActiveScene: ActiveCloudScene = {
        id: storedBinding.id,
        ownerId: storedBinding.ownerId,
        title: storedBinding.title,
        payloadKind: storedBinding.payloadKind ?? "plain",
        version: storedBinding.version,
        createdAt: storedBinding.createdAt,
        updatedAt: storedBinding.updatedAt,
      };
      setActiveCloudScene(nextActiveScene);
      activeCloudSceneRef.current = nextActiveScene;
      lastCloudLocalPayloadHashRef.current = storedBinding.localPayloadHash;
      lastCloudSavedPayloadHashRef.current = storedBinding.savedPayloadHash;
      setCloudSceneRemoteUpdate({
        status: "up-to-date",
        checkedAt: Date.now(),
      });
      cloudSceneRemoteUpdateToastRef.current = null;
      return true;
    } catch (error) {
      console.warn(error);
      return false;
    }
  }, [cloudAuth.isSignedIn, cloudAuth.user, collabAPI, excalidrawAPI]);

  useEffect(() => {
    if (hydrateActiveCloudSceneFromLocalBinding()) {
      return;
    }

    let cancelled = false;
    let retries = 10;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const retry = () => {
      if (cancelled || hydrateActiveCloudSceneFromLocalBinding()) {
        return;
      }
      retries -= 1;
      if (retries > 0) {
        timer = setTimeout(retry, 250);
      }
    };

    timer = setTimeout(retry, 100);

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [hydrateActiveCloudSceneFromLocalBinding]);

  useHandleLibrary({
    excalidrawAPI,
    adapter: LibraryIndexedDBAdapter,
    // TODO maybe remove this in several months (shipped: 24-03-11)
    migrationAdapter: LibraryLocalStorageMigrationAdapter,
  });

  const [, forceRefresh] = useState(false);
  const refreshApp = useCallback(() => {
    forceRefresh((prev) => !prev);
  }, []);

  const setVaultV2SessionState = useCallback((next: VaultV2Session | null) => {
    if (vaultV2SessionRef.current !== next) {
      vaultV2SessionRef.current?.dispose();
    }
    vaultV2SessionRef.current = next;
    setVaultV2Session(next);
    setIsVaultV2ShareDialogOpen(false);
  }, []);

  useEffect(
    () => () => {
      vaultV2SessionRef.current?.dispose();
      vaultV2SessionRef.current = null;
    },
    [],
  );

  const vaultV2UiState = useVaultV2UiState(vaultV2Session);
  // stable per session, so the share dialog keeps its list across renders
  const vaultV2ShareTarget = useMemo(
    () =>
      vaultV2Session?.share
        ? {
            vaultId: vaultV2Session.vaultId,
            role: vaultV2Session.role,
            share: vaultV2Session.share,
          }
        : null,
    [vaultV2Session],
  );
  const canManageVaultV2 =
    !!vaultV2ShareTarget &&
    vaultV2ShareTarget.role === "editor" &&
    vaultV2UiState?.status !== "blocked";

  // Voice messages (ADR 0034). The speaker snapshot reads refs so the
  // callback stays stable and doesn't re-render the editor.
  const voiceAuthorRef = useRef<{
    name: string | null;
    avatar: AudioAvatar | null;
  }>({ name: null, avatar: null });
  voiceAuthorRef.current = {
    name:
      cloudAuth.user?.displayName?.trim() ||
      collabAPI?.getUsername()?.trim() ||
      importUsernameFromLocalStorage()?.trim() ||
      null,
    // ADR 0034 §6: the account avatar; anonymous authors get a default one
    // derived from the name when the bubble is drawn
    avatar: cloudAuth.user?.avatar ?? null,
  };
  const getVoiceAuthor = useCallback(() => {
    const { name, avatar } = voiceAuthorRef.current;
    // never put the e-mail on a bubble: it's synced to everyone in the room
    return name || avatar ? { name: (name ?? "").slice(0, 100), avatar } : null;
  }, []);
  const voiceOptions = useMemo(
    () => ({
      // inside an iframe the host's `allow` (0023) doesn't grant the mic
      enabled: !isCollabDisabled,
      // Vault: on-device recognition only (ADR 0034 §7)
      transcription: isVaultMode ? ("local-only" as const) : ("auto" as const),
      // Vault v2 has neither an `audio` schema entry nor presence yet, so
      // recordings would stay local and old peers can't be detected (R3)
      disabledReason: vaultV2Session ? t("voice.vaultV2Unavailable") : null,
      getAuthor: getVoiceAuthor,
    }),
    [isCollabDisabled, isVaultMode, vaultV2Session, getVoiceAuthor],
  );

  // W6: one-off merge notices (2a-2 concurrent edits, 2d-1 tombstone-wins)
  useEffect(() => {
    if (!vaultV2Session || !excalidrawAPI) {
      return;
    }
    return vaultV2Session.ui.onNotice((notice) => {
      excalidrawAPI.setToast({
        message:
          notice.kind === "conflict"
            ? t("vault.v2.conflictToast")
            : t("vault.v2.deletedEditsToast"),
        duration: 6000,
        closable: true,
      });
    });
  }, [excalidrawAPI, vaultV2Session]);

  const showVaultV2Conflicts = useCallback(
    (elementIds: readonly string[]) => {
      if (!excalidrawAPI) {
        return;
      }
      const ids = new Set(elementIds);
      const elements = excalidrawAPI
        .getSceneElements()
        .filter((element) => ids.has(element.id));
      if (elements.length === 0) {
        return;
      }
      // selection is local appState (never converged), so this stays on this device
      excalidrawAPI.updateScene({
        appState: {
          selectedElementIds: Object.fromEntries(
            elements.map((element) => [element.id, true as const]),
          ),
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      excalidrawAPI.scrollToContent(elements, { fitToContent: true });
    },
    [excalidrawAPI],
  );

  const setActiveVaultSession = useCallback(
    (next: ActiveVault | null, serializedSnapshot: string | null = null) => {
      vaultRealtimeAvailableRef.current = true;
      vaultAutosaveRef.current?.dispose();
      vaultAutosaveRef.current = null;
      void vaultLocalStoreRef.current?.then((store) => store.close());
      vaultLocalStoreRef.current = null;
      lastVaultSerializedSnapshotRef.current = serializedSnapshot;
      activeVaultRef.current = next;
      setActiveVault(next);
      setIsVaultShareDialogOpen(false);
      if (!next || next.session.role !== "editor") {
        return;
      }
      const secrets = readVaultSessionSecrets(next.session);
      const localStorePromise = next.localStore
        ? Promise.resolve(next.localStore)
        : VaultLocalStore.open();
      vaultLocalStoreRef.current = localStorePromise;
      vaultAutosaveRef.current = createVaultSnapshotAutosaveController({
        persistence: next.persistence,
        vaultId: next.session.vaultId,
        invitationCapability: secrets.invitationCapability,
        rootKey: secrets.rootKey,
        role: next.session.role,
        initialGeneration: next.generation,
        roomId: next.session.admission.activeRoomId,
        localStore: localStorePromise,
        isOnline: () => navigator.onLine !== false,
        reconcileConflict: ({ pendingSnapshot, latestSnapshot }) => {
          if (!excalidrawAPI) {
            throw new VaultError(
              "VAULT_INTERNAL",
              "Vault editor is unavailable during snapshot reconciliation.",
            );
          }
          return reconcileVaultAutosaveSnapshots(
            pendingSnapshot,
            latestSnapshot,
            excalidrawAPI.getAppState(),
          );
        },
        onStateChange: (state) => {
          const current = activeVaultRef.current;
          if (!current || current.session !== next.session) {
            return;
          }
          const updated = Object.freeze({
            ...current,
            generation: state.generation,
            syncStatus: vaultRealtimeAvailableRef.current
              ? state.status
              : "unsynced",
            autosaveErrorCode: state.errorCode,
            autosaveUnsyncedReason: state.unsyncedReason,
            autosaveLocalPersistence: state.localPersistence,
            autosaveBeforeUnloadState:
              vaultAutosaveRef.current?.getBeforeUnloadState() ?? "none",
          });
          activeVaultRef.current = updated;
          setActiveVault(updated);
        },
      });
    },
    [excalidrawAPI],
  );

  const setVaultRealtimeStatus = useCallback(
    (
      session: VaultClientSession,
      syncStatus: VaultSyncStatus,
      lost?: { reason: VaultRealtimeLostReason; code: VaultErrorCode | null },
    ) => {
      const current = activeVaultRef.current;
      if (!current || current.session !== session) {
        return;
      }
      const updated = applyVaultRealtimeStatus(current, syncStatus, lost);
      vaultRealtimeAvailableRef.current = updated.realtimeAvailable ?? true;
      activeVaultRef.current = updated;
      setActiveVault(updated);
    },
    [],
  );

  const setVaultAttachmentState = useCallback(
    (session: VaultClientSession, state: VaultAttachmentQueueState) => {
      vaultAttachmentStateRef.current = state;
      const current = activeVaultRef.current;
      if (!current || current.session !== session) {
        return;
      }
      const updated = Object.freeze({
        ...current,
        attachmentPending: state.pending,
        attachmentFailed: state.failed,
      });
      activeVaultRef.current = updated;
      setActiveVault(updated);
    },
    [],
  );

  const recoverVaultRoomConnection = useCallback(
    async (session: VaultClientSession) => {
      const current = activeVaultRef.current;
      if (!current || current.session !== session) {
        throw new VaultError(
          "VAULT_PERSISTENCE_UNAVAILABLE",
          "Vault room recovery session is no longer active.",
        );
      }
      await recoverVaultAfterRoomReconnect(vaultAutosaveRef.current, () =>
        window.location.reload(),
      );
    },
    [],
  );

  // Shared by the initial open and hash-change reopen paths so both record
  // the same non-secret realtime-loss diagnostics.
  const createVaultRealtimeCallbacks = useCallback(
    (session: VaultClientSession) => {
      let reconnecting = false;
      return {
        onError: (error: VaultError) =>
          setVaultRealtimeStatus(session, "unsynced", {
            reason: reconnecting ? "reconnect-failed" : "message-error",
            code: error.code,
          }),
        onDisconnect: (error: VaultError) =>
          setVaultRealtimeStatus(session, "unsynced", {
            reason: "disconnected",
            code: error.code,
          }),
        onReconnect: async () => {
          reconnecting = true;
          await recoverVaultRoomConnection(session);
        },
        onTeardown: (error: VaultError) => {
          vaultAutosaveRef.current?.dispose();
          vaultAutosaveRef.current = null;
          setVaultRealtimeStatus(
            session,
            getVaultRealtimeTeardownStatus(error.code),
            { reason: "teardown", code: error.code },
          );
        },
      };
    },
    [recoverVaultRoomConnection, setVaultRealtimeStatus],
  );

  const exportVaultLocalCopy = useCallback(async () => {
    const vault = activeVaultRef.current;
    if (!vault) {
      throw new VaultError("VAULT_INTERNAL", "No active Vault to export.");
    }
    const secrets = readVaultSessionSecrets(vault.session);
    const store = vault.localStore ?? (await vaultLocalStoreRef.current);
    if (!store) {
      throw new VaultError(
        "VAULT_LOCAL_STORAGE_UNAVAILABLE",
        "Vault local store is unavailable.",
      );
    }
    const local = await store.getSnapshot<VaultAutosaveSnapshot>({
      vaultId: vault.session.vaultId,
      roomId: vault.session.admission.activeRoomId,
      rootKey: secrets.rootKey,
    });
    const payload = {
      vaultId: vault.session.vaultId,
      generation: local?.generation ?? vault.generation,
      updatedAt: local?.updatedAt ?? null,
      exportedAt: new Date().toISOString(),
      snapshot: local?.snapshot ?? null,
    };
    const blob = new Blob([JSON.stringify(payload)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `vault-local-recovery-${vault.session.vaultId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, []);

  const vaultRecoveryState = activeVault
    ? deriveActiveVaultRecoveryState(activeVault, navigator.onLine !== false)
    : null;

  useEffect(() => {
    if (vaultRecoveryState !== "conflict") {
      vaultConflictPromptedRef.current = null;
      return;
    }
    const vault = activeVaultRef.current;
    if (!vault) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const store = vault.localStore ?? (await vaultLocalStoreRef.current);
        if (!store) {
          return;
        }
        const records = await store.listOutbox({
          vaultId: vault.session.vaultId,
          roomId: vault.session.admission.activeRoomId,
        });
        const conflicted = records.find(
          (record) => record.status === "conflict",
        );
        if (cancelled || !conflicted) {
          return;
        }
        setVaultConflictInfo({
          localUpdateId: conflicted.updateId,
          localGeneration:
            conflicted.envelope.purpose === "snapshot"
              ? conflicted.envelope.generation
              : vault.generation,
          remoteGeneration: conflicted.remoteGeneration,
          conflictReason: conflicted.conflictReason,
        });
        if (vaultConflictPromptedRef.current !== conflicted.updateId) {
          vaultConflictPromptedRef.current = conflicted.updateId;
          setIsVaultConflictDialogOpen(true);
        }
      } catch {
        // Keep the conflict state; the review dialog is optional.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [vaultRecoveryState]);

  useEffect(
    () => () => {
      vaultAutosaveRef.current?.dispose();
      vaultAutosaveRef.current = null;
      void vaultLocalStoreRef.current?.then((store) => store.close());
      vaultLocalStoreRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (isDevEnv()) {
      const debugState = loadSavedDebugState();

      if (debugState.enabled && !window.visualDebug) {
        window.visualDebug = {
          data: [],
        };
      } else {
        delete window.visualDebug;
      }
      refreshApp();
    }
  }, [excalidrawAPI, refreshApp]);

  // ---------------------------------------------------------------------------
  // Hoisted loadImages
  // ---------------------------------------------------------------------------
  const loadImages = useCallback(
    (data: ResolutionType<typeof initializeScene>, isInitialLoad = false) => {
      if (!data.scene || !excalidrawAPI) {
        return;
      }

      if (data.activeVault) {
        if (data.scene.files) {
          excalidrawAPI.addFiles(Object.values(data.scene.files));
        }
        return;
      }

      if (collabAPI?.isCollaborating()) {
        if (data.scene.elements) {
          collabAPI
            .fetchImageFilesFromFirebase({
              elements: data.scene.elements,
              forceFetchFiles: true,
            })
            .then(({ loadedFiles, erroredFiles }) => {
              excalidrawAPI.addFiles(loadedFiles);
              updateStaleImageStatuses({
                excalidrawAPI,
                erroredFiles,
                elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
              });
            });
        }
      } else {
        // also the set clearObsoleteFiles keeps; must include audio
        const fileIds = getSceneFileIds(data.scene.elements ?? []);

        if (
          data.isExternalScene &&
          !data.isCloudShareScene &&
          !data.isCloudEmbedScene
        ) {
          if (fileIds.length) {
            // Direct Firebase call (not through FileManager), so track manually
            FileStatusStore.updateStatuses(
              fileIds.map((id) => [id, "loading"]),
            );
          }
          loadFilesFromFirebase(
            `${FIREBASE_STORAGE_PREFIXES.shareLinkFiles}/${data.id}`,
            data.key,
            fileIds,
          ).then(({ loadedFiles, erroredFiles }) => {
            excalidrawAPI.addFiles(loadedFiles);
            updateStaleImageStatuses({
              excalidrawAPI,
              erroredFiles,
              elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
            });
            FileStatusStore.updateStatuses([
              ...loadedFiles.map((f) => [f.id, "loaded"] as [FileId, "loaded"]),
              ...[...erroredFiles.keys()].map(
                (id) => [id, "error"] as [FileId, "error"],
              ),
            ]);
          });
        } else if (isInitialLoad) {
          if (fileIds.length) {
            LocalData.fileStorage
              .getFiles(fileIds)
              .then(async ({ loadedFiles, erroredFiles }) => {
                if (loadedFiles.length) {
                  excalidrawAPI.addFiles(loadedFiles);
                }
                updateStaleImageStatuses({
                  excalidrawAPI,
                  erroredFiles,
                  elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
                });
              });
          }
          // on fresh load, clear unused files from IDB (from previous
          // session)
          LocalData.fileStorage.clearObsoleteFiles({
            currentFileIds: fileIds,
          });
        }
      }
    },
    [collabAPI, excalidrawAPI],
  );

  const openCollaborationInputTarget = useCallback(
    (retries = 20) => {
      const inputTargetId = getCollaborationLinkData(
        window.location.href,
      )?.inputTargetId;

      if (!inputTargetId || !excalidrawAPI) {
        return;
      }

      const attemptOpenInputTarget = (remainingRetries: number) => {
        const didOpen = excalidrawAPI.startTextEditingForElement(inputTargetId);

        if (!didOpen && remainingRetries > 0) {
          window.setTimeout(
            () => attemptOpenInputTarget(remainingRetries - 1),
            100,
          );
        }
      };

      window.setTimeout(() => attemptOpenInputTarget(retries), 100);
    },
    [excalidrawAPI],
  );

  useEffect(() => {
    if (!excalidrawAPI || (!isCollabDisabled && !collabAPI)) {
      return;
    }

    initializeScene({ collabAPI, excalidrawAPI }).then(async (data) => {
      setActiveVaultSession(
        data.activeVault ?? null,
        data.activeVault && data.scene
          ? createVaultAutosaveSnapshot(
              data.scene.elements ?? [],
              data.scene.appState ?? {},
              data.scene.files ?? {},
            ).serializedSnapshot
          : null,
      );
      setActiveSharedScene(data.activeSharedScene ?? null);
      activeSharedSceneRef.current = data.activeSharedScene ?? null;
      setActiveEmbeddedScene(data.activeEmbeddedScene ?? null);
      activeEmbeddedSceneRef.current = data.activeEmbeddedScene ?? null;
      if (data.activeCloudScene) {
        setActiveCloudScene(data.activeCloudScene);
        activeCloudSceneRef.current = data.activeCloudScene;
      }
      if (data.activeSharedScene) {
        setActiveCloudScene(null);
        activeCloudSceneRef.current = null;
        if (data.scene?.elements) {
          lastSharedSavedPayloadHashRef.current = getCloudPayloadHash(
            serializeAsJSON(
              data.scene.elements,
              data.scene.appState ?? {},
              data.scene.files ?? {},
              "database",
            ),
          );
        }
      }
      if (data.activeEmbeddedScene) {
        setActiveCloudScene(null);
        activeCloudSceneRef.current = null;
        if (data.scene?.elements) {
          lastEmbeddedSavedPayloadHashRef.current = getCloudPayloadHash(
            serializeAsJSON(
              data.scene.elements,
              data.scene.appState ?? {},
              data.scene.files ?? {},
              "database",
            ),
          );
        }
      }
      if (data.didReplaceLocalScene) {
        commitNewAIWorkbenchLocalDocumentId();
      }
      loadImages(data, /* isInitialLoad */ true);
      initialStatePromiseRef.current.promise.resolve(data.scene);
      if (data.vaultV2Session) {
        setVaultV2SessionState(data.vaultV2Session);
        // start() loads the snapshot over the network, so the doc reaches
        // the editor after the (empty) initial data has been applied
        data.vaultV2Session.attach(excalidrawAPI);
      }
      if (data.activeVault && collabAPI) {
        const connected = await collabAPI.startVaultCollaboration(
          data.activeVault.session,
          {
            assetService: data.activeVault.assets,
            attachmentStore: data.activeVault.localStore,
            initialElements: data.scene?.elements ?? undefined,
            onAttachmentStateChange: (state) =>
              setVaultAttachmentState(data.activeVault!.session, state),
            ...createVaultRealtimeCallbacks(data.activeVault.session),
          },
        );
        if (!connected) {
          setVaultRealtimeStatus(data.activeVault.session, "unsynced", {
            reason: "join-failed",
            code: null,
          });
        }
      }
      if (data.isExternalScene && isCollaborationLink(window.location.href)) {
        openCollaborationInputTarget();
      }
    });

    const onHashChange = async (event: HashChangeEvent) => {
      event.preventDefault();
      const libraryUrlTokens = parseLibraryTokensFromUrl();
      if (!libraryUrlTokens) {
        if (
          collabAPI?.isCollaborating() &&
          !isCollaborationLink(window.location.href)
        ) {
          collabAPI.stopCollaboration(false);
        }
        // a v2 session never survives a route change
        setVaultV2SessionState(null);
        excalidrawAPI.updateScene({ appState: { isLoading: true } });

        initializeScene({ collabAPI, excalidrawAPI }).then(async (data) => {
          setActiveVaultSession(
            data.activeVault ?? null,
            data.activeVault && data.scene
              ? createVaultAutosaveSnapshot(
                  data.scene.elements ?? [],
                  data.scene.appState ?? {},
                  data.scene.files ?? {},
                ).serializedSnapshot
              : null,
          );
          setActiveSharedScene(data.activeSharedScene ?? null);
          activeSharedSceneRef.current = data.activeSharedScene ?? null;
          setActiveEmbeddedScene(data.activeEmbeddedScene ?? null);
          activeEmbeddedSceneRef.current = data.activeEmbeddedScene ?? null;
          if (data.activeCloudScene) {
            setActiveCloudScene(data.activeCloudScene);
            activeCloudSceneRef.current = data.activeCloudScene;
          }
          if (data.activeSharedScene) {
            setActiveCloudScene(null);
            activeCloudSceneRef.current = null;
            if (data.scene?.elements) {
              lastSharedSavedPayloadHashRef.current = getCloudPayloadHash(
                serializeAsJSON(
                  data.scene.elements,
                  data.scene.appState ?? {},
                  data.scene.files ?? {},
                  "database",
                ),
              );
            }
          }
          if (data.activeEmbeddedScene) {
            setActiveCloudScene(null);
            activeCloudSceneRef.current = null;
            if (data.scene?.elements) {
              lastEmbeddedSavedPayloadHashRef.current = getCloudPayloadHash(
                serializeAsJSON(
                  data.scene.elements,
                  data.scene.appState ?? {},
                  data.scene.files ?? {},
                  "database",
                ),
              );
            }
          }
          if (data.didReplaceLocalScene) {
            commitNewAIWorkbenchLocalDocumentId();
          }
          loadImages(data);
          if (data.scene) {
            excalidrawAPI.updateScene({
              elements: restoreElements(data.scene.elements, null, {
                repairBindings: true,
              }),
              appState: restoreAppState(data.scene.appState, null),
              captureUpdate: CaptureUpdateAction.IMMEDIATELY,
            });
            if (data.scene.files) {
              excalidrawAPI.addFiles(Object.values(data.scene.files));
            }
            if (
              data.isExternalScene &&
              isCollaborationLink(window.location.href)
            ) {
              openCollaborationInputTarget();
            }
          }
          if (data.vaultV2Session) {
            setVaultV2SessionState(data.vaultV2Session);
            data.vaultV2Session.attach(excalidrawAPI);
          }
          if (data.activeVault && collabAPI) {
            const connected = await collabAPI.startVaultCollaboration(
              data.activeVault.session,
              {
                assetService: data.activeVault.assets,
                attachmentStore: data.activeVault.localStore,
                initialElements: data.scene?.elements ?? undefined,
                onAttachmentStateChange: (state) =>
                  setVaultAttachmentState(data.activeVault!.session, state),
                ...createVaultRealtimeCallbacks(data.activeVault.session),
              },
            );
            if (!connected) {
              setVaultRealtimeStatus(data.activeVault.session, "unsynced", {
                reason: "join-failed",
                code: null,
              });
            }
          }
        });
      }
    };

    const syncData = debounce(() => {
      if (isTestEnv() || isCurrentVaultRoute()) {
        return;
      }
      if (
        !document.hidden &&
        ((collabAPI && !collabAPI.isCollaborating()) || isCollabDisabled)
      ) {
        // don't sync if local state is newer or identical to browser state
        if (isBrowserStorageStateNewer(STORAGE_KEYS.VERSION_DATA_STATE)) {
          const localDataState = importFromLocalStorage();
          const username = importUsernameFromLocalStorage();
          setLangCode(getPreferredLanguage());
          excalidrawAPI.updateScene({
            ...localDataState,
            captureUpdate: CaptureUpdateAction.NEVER,
          });
          LibraryIndexedDBAdapter.load().then((data) => {
            if (data) {
              excalidrawAPI.updateLibrary({
                libraryItems: data.libraryItems,
              });
            }
          });
          collabAPI?.setUsername(username || "");
        }

        if (isBrowserStorageStateNewer(STORAGE_KEYS.VERSION_FILES)) {
          const elements = excalidrawAPI.getSceneElementsIncludingDeleted();
          const currFiles = excalidrawAPI.getFiles();
          const fileIds =
            elements?.reduce((acc, element) => {
              if (
                isInitializedFileBackedElement(element) &&
                // only load and update files that aren't already loaded
                !currFiles[element.fileId]
              ) {
                return acc.concat(element.fileId);
              }
              return acc;
            }, [] as FileId[]) || [];
          if (fileIds.length) {
            LocalData.fileStorage
              .getFiles(fileIds)
              .then(({ loadedFiles, erroredFiles }) => {
                if (loadedFiles.length) {
                  excalidrawAPI.addFiles(loadedFiles);
                }
                updateStaleImageStatuses({
                  excalidrawAPI,
                  erroredFiles,
                  elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
                });
              });
          }
        }
      }
    }, SYNC_BROWSER_TABS_TIMEOUT);

    const onUnload = () => {
      if (isCurrentVaultRoute()) {
        void vaultAutosaveRef.current?.flush();
      } else {
        LocalData.flushSave();
      }
    };

    const onVaultOnline = () => {
      if (isCurrentVaultRoute()) {
        void vaultAutosaveRef.current?.retry();
      }
    };

    const visibilityChange = (event: FocusEvent | Event) => {
      if (
        isCurrentVaultRoute() &&
        (event.type === EVENT.BLUR || document.hidden)
      ) {
        void vaultAutosaveRef.current?.flush();
      } else if (event.type === EVENT.BLUR || document.hidden) {
        LocalData.flushSave();
      }
      if (
        event.type === EVENT.VISIBILITY_CHANGE ||
        event.type === EVENT.FOCUS
      ) {
        syncData();
      }
    };

    window.addEventListener(EVENT.HASHCHANGE, onHashChange, false);
    window.addEventListener(EVENT.UNLOAD, onUnload, false);
    window.addEventListener("online", onVaultOnline, false);
    window.addEventListener(EVENT.BLUR, visibilityChange, false);
    document.addEventListener(EVENT.VISIBILITY_CHANGE, visibilityChange, false);
    window.addEventListener(EVENT.FOCUS, visibilityChange, false);
    return () => {
      window.removeEventListener(EVENT.HASHCHANGE, onHashChange, false);
      window.removeEventListener(EVENT.UNLOAD, onUnload, false);
      window.removeEventListener("online", onVaultOnline, false);
      window.removeEventListener(EVENT.BLUR, visibilityChange, false);
      window.removeEventListener(EVENT.FOCUS, visibilityChange, false);
      document.removeEventListener(
        EVENT.VISIBILITY_CHANGE,
        visibilityChange,
        false,
      );
    };
  }, [
    isCollabDisabled,
    collabAPI,
    excalidrawAPI,
    setLangCode,
    loadImages,
    openCollaborationInputTarget,
    commitNewAIWorkbenchLocalDocumentId,
    createVaultRealtimeCallbacks,
    setVaultRealtimeStatus,
    setVaultAttachmentState,
    setActiveVaultSession,
    setVaultV2SessionState,
  ]);

  useEffect(() => {
    const unloadHandler = (event: BeforeUnloadEvent) => {
      if (isCurrentVaultRoute()) {
        const autosave = vaultAutosaveRef.current;
        let beforeUnloadState = autosave?.getBeforeUnloadState() ?? "none";
        // Attachments that are already enqueued are encrypted and persisted
        // locally, but not yet uploaded: report them as local-persisted/unsynced
        // rather than as a local-persistence-pending risk.
        if (
          beforeUnloadState === "none" &&
          vaultAttachmentStateRef.current.pending > 0
        ) {
          beforeUnloadState = "local-persisted-unsynced";
        }
        if (beforeUnloadState !== "none") {
          preventUnload(event);
          event.returnValue =
            beforeUnloadState === "local-persisted-unsynced"
              ? "Vault changes are saved locally but not uploaded."
              : "Vault changes are not yet saved locally.";
        }
        return;
      }
      LocalData.flushSave();

      if (
        excalidrawAPI &&
        LocalData.fileStorage.shouldPreventUnload(
          excalidrawAPI.getSceneElements(),
        )
      ) {
        if (import.meta.env.VITE_APP_DISABLE_PREVENT_UNLOAD !== "true") {
          preventUnload(event);
        } else {
          console.warn(
            "preventing unload disabled (VITE_APP_DISABLE_PREVENT_UNLOAD)",
          );
        }
      }
    };
    window.addEventListener(EVENT.BEFORE_UNLOAD, unloadHandler);
    return () => {
      window.removeEventListener(EVENT.BEFORE_UNLOAD, unloadHandler);
    };
  }, [excalidrawAPI]);

  const saveCurrentSceneToCloud = useCallback(
    async (
      opts: {
        silent?: boolean;
        checkRemoteVersion?: boolean;
      } = {},
    ): Promise<boolean> => {
      const { silent = false, checkRemoteVersion = true } = opts;

      if (
        !excalidrawAPI ||
        !cloudAuth.isAuthAvailable ||
        !cloudAuth.isSignedIn ||
        !cloudAuth.user
      ) {
        return false;
      }

      if (collabAPI?.isCollaborating()) {
        if (!silent) {
          excalidrawAPI.setToast({
            message: t("cloud.scenes.saveSkippedCollab"),
          });
        }
        return false;
      }

      if (document.hidden || navigator.onLine === false) {
        return false;
      }

      const backend = getCloudBackend();
      if (!backend.capabilities.sceneStorage) {
        return false;
      }

      try {
        await migrateAIVideoAssetsRef.current();
        let elements = sanitizeDeletedAIVideoMarkersForPersistence(
          excalidrawAPI.getSceneElementsIncludingDeleted(),
        );
        const hasBlockedVideoAsset = hasNonPortableAIVideo(elements, {
          allowLocalAssets: !activeCloudSceneRef.current?.id,
        });
        if (hasBlockedVideoAsset) {
          if (!silent) {
            excalidrawAPI.setToast({
              message: t("ai.workbench.videoAssetCloudSaveBlocked"),
            });
          }
          return false;
        }
        const appState = excalidrawAPI.getAppState();
        const files = excalidrawAPI.getFiles();
        let serializedPayload = serializeAsJSON(
          elements,
          appState,
          files,
          "database",
        );
        let payloadHash = getCloudPayloadHash(serializedPayload);
        let localFingerprint = getCloudSceneFingerprint(elements);
        const hadLocalVideoAssets = elements.some((element) => {
          const metadata = getAIVideoGenerationMetadataFromEmbeddable(element);
          return (
            metadata?.version === 2 && metadata.assetId.startsWith("local:")
          );
        });

        let activeScene = activeCloudSceneRef.current;
        if (!activeScene) {
          const storedBinding = loadCloudSceneBinding(cloudAuth.user.id, {
            localPayloadHash: payloadHash,
            localFingerprint,
          });
          if (storedBinding) {
            activeScene = {
              id: storedBinding.id,
              ownerId: storedBinding.ownerId,
              title: storedBinding.title,
              payloadKind: storedBinding.payloadKind ?? "plain",
              version: storedBinding.version,
              createdAt: storedBinding.createdAt,
              updatedAt: storedBinding.updatedAt,
            };
            setActiveCloudScene(activeScene);
            activeCloudSceneRef.current = activeScene;
            lastCloudLocalPayloadHashRef.current =
              storedBinding.localPayloadHash;
            lastCloudSavedPayloadHashRef.current =
              storedBinding.savedPayloadHash;
          }
        }

        if (activeScene && hadLocalVideoAssets) {
          await migrateAIVideoAssetsRef.current();
          elements = sanitizeDeletedAIVideoMarkersForPersistence(
            excalidrawAPI.getSceneElementsIncludingDeleted(),
          );
          const stillHasLocalVideo = hasNonPortableAIVideo(elements);
          if (stillHasLocalVideo) {
            if (!silent) {
              excalidrawAPI.setToast({
                message: t("ai.workbench.videoAssetCloudSaveBlocked"),
              });
            }
            return false;
          }
          serializedPayload = serializeAsJSON(
            elements,
            appState,
            files,
            "database",
          );
          payloadHash = getCloudPayloadHash(serializedPayload);
          localFingerprint = getCloudSceneFingerprint(elements);
        }
        if (silent && payloadHash === lastCloudSavedPayloadHashRef.current) {
          return false;
        }

        if (activeScene?.id && checkRemoteVersion) {
          const remoteScene = await backend.scenes.load(activeScene.id);
          if (remoteScene.version > activeScene.version) {
            setCloudSceneRemoteUpdate({
              status: "remote-newer",
              metadata: {
                id: remoteScene.id!,
                title: remoteScene.title,
                version: remoteScene.version,
                updatedAt: remoteScene.updatedAt,
                thumbnailMeta: remoteScene.thumbnailMeta,
              },
              checkedAt: Date.now(),
            });
            if (
              silent ||
              !(await confirmAction(t("cloud.scenes.remoteNewerConfirm"), {
                danger: false,
              }))
            ) {
              excalidrawAPI.setToast({
                message: t("cloud.scenes.remoteNewer"),
              });
              return false;
            }
          }
        }

        const now = Date.now();
        const title =
          activeScene?.title || excalidrawAPI.getName() || t("labels.untitled");
        const encryptionKey =
          activeScene?.payloadKind === "encrypted" && activeScene.id
            ? backend.encryption.getKey(activeScene.id)?.key
            : null;
        if (activeScene?.payloadKind === "encrypted" && !encryptionKey) {
          throw new Error(t("cloud.e2e.missingKey"));
        }
        const firstSaveSerializedPayload =
          !activeScene && hadLocalVideoAssets
            ? serializeAsJSON(
                omitAIVideoMarkersForInitialCloudSave(elements),
                appState,
                files,
                "database",
              )
            : serializedPayload;
        const scenePayload =
          activeScene?.payloadKind === "encrypted" && encryptionKey
            ? await backend.encryption.encryptScenePayload(
                JSON.parse(firstSaveSerializedPayload),
                encryptionKey,
              )
            : JSON.parse(firstSaveSerializedPayload);
        let result = await backend.scenes.save({
          id: activeScene?.id ?? null,
          ownerId: cloudAuth.user.id,
          title,
          payloadKind: activeScene?.payloadKind ?? "plain",
          payload: scenePayload,
          version: activeScene?.version ?? 0,
          createdAt: activeScene?.createdAt ?? now,
          updatedAt: now,
          deletedAt: null,
        });

        let didSyncAssets = true;
        try {
          if (activeScene?.payloadKind === "encrypted" && encryptionKey) {
            await uploadEncryptedSceneAssets({
              backend,
              sceneId: result.id,
              elements,
              files,
              encryptionKey,
            });
          } else {
            await uploadSceneAssets({
              backend,
              sceneId: result.id,
              elements,
              files,
            });
          }
        } catch (error) {
          didSyncAssets = false;
          console.warn(error);
        }

        let finalUpdatedAt = now;
        if (!activeScene && hadLocalVideoAssets) {
          const provisionalScene: ActiveCloudScene = {
            id: result.id,
            ownerId: cloudAuth.user.id,
            title,
            payloadKind: "plain",
            version: result.version,
            createdAt: now,
            updatedAt: now,
          };
          setActiveCloudScene(provisionalScene);
          activeCloudSceneRef.current = provisionalScene;
          lastCloudLocalPayloadHashRef.current = payloadHash;
          lastCloudSavedPayloadHashRef.current = null;
          saveCloudSceneBinding({
            ...provisionalScene,
            localPayloadHash: payloadHash,
            localFingerprint,
            savedPayloadHash: null,
          });

          await migrateAIVideoAssetsRef.current();
          const migratedElements = sanitizeDeletedAIVideoMarkersForPersistence(
            excalidrawAPI.getSceneElementsIncludingDeleted(),
          );
          const stillHasNonPortableVideo =
            hasNonPortableAIVideo(migratedElements);
          if (stillHasNonPortableVideo) {
            throw new Error(t("ai.workbench.videoAssetCloudSaveBlocked"));
          }

          const migratedSerializedPayload = serializeAsJSON(
            migratedElements,
            excalidrawAPI.getAppState(),
            excalidrawAPI.getFiles(),
            "database",
          );
          payloadHash = getCloudPayloadHash(migratedSerializedPayload);
          localFingerprint = getCloudSceneFingerprint(migratedElements);
          finalUpdatedAt = Date.now();
          result = await backend.scenes.save({
            id: result.id,
            ownerId: cloudAuth.user.id,
            title,
            payloadKind: "plain",
            payload: JSON.parse(migratedSerializedPayload),
            version: result.version,
            createdAt: now,
            updatedAt: finalUpdatedAt,
            deletedAt: null,
          });
        }

        const nextActiveScene: ActiveCloudScene = {
          id: result.id,
          ownerId: cloudAuth.user.id,
          title,
          payloadKind: activeScene?.payloadKind ?? "plain",
          version: result.version,
          createdAt: activeScene?.createdAt ?? now,
          updatedAt: finalUpdatedAt,
        };

        setActiveCloudScene(nextActiveScene);
        activeCloudSceneRef.current = nextActiveScene;
        setCloudSceneRemoteUpdate({ status: "up-to-date", checkedAt: now });
        cloudSceneRemoteUpdateToastRef.current = null;
        lastCloudLocalPayloadHashRef.current = payloadHash;
        lastCloudSavedPayloadHashRef.current = didSyncAssets
          ? payloadHash
          : null;
        saveCloudSceneBinding({
          ...nextActiveScene,
          localPayloadHash: payloadHash,
          localFingerprint,
          savedPayloadHash: didSyncAssets ? payloadHash : null,
        });

        if (!silent) {
          excalidrawAPI.setToast({
            message: didSyncAssets
              ? t("cloud.scenes.saved")
              : t("cloud.scenes.savedAssetsFailed"),
          });
        }
        return true;
      } catch (error) {
        excalidrawAPI.setToast({
          message:
            error instanceof Error
              ? error.message
              : t("cloud.scenes.saveFailed"),
        });
        return false;
      }
    },
    [
      cloudAuth.isAuthAvailable,
      cloudAuth.isSignedIn,
      cloudAuth.user,
      collabAPI,
      excalidrawAPI,
    ],
  );

  const saveCurrentSceneAsEncryptedCloudScene = useCallback(async () => {
    if (
      !excalidrawAPI ||
      !cloudAuth.isAuthAvailable ||
      !cloudAuth.isSignedIn ||
      !cloudAuth.user
    ) {
      return false;
    }

    if (collabAPI?.isCollaborating()) {
      excalidrawAPI.setToast({
        message: t("cloud.scenes.saveSkippedCollab"),
      });
      return false;
    }

    const backend = getCloudBackend();
    if (
      !backend.capabilities.sceneStorage ||
      !backend.capabilities.encryptedCloudStorage ||
      !backend.encryption.isAvailable()
    ) {
      excalidrawAPI.setToast({
        message: t("cloud.e2e.unavailable"),
      });
      return false;
    }

    try {
      const elements = sanitizeDeletedAIVideoMarkersForPersistence(
        excalidrawAPI.getSceneElementsIncludingDeleted(),
      );
      if (hasNonPortableAIVideo(elements)) {
        excalidrawAPI.setToast({
          message: t("ai.workbench.videoAssetCloudSaveBlocked"),
        });
        return false;
      }
      const appState = excalidrawAPI.getAppState();
      const files = excalidrawAPI.getFiles();
      const serializedPayload = serializeAsJSON(
        elements,
        appState,
        files,
        "database",
      );
      const payloadHash = getCloudPayloadHash(serializedPayload);
      const localFingerprint = getCloudSceneFingerprint(elements);
      const now = Date.now();
      const title = excalidrawAPI.getName() || t("labels.untitled");
      const key = await backend.encryption.generateKey();
      const payload = await backend.encryption.encryptScenePayload(
        JSON.parse(serializedPayload),
        key,
      );

      const result = await backend.scenes.save({
        id: null,
        ownerId: cloudAuth.user.id,
        title,
        payloadKind: "encrypted",
        payload,
        version: 0,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      });

      let didSyncAssets = true;
      try {
        await uploadEncryptedSceneAssets({
          backend,
          sceneId: result.id,
          elements,
          files,
          encryptionKey: key,
        });
      } catch (error) {
        didSyncAssets = false;
        console.warn(error);
      }

      backend.encryption.saveKey({
        sceneId: result.id,
        key,
        createdAt: now,
        updatedAt: now,
      });

      const nextActiveScene: ActiveCloudScene = {
        id: result.id,
        ownerId: cloudAuth.user.id,
        title,
        payloadKind: "encrypted",
        version: result.version,
        createdAt: now,
        updatedAt: now,
      };
      setActiveCloudScene(nextActiveScene);
      activeCloudSceneRef.current = nextActiveScene;
      setCloudSceneRemoteUpdate({ status: "up-to-date", checkedAt: now });
      cloudSceneRemoteUpdateToastRef.current = null;
      lastCloudLocalPayloadHashRef.current = payloadHash;
      lastCloudSavedPayloadHashRef.current = didSyncAssets ? payloadHash : null;
      saveCloudSceneBinding({
        ...nextActiveScene,
        localPayloadHash: payloadHash,
        localFingerprint,
        savedPayloadHash: didSyncAssets ? payloadHash : null,
      });

      excalidrawAPI.setToast({
        message: didSyncAssets
          ? t("cloud.e2e.saved")
          : t("cloud.scenes.savedAssetsFailed"),
      });
      return true;
    } catch (error) {
      excalidrawAPI.setToast({
        message:
          error instanceof Error ? error.message : t("cloud.e2e.saveFailed"),
      });
      return false;
    }
  }, [
    cloudAuth.isAuthAvailable,
    cloudAuth.isSignedIn,
    cloudAuth.user,
    collabAPI,
    excalidrawAPI,
  ]);

  const saveCurrentSharedSceneToCloud = useCallback(
    async (opts: { silent?: boolean } = {}): Promise<boolean> => {
      const { silent = false } = opts;

      if (!excalidrawAPI) {
        return false;
      }

      const activeScene = activeSharedSceneRef.current;
      if (!activeScene?.id || activeScene.mode !== "write") {
        return false;
      }

      if (collabAPI?.isCollaborating()) {
        return false;
      }

      if (document.hidden || navigator.onLine === false) {
        return false;
      }

      const backend = getCloudBackend();
      if (!backend.capabilities.share) {
        return false;
      }

      try {
        const elements = sanitizeDeletedAIVideoMarkersForPersistence(
          excalidrawAPI.getSceneElementsIncludingDeleted(),
        );
        if (hasNonPortableAIVideo(elements)) {
          if (!silent) {
            excalidrawAPI.setToast({
              message: t("ai.workbench.videoAssetShareSaveBlocked"),
            });
          }
          return false;
        }
        const appState = excalidrawAPI.getAppState();
        const files = excalidrawAPI.getFiles();
        const serializedPayload = serializeAsJSON(
          elements,
          appState,
          files,
          "database",
        );
        const payloadHash = getCloudPayloadHash(serializedPayload);
        if (silent && payloadHash === lastSharedSavedPayloadHashRef.current) {
          return false;
        }

        const now = Date.now();
        const title = activeScene.title;
        const payloadObject = JSON.parse(serializedPayload);
        const encryptionKey =
          activeScene.payloadKind === "encrypted"
            ? activeScene.encryptionKey
            : null;
        if (activeScene.payloadKind === "encrypted") {
          if (!backend.encryption.isAvailable()) {
            throw new Error(t("cloud.e2e.unavailable"));
          }
          if (!encryptionKey) {
            throw new Error(t("cloud.e2e.missingKey"));
          }
        }
        const scenePayload =
          activeScene.payloadKind === "encrypted" && encryptionKey
            ? await backend.encryption.encryptScenePayload(
                payloadObject,
                encryptionKey,
              )
            : payloadObject;
        const result = await backend.shares.saveScene(activeScene.token, {
          id: activeScene.id,
          ownerId: activeScene.ownerId,
          title,
          payloadKind: activeScene.payloadKind,
          payload: scenePayload,
          version: activeScene.version,
          createdAt: activeScene.createdAt,
          updatedAt: now,
          deletedAt: null,
        });

        let didSyncAssets = true;
        try {
          if (activeScene.payloadKind === "encrypted" && encryptionKey) {
            await uploadEncryptedSharedSceneAssets({
              backend,
              shares: backend.shares,
              token: activeScene.token,
              sceneId: result.id,
              elements,
              files,
              encryptionKey,
            });
          } else {
            await uploadSharedSceneAssets({
              shares: backend.shares,
              token: activeScene.token,
              sceneId: result.id,
              elements,
              files,
            });
          }
        } catch (error) {
          didSyncAssets = false;
          console.warn(error);
        }

        const nextActiveScene: ActiveSharedScene = {
          ...activeScene,
          title,
          payloadKind: activeScene.payloadKind,
          version: result.version,
          updatedAt: now,
        };
        setActiveSharedScene(nextActiveScene);
        activeSharedSceneRef.current = nextActiveScene;
        lastSharedSavedPayloadHashRef.current = didSyncAssets
          ? payloadHash
          : null;

        if (!silent) {
          excalidrawAPI.setToast({
            message: didSyncAssets
              ? t("cloud.share.saved")
              : t("cloud.scenes.savedAssetsFailed"),
          });
        }
        return true;
      } catch (error) {
        excalidrawAPI.setToast({
          message:
            error instanceof Error
              ? error.message
              : t("cloud.share.saveFailed"),
        });
        return false;
      }
    },
    [collabAPI, excalidrawAPI],
  );

  const saveCurrentEmbeddedSceneToCloud = useCallback(
    async (opts: { silent?: boolean } = {}): Promise<boolean> => {
      const { silent = false } = opts;

      if (!excalidrawAPI) {
        return false;
      }

      const activeScene = activeEmbeddedSceneRef.current;
      if (!activeScene?.id || activeScene.mode !== "write") {
        return false;
      }

      if (collabAPI?.isCollaborating()) {
        return false;
      }

      if (document.hidden || navigator.onLine === false) {
        return false;
      }

      const backend = getCloudBackend();
      if (!backend.capabilities.embed) {
        return false;
      }

      try {
        const elements = sanitizeDeletedAIVideoMarkersForPersistence(
          excalidrawAPI.getSceneElementsIncludingDeleted(),
        );
        if (hasNonPortableAIVideo(elements)) {
          if (!silent) {
            excalidrawAPI.setToast({
              message: t("ai.workbench.videoAssetShareSaveBlocked"),
            });
          }
          return false;
        }
        const appState = excalidrawAPI.getAppState();
        const files = excalidrawAPI.getFiles();
        const serializedPayload = serializeAsJSON(
          elements,
          appState,
          files,
          "database",
        );
        const payloadHash = getCloudPayloadHash(serializedPayload);
        if (silent && payloadHash === lastEmbeddedSavedPayloadHashRef.current) {
          return false;
        }

        const now = Date.now();
        const title = activeScene.title;
        const payloadObject = JSON.parse(serializedPayload);
        const encryptionKey =
          activeScene.payloadKind === "encrypted"
            ? activeScene.encryptionKey
            : null;
        if (activeScene.payloadKind === "encrypted") {
          if (!backend.encryption.isAvailable()) {
            throw new Error(t("cloud.e2e.unavailable"));
          }
          if (!encryptionKey) {
            throw new Error(t("cloud.e2e.missingKey"));
          }
        }
        const scenePayload =
          activeScene.payloadKind === "encrypted" && encryptionKey
            ? await backend.encryption.encryptScenePayload(
                payloadObject,
                encryptionKey,
              )
            : payloadObject;
        const result = await backend.embed.saveScene(
          activeScene.token,
          activeScene.origin,
          {
            id: activeScene.id,
            ownerId: activeScene.ownerId,
            title,
            payloadKind: activeScene.payloadKind,
            payload: scenePayload,
            version: activeScene.version,
            createdAt: activeScene.createdAt,
            updatedAt: now,
            deletedAt: null,
          },
        );

        let didSyncAssets = true;
        try {
          if (activeScene.payloadKind === "encrypted" && encryptionKey) {
            await uploadEncryptedEmbeddedSceneAssets({
              backend,
              embed: backend.embed,
              token: activeScene.token,
              origin: activeScene.origin,
              sceneId: result.id,
              elements,
              files,
              encryptionKey,
            });
          } else {
            await uploadEmbeddedSceneAssets({
              embed: backend.embed,
              token: activeScene.token,
              origin: activeScene.origin,
              sceneId: result.id,
              elements,
              files,
            });
          }
        } catch (error) {
          didSyncAssets = false;
          console.warn(error);
        }

        const nextActiveScene: ActiveEmbeddedScene = {
          ...activeScene,
          title,
          payloadKind: activeScene.payloadKind,
          version: result.version,
          updatedAt: now,
        };
        setActiveEmbeddedScene(nextActiveScene);
        activeEmbeddedSceneRef.current = nextActiveScene;
        lastEmbeddedSavedPayloadHashRef.current = didSyncAssets
          ? payloadHash
          : null;

        if (!silent) {
          excalidrawAPI.setToast({
            message: didSyncAssets
              ? t("cloud.embed.saved")
              : t("cloud.scenes.savedAssetsFailed"),
          });
        }
        return true;
      } catch (error) {
        excalidrawAPI.setToast({
          message:
            error instanceof Error
              ? error.message
              : t("cloud.embed.saveFailed"),
        });
        return false;
      }
    },
    [collabAPI, excalidrawAPI],
  );

  const postEmbedEvent = useCallback(
    (name: "ready" | "sceneChange" | "saved" | "error", payload?: unknown) => {
      const activeScene = activeEmbeddedSceneRef.current;
      if (!activeScene || window.parent === window) {
        return;
      }
      window.parent.postMessage(
        createEmbedEvent(name, payload),
        activeScene.origin,
      );
    },
    [],
  );

  useEffect(() => {
    if (!activeEmbeddedScene || !excalidrawAPI) {
      return;
    }

    postEmbedEvent("ready", {
      sceneId: activeEmbeddedScene.id,
      mode: activeEmbeddedScene.mode,
      version: activeEmbeddedScene.version,
    });
  }, [
    activeEmbeddedScene,
    activeEmbeddedScene?.id,
    activeEmbeddedScene?.mode,
    activeEmbeddedScene?.version,
    excalidrawAPI,
    postEmbedEvent,
  ]);

  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }

    const handleEmbedMessage = async (event: MessageEvent) => {
      const activeScene = activeEmbeddedSceneRef.current;
      if (
        !activeScene ||
        event.origin !== activeScene.origin ||
        !isEmbedApiEnvelope(event.data) ||
        event.data.type !== "command"
      ) {
        return;
      }

      const source = event.source as Window | null;
      const respond = (payload?: unknown) => {
        source?.postMessage(
          createEmbedResponse(event.data.requestId, event.data.name, payload),
          event.origin,
        );
      };
      const respondError = (message: string) => {
        source?.postMessage(
          createEmbedError(message, event.data.requestId),
          event.origin,
        );
      };

      try {
        if (event.data.name === "ping") {
          respond({ ok: true });
          return;
        }

        if (event.data.name === "getScene") {
          respond({
            sceneId: activeScene.id,
            version: activeScene.version,
            payload: JSON.parse(
              serializeAsJSON(
                excalidrawAPI.getSceneElementsIncludingDeleted(),
                excalidrawAPI.getAppState(),
                excalidrawAPI.getFiles(),
                "database",
              ),
            ),
          });
          return;
        }

        if (event.data.name === "setReadonly") {
          const payload = event.data.payload as { readonly?: boolean } | null;
          const nextReadonly = payload?.readonly ?? true;
          if (activeScene.mode !== "write" && !nextReadonly) {
            respondError(t("cloud.embed.readOnly"));
            return;
          }
          excalidrawAPI.updateScene({
            appState: {
              viewModeEnabled: nextReadonly,
            },
            captureUpdate: CaptureUpdateAction.IMMEDIATELY,
          });
          respond({ ok: true });
          return;
        }

        if (activeScene.mode !== "write") {
          respondError(t("cloud.embed.readOnly"));
          return;
        }

        if (event.data.name === "setScene") {
          const payload = event.data.payload as {
            elements?: any;
            appState?: any;
            files?: BinaryFiles;
          } | null;
          const restoredElements = restoreElements(
            payload?.elements ?? null,
            null,
            {
              repairBindings: true,
              deleteInvisibleElements: true,
            },
          );
          excalidrawAPI.updateScene({
            elements: restoredElements,
            appState: restoreAppState(payload?.appState ?? null, null),
            captureUpdate: CaptureUpdateAction.IMMEDIATELY,
          });
          if (payload?.files) {
            excalidrawAPI.addFiles(Object.values(payload.files));
          }
          respond({ ok: true });
          return;
        }

        if (event.data.name === "save") {
          const saved = await saveCurrentEmbeddedSceneToCloud();
          respond({
            saved,
            version:
              activeEmbeddedSceneRef.current?.version ?? activeScene.version,
          });
          if (saved) {
            postEmbedEvent("saved", {
              sceneId: activeEmbeddedSceneRef.current?.id ?? activeScene.id,
              version:
                activeEmbeddedSceneRef.current?.version ?? activeScene.version,
            });
          }
          return;
        }

        respondError(t("cloud.embed.unsupportedCommand"));
      } catch (error) {
        respondError(
          error instanceof Error
            ? error.message
            : t("cloud.embed.genericError"),
        );
      }
    };

    window.addEventListener("message", handleEmbedMessage);
    return () => {
      window.removeEventListener("message", handleEmbedMessage);
    };
  }, [excalidrawAPI, postEmbedEvent, saveCurrentEmbeddedSceneToCloud]);

  const recordActiveCloudAITask = useCallback(
    async (run: CloudAITaskRun) => {
      const activeScene = activeCloudSceneRef.current;
      const backend = getCloudBackend();

      if (
        !cloudAuth.user ||
        !activeScene?.id ||
        activeScene.ownerId !== cloudAuth.user.id ||
        !backend.capabilities.aiTasks
      ) {
        return;
      }

      await recordCloudAITask({
        backend,
        sceneId: activeScene.id,
        run,
      });
    },
    [cloudAuth.user],
  );

  const checkActiveCloudSceneRemoteUpdate = useCallback(
    async (opts: { silent?: boolean } = {}): Promise<SceneSummary | null> => {
      const { silent = false } = opts;
      const activeScene = activeCloudSceneRef.current;

      if (
        !activeScene?.id ||
        !cloudAuth.isSignedIn ||
        !cloudAuth.user ||
        navigator.onLine === false
      ) {
        if (!activeScene?.id) {
          setCloudSceneRemoteUpdate({ status: "idle" });
        }
        return null;
      }

      const backend = getCloudBackend();
      if (!backend.capabilities.sceneStorage) {
        setCloudSceneRemoteUpdate({ status: "idle" });
        return null;
      }

      if (!silent) {
        setCloudSceneRemoteUpdate({ status: "checking" });
      }

      try {
        const metadata = await backend.scenes.getMetadata(activeScene.id);
        const currentActiveScene = activeCloudSceneRef.current;

        if (!currentActiveScene || currentActiveScene.id !== metadata.id) {
          return null;
        }

        if (metadata.version > currentActiveScene.version) {
          setCloudSceneRemoteUpdate({
            status: "remote-newer",
            metadata,
            checkedAt: Date.now(),
          });

          const toastKey = `${metadata.id}:${metadata.version}`;
          if (cloudSceneRemoteUpdateToastRef.current !== toastKey) {
            cloudSceneRemoteUpdateToastRef.current = toastKey;
            excalidrawAPI?.setToast({
              message: t("cloud.scenes.remoteUpdateAvailable"),
            });
          }
          return metadata;
        }

        if (
          metadata.version === currentActiveScene.version &&
          (metadata.updatedAt !== currentActiveScene.updatedAt ||
            metadata.title !== currentActiveScene.title)
        ) {
          const nextActiveScene = {
            ...currentActiveScene,
            title: metadata.title,
            updatedAt: metadata.updatedAt,
          };
          setActiveCloudScene(nextActiveScene);
          activeCloudSceneRef.current = nextActiveScene;
        }

        setCloudSceneRemoteUpdate({
          status: "up-to-date",
          checkedAt: Date.now(),
        });
        cloudSceneRemoteUpdateToastRef.current = null;
        return null;
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : t("cloud.scenes.genericError");
        setCloudSceneRemoteUpdate({
          status: "error",
          message,
          checkedAt: Date.now(),
        });
        if (!silent) {
          excalidrawAPI?.setToast({ message });
        }
        return null;
      }
    },
    [cloudAuth.isSignedIn, cloudAuth.user, excalidrawAPI],
  );

  useEffect(() => {
    if (!activeCloudScene?.id || !cloudAuth.isSignedIn || !cloudAuth.user) {
      setCloudSceneRemoteUpdate({ status: "idle" });
      cloudSceneRemoteUpdateToastRef.current = null;
      return;
    }

    void checkActiveCloudSceneRemoteUpdate({ silent: true });

    const interval = window.setInterval(() => {
      void checkActiveCloudSceneRemoteUpdate({ silent: true });
    }, CLOUD_REMOTE_UPDATE_CHECK_MS);

    const checkWhenVisible = () => {
      if (!document.hidden) {
        void checkActiveCloudSceneRemoteUpdate({ silent: true });
      }
    };

    window.addEventListener(EVENT.FOCUS, checkWhenVisible);
    document.addEventListener(EVENT.VISIBILITY_CHANGE, checkWhenVisible);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener(EVENT.FOCUS, checkWhenVisible);
      document.removeEventListener(EVENT.VISIBILITY_CHANGE, checkWhenVisible);
    };
  }, [
    activeCloudScene?.id,
    checkActiveCloudSceneRemoteUpdate,
    cloudAuth.isSignedIn,
    cloudAuth.user,
  ]);

  const syncActiveCloudSceneLocalBinding = useCallback(
    (
      elements: readonly OrderedExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
    ) => {
      const activeScene = activeCloudSceneRef.current;
      if (!activeScene?.id || !cloudAuth.user) {
        return;
      }

      try {
        const serializedPayload = serializeAsJSON(
          elements,
          appState,
          files,
          "database",
        );
        const payloadHash = getCloudPayloadHash(serializedPayload);
        const localFingerprint = getCloudSceneFingerprint(elements);

        if (payloadHash === lastCloudLocalPayloadHashRef.current) {
          return;
        }

        lastCloudLocalPayloadHashRef.current = payloadHash;
        saveCloudSceneBinding({
          ...activeScene,
          localPayloadHash: payloadHash,
          localFingerprint,
          savedPayloadHash: lastCloudSavedPayloadHashRef.current,
        });
      } catch (error) {
        console.warn(error);
      }
    },
    [cloudAuth.user],
  );

  const scheduleCloudBindingSync = useCallback(
    (
      elements: readonly OrderedExcalidrawElement[],
      appState: AppState,
      files: BinaryFiles,
    ) => {
      if (!activeCloudSceneRef.current?.id || !cloudAuth.user) {
        return;
      }

      if (cloudBindingSyncTimerRef.current) {
        clearTimeout(cloudBindingSyncTimerRef.current);
      }

      cloudBindingSyncTimerRef.current = setTimeout(() => {
        cloudBindingSyncTimerRef.current = null;
        syncActiveCloudSceneLocalBinding(elements, appState, files);
      }, CLOUD_BINDING_SYNC_DEBOUNCE_MS);
    },
    [cloudAuth.user, syncActiveCloudSceneLocalBinding],
  );

  const flushCloudBindingSync = useCallback(() => {
    if (cloudBindingSyncTimerRef.current) {
      clearTimeout(cloudBindingSyncTimerRef.current);
      cloudBindingSyncTimerRef.current = null;
    }

    if (!excalidrawAPI) {
      return;
    }

    syncActiveCloudSceneLocalBinding(
      excalidrawAPI.getSceneElementsIncludingDeleted(),
      excalidrawAPI.getAppState(),
      excalidrawAPI.getFiles(),
    );
  }, [excalidrawAPI, syncActiveCloudSceneLocalBinding]);

  const scheduleCloudAutosave = useCallback(() => {
    const activeShared = activeSharedSceneRef.current;
    const canSaveShared = !!activeShared?.id && activeShared.mode === "write";
    const activeEmbedded = activeEmbeddedSceneRef.current;
    const canSaveEmbedded =
      !!activeEmbedded?.id && activeEmbedded.mode === "write";
    const canSaveAccount =
      !!activeCloudSceneRef.current?.id &&
      cloudAuth.isAuthAvailable &&
      cloudAuth.isSignedIn &&
      !!cloudAuth.user;

    if (
      (!canSaveShared && !canSaveEmbedded && !canSaveAccount) ||
      document.hidden ||
      navigator.onLine === false
    ) {
      return;
    }

    if (cloudAutosaveTimerRef.current) {
      clearTimeout(cloudAutosaveTimerRef.current);
    }

    cloudAutosaveTimerRef.current = setTimeout(() => {
      cloudAutosaveTimerRef.current = null;
      if (cloudSaveInFlightRef.current) {
        scheduleCloudAutosave();
        return;
      }

      cloudSaveInFlightRef.current = true;
      const savePromise =
        activeEmbeddedSceneRef.current?.mode === "write"
          ? saveCurrentEmbeddedSceneToCloud({ silent: true })
          : activeSharedSceneRef.current?.mode === "write"
          ? saveCurrentSharedSceneToCloud({ silent: true })
          : saveCurrentSceneToCloud({ silent: true });
      savePromise
        .catch(() => {
          // Save helpers already surface a toast and preserve local data.
        })
        .finally(() => {
          cloudSaveInFlightRef.current = false;
        });
    }, CLOUD_AUTOSAVE_DEBOUNCE_MS);
  }, [
    cloudAuth.isAuthAvailable,
    cloudAuth.isSignedIn,
    cloudAuth.user,
    saveCurrentSceneToCloud,
    saveCurrentEmbeddedSceneToCloud,
    saveCurrentSharedSceneToCloud,
  ]);

  const onChange = (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    const isVaultRoute = isCurrentVaultRoute();
    vaultV2SessionRef.current?.onChange(elements, appState);
    if (isVaultRoute && activeVaultRef.current?.session.role === "editor") {
      const prepared = prepareVaultAutosaveSnapshot(
        lastVaultSerializedSnapshotRef.current,
        elements,
        appState,
        files,
      );
      if (prepared) {
        lastVaultSerializedSnapshotRef.current = prepared.serializedSnapshot;
        vaultAutosaveRef.current?.schedule(prepared.snapshot);
      }
    }
    if (collabAPI?.isCollaborating()) {
      collabAPI.syncElements(elements);
    }

    // this check is redundant, but since this is a hot path, it's best
    // not to evaludate the nested expression every time
    if (!isVaultRoute && !LocalData.isSavePaused()) {
      LocalData.save(elements, appState, files, () => {
        if (excalidrawAPI) {
          let didChange = false;

          const elements = excalidrawAPI
            .getSceneElementsIncludingDeleted()
            .map((element) => {
              if (
                LocalData.fileStorage.shouldUpdateImageElementStatus(element)
              ) {
                const newElement = newElementWith(element, { status: "saved" });
                if (newElement !== element) {
                  didChange = true;
                }
                return newElement;
              }
              return element;
            });

          if (didChange) {
            excalidrawAPI.updateScene({
              elements,
              captureUpdate: CaptureUpdateAction.NEVER,
            });
          }
        }
      });
    }

    if (!isVaultRoute) {
      scheduleCloudBindingSync(elements, appState, files);
    }
    if (!isVaultRoute && activeEmbeddedSceneRef.current) {
      postEmbedEvent("sceneChange", {
        sceneId: activeEmbeddedSceneRef.current.id,
        version: activeEmbeddedSceneRef.current.version,
      });
    }
    if (!isVaultRoute) {
      scheduleCloudAutosave();
    }

    // Render the debug scene if the debug canvas is available
    if (debugCanvasRef.current && excalidrawAPI) {
      debugRenderer(
        debugCanvasRef.current,
        appState,
        elements,
        window.devicePixelRatio,
      );
    }
  };

  const [latestShareableLink, setLatestShareableLink] = useState<string | null>(
    null,
  );

  const onExportToBackend = async (
    exportedElements: readonly NonDeletedExcalidrawElement[],
    appState: Partial<AppState>,
    files: BinaryFiles,
  ) => {
    if (isCurrentVaultRoute()) {
      throw new VaultError(
        "VAULT_EGRESS_DENIED",
        "Vault cannot use legacy share export.",
      );
    }
    if (exportedElements.length === 0) {
      throw new Error(t("alerts.cannotExportEmptyCanvas"));
    }
    if (exportedElements.some(hasAIVideoGenerationMarker)) {
      throw new Error(t("ai.workbench.videoAssetLegacyShareBlocked"));
    }
    try {
      const { url, errorMessage } = await exportToBackend(
        exportedElements,
        {
          ...appState,
          viewBackgroundColor: appState.exportBackground
            ? appState.viewBackgroundColor
            : getDefaultAppState().viewBackgroundColor,
        },
        files,
      );

      if (errorMessage) {
        throw new Error(errorMessage);
      }

      if (url) {
        setLatestShareableLink(url);
      }
    } catch (error: any) {
      if (error.name !== "AbortError") {
        const { width, height } = appState;
        console.error(error, {
          width,
          height,
          devicePixelRatio: window.devicePixelRatio,
        });
        throw new Error(error.message);
      }
    }
  };

  const renderCustomStats = (
    elements: readonly NonDeletedExcalidrawElement[],
    appState: UIAppState,
  ) => {
    return (
      <CustomStats
        setToast={(message) => excalidrawAPI!.setToast({ message })}
        appState={appState}
        elements={elements}
      />
    );
  };

  const isOffline = useAtomValue(isOfflineAtom);

  const localStorageQuotaExceeded = useAtomValue(localStorageQuotaExceededAtom);

  const onCollabDialogOpen = useCallback(
    () => setShareDialogState({ isOpen: true, type: "collaborationOnly" }),
    [setShareDialogState],
  );
  const onShareDialogOpen = useCallback(
    () => setShareDialogState({ isOpen: true, type: "share" }),
    [setShareDialogState],
  );

  useEffect(() => {
    window.addEventListener(EVENT.BEFORE_UNLOAD, flushCloudBindingSync);
    window.addEventListener(EVENT.UNLOAD, flushCloudBindingSync);
    return () => {
      window.removeEventListener(EVENT.BEFORE_UNLOAD, flushCloudBindingSync);
      window.removeEventListener(EVENT.UNLOAD, flushCloudBindingSync);
    };
  }, [flushCloudBindingSync]);

  const onOpenCloudScene = useCallback(
    async (record: SceneRecord) => {
      if (!excalidrawAPI) {
        return;
      }

      if (
        !record.payload ||
        typeof record.payload !== "object" ||
        Array.isArray(record.payload)
      ) {
        throw new Error(t("cloud.scenes.invalidPayload"));
      }

      const backend = getCloudBackend();
      let payload = record.payload as {
        elements?: any;
        appState?: any;
      };
      let encryptionKey: string | null = null;

      if (record.payloadKind === "encrypted") {
        if (!record.id || !isEncryptedScenePayloadV1(record.payload)) {
          throw new Error(t("cloud.scenes.invalidPayload"));
        }

        encryptionKey = backend.encryption.getKey(record.id)?.key ?? null;
        if (!encryptionKey) {
          throw new Error(t("cloud.e2e.missingKey"));
        }
        payload = (await backend.encryption.decryptScenePayload(
          record.payload,
          encryptionKey,
        )) as {
          elements?: any;
          appState?: any;
        };
      }

      if (collabAPI?.isCollaborating()) {
        collabAPI.stopCollaboration(false);
      }
      setActiveSharedScene(null);
      activeSharedSceneRef.current = null;
      lastSharedSavedPayloadHashRef.current = null;
      setActiveEmbeddedScene(null);
      activeEmbeddedSceneRef.current = null;
      lastEmbeddedSavedPayloadHashRef.current = null;

      const restoredElements = restoreElements(payload.elements ?? null, null, {
        repairBindings: true,
        deleteInvisibleElements: true,
      });
      const restoredAppState = {
        ...restoreAppState(payload.appState ?? null, null),
        isLoading: false,
        name: record.title,
      };
      let loadedCloudFiles: BinaryFileData[] = [];
      let cloudAssetErrors = new Map<FileId, true>();
      let didFailCloudAssetList = false;
      if (record.id) {
        try {
          const assetResult =
            record.payloadKind === "encrypted" && encryptionKey
              ? await loadEncryptedSceneAssets({
                  backend,
                  sceneId: record.id,
                  elements: restoredElements,
                  encryptionKey,
                })
              : await loadSceneAssets({
                  backend,
                  sceneId: record.id,
                  elements: restoredElements,
                });
          loadedCloudFiles = assetResult.loadedFiles;
          cloudAssetErrors = assetResult.erroredFiles;
        } catch (error) {
          didFailCloudAssetList = true;
          console.warn(error);
        }
      }

      excalidrawAPI.updateScene({
        elements: restoredElements,
        appState: restoredAppState,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      if (loadedCloudFiles.length) {
        excalidrawAPI.addFiles(loadedCloudFiles);
      }
      if (cloudAssetErrors.size) {
        updateStaleImageStatuses({
          excalidrawAPI,
          erroredFiles: cloudAssetErrors,
          elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
        });
      }
      excalidrawAPI.history.clear();
      if (record.id) {
        const nextActiveScene: ActiveCloudScene = {
          id: record.id,
          ownerId: record.ownerId,
          title: record.title,
          payloadKind: record.payloadKind,
          version: record.version,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        };
        setActiveCloudScene(nextActiveScene);
        activeCloudSceneRef.current = nextActiveScene;
        setCloudSceneRemoteUpdate({
          status: "up-to-date",
          checkedAt: Date.now(),
        });
        cloudSceneRemoteUpdateToastRef.current = null;
        const serializedPayload = serializeAsJSON(
          restoredElements,
          restoredAppState,
          loadedCloudFiles.reduce((acc, file) => {
            acc[file.id] = file;
            return acc;
          }, {} as BinaryFiles),
          "database",
        );
        const payloadHash = getCloudPayloadHash(serializedPayload);
        const localFingerprint = getCloudSceneFingerprint(restoredElements);
        lastCloudLocalPayloadHashRef.current = payloadHash;
        lastCloudSavedPayloadHashRef.current = payloadHash;
        saveCloudSceneBinding({
          ...nextActiveScene,
          localPayloadHash: payloadHash,
          localFingerprint,
          savedPayloadHash: payloadHash,
        });
      }
      excalidrawAPI.setToast({
        message:
          didFailCloudAssetList || cloudAssetErrors.size
            ? t("cloud.scenes.openedAssetsFailed")
            : t("cloud.scenes.opened"),
      });
    },
    [collabAPI, excalidrawAPI],
  );

  const refreshActiveCloudSceneFromRemote = useCallback(async () => {
    const activeScene = activeCloudSceneRef.current;
    if (!activeScene?.id || !excalidrawAPI) {
      return;
    }

    try {
      const serializedPayload = serializeAsJSON(
        excalidrawAPI.getSceneElementsIncludingDeleted(),
        excalidrawAPI.getAppState(),
        excalidrawAPI.getFiles(),
        "database",
      );
      const payloadHash = getCloudPayloadHash(serializedPayload);
      if (
        payloadHash !== lastCloudSavedPayloadHashRef.current &&
        !(await confirmAction(t("cloud.scenes.refreshUnsavedConfirm")))
      ) {
        return;
      }

      const record = await getCloudBackend().scenes.load(activeScene.id);
      await onOpenCloudScene(record);
    } catch (error) {
      excalidrawAPI.setToast({
        message:
          error instanceof Error
            ? error.message
            : t("cloud.scenes.genericError"),
      });
    }
  }, [excalidrawAPI, onOpenCloudScene]);

  const renderInputInviteContextMenuItems = useCallback<
    NonNullable<ExcalidrawProps["renderCustomContextMenuItems"]>
  >(
    (selectedElements) => {
      if (
        !collabAPI ||
        isCollabDisabled ||
        selectedElements.length !== 1 ||
        selectedElements[0].type !== "rectangle"
      ) {
        return [];
      }

      const rectangle = selectedElements[0];

      return [
        {
          name: "inviteInput" as const,
          label: "labels.inviteInput",
          trackEvent: { category: "collab", action: "inviteInput" },
          perform: () => {
            setShareDialogState({
              isOpen: true,
              type: "inputInvite",
              inputTargetId: rectangle.id,
            });

            return {
              captureUpdate: CaptureUpdateAction.NEVER,
            };
          },
        },
      ];
    },
    [collabAPI, isCollabDisabled, setShareDialogState],
  );
  const nextAIWorkflowRequestIdRef = useRef(0);
  const [aiReferenceAddRequest, setAIReferenceAddRequest] =
    useState<AIReferenceAddRequest | null>(null);
  const [assistantSkillRequest, setAssistantSkillRequest] =
    useState<AssistantSkillRequest | null>(null);
  const [promptTemplateRequest, setPromptTemplateRequest] =
    useState<PromptTemplateRequest | null>(null);
  const [generationLogReuseRequest, setGenerationLogReuseRequest] =
    useState<GenerationLogReuseRequest | null>(null);
  const createAIWorkflowRequestId = useCallback(() => {
    nextAIWorkflowRequestIdRef.current += 1;
    return nextAIWorkflowRequestIdRef.current;
  }, []);
  const openAIWorkflowTab = useCallback(
    (tab: "ai-image" | "ai-assistant" | "ai-generation-logs") => {
      if (isVaultMode) {
        return;
      }
      excalidrawAPI?.toggleSidebar({
        name: DEFAULT_SIDEBAR.name,
        tab,
        force: true,
      });
    },
    [excalidrawAPI, isVaultMode],
  );
  const requestAIReferenceAdd = useCallback(() => {
    openAIWorkflowTab("ai-image");
    setAIReferenceAddRequest({
      id: createAIWorkflowRequestId(),
    });
  }, [createAIWorkflowRequestId, openAIWorkflowTab]);
  const requestPromptTemplateApply = useCallback(
    (template: PromptTemplate) => {
      openAIWorkflowTab("ai-image");
      setPromptTemplateRequest({
        id: createAIWorkflowRequestId(),
        template,
      });
    },
    [createAIWorkflowRequestId, openAIWorkflowTab],
  );
  const requestAssistantSkillApply = useCallback(
    (skill: AISkill) => {
      openAIWorkflowTab("ai-assistant");
      setAssistantSkillRequest({
        id: createAIWorkflowRequestId(),
        skill,
      });
    },
    [createAIWorkflowRequestId, openAIWorkflowTab],
  );
  const requestGenerationLogReuse = useCallback(
    (log: AIGenerationLogEntry) => {
      openAIWorkflowTab("ai-image");
      setGenerationLogReuseRequest({
        id: createAIWorkflowRequestId(),
        log,
      });
    },
    [createAIWorkflowRequestId, openAIWorkflowTab],
  );
  useEffect(() => {
    // AI is unavailable in Vault mode; leaving the handler unset also hides
    // the "Add to reference images" menu item there.
    if (isVaultMode) {
      return;
    }
    const previousHandlers = window.EXCALIDRAW_APP_AI_HANDLERS;

    window.EXCALIDRAW_APP_AI_HANDLERS = {
      ...previousHandlers,
      addSelectionAsReference: requestAIReferenceAdd,
    };

    return () => {
      if (previousHandlers) {
        window.EXCALIDRAW_APP_AI_HANDLERS = previousHandlers;
      } else {
        window.EXCALIDRAW_APP_AI_HANDLERS = undefined;
      }
    };
  }, [isVaultMode, requestAIReferenceAdd]);

  const requestEnterMaskEditing = useCallback(
    (imageId: string, maskElements?: readonly ExcalidrawFreeDrawElement[]) => {
      maskEditingControllerRef.current?.requestEnterMaskEditing(
        imageId,
        maskElements,
      );
    },
    [],
  );
  const canDeliverWorkbenchMaskPayload = useCallback(
    (payload: AIMaskReadyPayload) => {
      return !!excalidrawAPI?.getAppState().selectedElementIds[payload.imageId];
    },
    [excalidrawAPI],
  );

  const registerWorkbenchMaskReadyHandler = useCallback(
    (handler: ((payload: AIMaskReadyPayload) => void) | null) => {
      workbenchMaskReadyHandlerRef.current = handler;

      if (handler && pendingWorkbenchMaskPayloadRef.current) {
        const pendingPayload = pendingWorkbenchMaskPayloadRef.current;
        pendingWorkbenchMaskPayloadRef.current = null;

        if (
          Date.now() - pendingPayload.createdAt <= 30_000 &&
          canDeliverWorkbenchMaskPayload(pendingPayload.payload)
        ) {
          handler(pendingPayload.payload);
        }
      }
    },
    [canDeliverWorkbenchMaskPayload],
  );

  const handleMaskReady = useCallback((payload: AIMaskReadyPayload) => {
    if (workbenchMaskReadyHandlerRef.current) {
      workbenchMaskReadyHandlerRef.current(payload);
      return;
    }

    pendingWorkbenchMaskPayloadRef.current = {
      payload,
      createdAt: Date.now(),
    };
  }, []);

  // ---------------------------------------------------------------------------
  // onExport — intercepts file save to wait for pending image loads
  // ---------------------------------------------------------------------------
  const onExport: Required<ExcalidrawProps>["onExport"] = useCallback(
    async function* () {
      let snapshot = FileStatusStore.getSnapshot();
      const { pending, total } = FileStatusStore.getPendingCount(
        snapshot.value,
      );
      if (pending > 0) {
        yield {
          type: "progress",
          progress: (total - pending) / total,
          message: t("ai.workbench.exportLoadingImages", {
            loaded: total - pending,
            total,
          }),
        };

        while (true) {
          snapshot = await FileStatusStore.pull(snapshot.version);
          const { pending: nowPending, total: nowTotal } =
            FileStatusStore.getPendingCount(snapshot.value);

          yield {
            type: "progress",
            progress: (nowTotal - nowPending) / nowTotal,
            message: t("ai.workbench.exportLoadingImages", {
              loaded: nowTotal - nowPending,
              total: nowTotal,
            }),
          };

          if (nowPending === 0) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            break;
          }
        }
      }

      yield {
        type: "progress",
        message: t("ai.workbench.exportPreparing"),
      };
      await migrateAIVideoAssetsRef.current();

      const latestElements = excalidrawAPI?.getSceneElements() ?? [];
      const containsNonPortableVideo = hasNonPortableAIVideo(latestElements);
      if (containsNonPortableVideo) {
        excalidrawAPI?.setToast({
          message: t("ai.workbench.videoAssetExportBlocked"),
        });
        return { cancel: true };
      }

      return { elements: latestElements };
    },
    [excalidrawAPI],
  );

  // const onExport = () => {
  //   return new Promise((r) => setTimeout(r, 2500));
  //   // console.log("onExport");
  // };

  const aiPromptTemplateCommands = useMemo(
    () =>
      createAIPromptTemplateCommands({
        excalidrawAPI,
        templates: aiPromptTemplates,
        onApplyPromptTemplate: requestPromptTemplateApply,
      }),
    [aiPromptTemplates, excalidrawAPI, requestPromptTemplateApply],
  );

  const aiVideoMigrationInFlightRef = useRef(new Set<string>());

  const aiVideoAssetContext = useMemo(() => {
    if (activeEmbeddedScene) {
      return {
        id: `embed:${activeEmbeddedScene.token}:${activeEmbeddedScene.origin}`,
        kind: "embed" as const,
      };
    }
    if (activeSharedScene) {
      return {
        id: `share:${activeSharedScene.token}`,
        kind: "share" as const,
      };
    }
    if (activeCloudScene) {
      return { id: `owner:${activeCloudScene.id}`, kind: "owner" as const };
    }
    return aiWorkbenchPersistenceScopeId
      ? {
          id: `local:${aiWorkbenchPersistenceScopeId}`,
          kind: "local" as const,
        }
      : null;
  }, [
    activeCloudScene,
    activeEmbeddedScene,
    activeSharedScene,
    aiWorkbenchPersistenceScopeId,
  ]);

  const resolveAIVideoAsset = useCallback(
    async (assetId: string) => {
      if (assetId.startsWith("local:")) {
        if (activeCloudScene || activeSharedScene || activeEmbeddedScene) {
          throw new Error(
            "Local AI video assets are unavailable outside their local document.",
          );
        }
        const asset = await loadLocalAIVideoAsset(assetId);
        if (!asset) {
          throw new Error("Local AI video asset is unavailable.");
        }
        return {
          url: asset.url,
          expiresAt: Date.now() + 5 * 60 * 1000,
          mimeType: asset.mimeType,
        };
      }

      const backend = getCloudBackend();
      if (activeEmbeddedScene) {
        const result = await backend.embed.loadScene(
          activeEmbeddedScene.token,
          activeEmbeddedScene.origin,
        );
        const asset = result.assets.find(
          (candidate) => candidate.id === assetId,
        );
        if (!asset) {
          throw new Error(
            "AI video asset was not found in the embedded scene.",
          );
        }
        return {
          url: asset.url,
          expiresAt: Date.now() + 50 * 60 * 1000,
          mimeType: asset.mimeType || "video/mp4",
        };
      }

      if (activeSharedScene) {
        if (backend.videoAssets?.isAvailable()) {
          return backend.videoAssets.resolve({
            assetId,
            access: { kind: "share", token: activeSharedScene.token },
          });
        }
        const result = await backend.shares.loadScene(activeSharedScene.token);
        const asset = result.assets.find(
          (candidate) => candidate.id === assetId,
        );
        if (!asset) {
          throw new Error("AI video asset was not found in the shared scene.");
        }
        return {
          url: asset.url,
          expiresAt: Date.now() + 50 * 60 * 1000,
          mimeType: asset.mimeType || "video/mp4",
        };
      }

      if (activeCloudScene) {
        if (backend.videoAssets?.isAvailable()) {
          return backend.videoAssets.resolve({
            assetId,
            access: { kind: "owner" },
          });
        }
        return {
          url: await backend.assets.getUrl(assetId),
          expiresAt: Date.now() + 50 * 60 * 1000,
          mimeType: "video/mp4",
        };
      }

      throw new Error("AI video asset access is unavailable for this scene.");
    },
    [activeCloudScene, activeEmbeddedScene, activeSharedScene],
  );

  const persistActiveCloudVideoOutput = useCallback(
    async ({
      taskId,
      output,
      signal,
    }: PersistAIVideoOutputInput): Promise<VideoAssetIngestResult | null> => {
      const getCurrentContextToken = () =>
        resolveAIVideoPersistenceContextToken({
          activeCloudSceneId: activeCloudSceneRef.current?.id ?? null,
          hasActiveSharedScene: !!activeSharedSceneRef.current,
          hasActiveEmbeddedScene: !!activeEmbeddedSceneRef.current,
          isCollaborating: !!collabAPI?.isCollaborating(),
          localScopeId: aiWorkbenchPersistenceScopeIdRef.current,
        });
      const contextToken = getCurrentContextToken();
      if (!contextToken) {
        throw new Error(
          "AI video output cannot be persisted in the current access context.",
        );
      }
      const assertCurrentContext = () =>
        assertAIVideoPersistenceContext(
          contextToken,
          getCurrentContextToken(),
          signal,
        );
      assertCurrentContext();

      const activeScene = activeCloudSceneRef.current;
      const backend = getCloudBackend();
      if (contextToken.startsWith("owner:")) {
        if (
          !activeScene ||
          !backend.capabilities.remoteVideoAssets ||
          !backend.videoAssets?.isAvailable()
        ) {
          throw new Error("Remote AI video asset persistence is unavailable.");
        }
        const asset = await backend.videoAssets.ingest({
          sceneId: activeScene.id,
          sourceUrl: output.videoURL,
          expectedMimeType: output.mimeType,
          idempotencyKey: taskId,
          signal,
        });
        assertCurrentContext();
        const resolution = await backend.videoAssets.resolve({
          assetId: asset.assetId,
          access: { kind: "owner" },
          signal,
        });
        assertCurrentContext();
        seedVideoPlaybackURLCache(contextToken, asset.assetId, resolution);
        return asset;
      }

      const localAsset = await persistLocalAIVideoURL({
        taskId,
        url: output.videoURL,
        mimeType: output.mimeType,
      });
      assertCurrentContext();
      seedVideoPlaybackURLCache(contextToken, localAsset.assetId, {
        url: localAsset.url,
        expiresAt: Date.now() + 5 * 60 * 1000,
        mimeType: localAsset.mimeType,
      });
      return {
        assetId: localAsset.assetId,
        mimeType: localAsset.mimeType,
        bytes: 0,
      };
    },
    [collabAPI],
  );

  const migrateAIVideoAssets = useCallback(async () => {
    if (isVaultMode) {
      return;
    }
    const activeScene = activeCloudSceneRef.current;
    const backend = getCloudBackend();
    if (!excalidrawAPI) {
      return;
    }

    const getCurrentMigrationContextToken = () =>
      resolveAIVideoPersistenceContextToken({
        activeCloudSceneId: activeCloudSceneRef.current?.id ?? null,
        hasActiveSharedScene: !!activeSharedSceneRef.current,
        hasActiveEmbeddedScene: !!activeEmbeddedSceneRef.current,
        isCollaborating: !!collabAPI?.isCollaborating(),
        localScopeId: aiWorkbenchPersistenceScopeIdRef.current,
      });
    const migrationContextToken = getCurrentMigrationContextToken();
    if (!migrationContextToken) {
      return;
    }
    const canIngestRemote =
      migrationContextToken.startsWith("owner:") &&
      !!activeScene &&
      backend.capabilities.remoteVideoAssets &&
      backend.videoAssets?.isAvailable();
    const canPersistLocally = migrationContextToken.startsWith("local:");

    const candidates = excalidrawAPI.getSceneElements().flatMap((element) => {
      const metadata = getAIVideoGenerationMetadataFromEmbeddable(element);
      if (element.type !== "embeddable" || !metadata) {
        return [];
      }

      const candidate =
        metadata.version === 1 &&
        element.link === metadata.videoURL &&
        (canIngestRemote || canPersistLocally)
          ? {
              kind: "legacy" as const,
              element,
              metadata,
              sourceUrl: metadata.videoURL,
              localAssetId: null,
            }
          : metadata.version === 2 &&
            canIngestRemote &&
            metadata.assetId.startsWith("local:") &&
            element.link === buildAIVideoAssetLink(metadata.assetId)
          ? {
              kind: "local" as const,
              element,
              metadata,
              sourceUrl: null,
              localAssetId: metadata.assetId,
            }
          : null;
      if (!candidate) {
        return [];
      }
      const snapshot = createAIVideoMigrationSnapshot(
        element,
        migrationContextToken,
      );
      if (!snapshot) {
        return [];
      }

      const signature = `${element.id}:${element.version}:${
        candidate.sourceUrl ?? candidate.localAssetId
      }`;
      if (aiVideoMigrationInFlightRef.current.has(signature)) {
        return [];
      }
      aiVideoMigrationInFlightRef.current.add(signature);
      return [{ ...candidate, signature, snapshot }];
    });

    await Promise.all(
      candidates.map(async (candidate) => {
        const { element, metadata, signature } = candidate;
        try {
          let asset: VideoAssetIngestResult;
          if (canIngestRemote && activeScene && backend.videoAssets) {
            if (getCurrentMigrationContextToken() !== migrationContextToken) {
              return;
            }
            const sourceUrl =
              candidate.kind === "legacy"
                ? candidate.sourceUrl
                : (await loadLocalAIVideoAsset(candidate.localAssetId))?.url;
            if (!sourceUrl) {
              return;
            }
            asset = await backend.videoAssets.ingest({
              sceneId: activeScene.id,
              sourceUrl,
              expectedMimeType: metadata.mimeType,
              idempotencyKey: `${candidate.kind}-${element.id}-${element.version}`,
            });
            const resolution = await backend.videoAssets.resolve({
              assetId: asset.assetId,
              access: { kind: "owner" },
            });
            if (getCurrentMigrationContextToken() !== migrationContextToken) {
              return;
            }
            seedVideoPlaybackURLCache(
              migrationContextToken,
              asset.assetId,
              resolution,
            );
          } else if (candidate.kind === "legacy" && canPersistLocally) {
            const localAsset = await persistLocalAIVideoURL({
              taskId: `legacy-${element.id}-${element.version}`,
              url: candidate.sourceUrl,
              mimeType: metadata.mimeType,
            });
            asset = {
              assetId: localAsset.assetId,
              mimeType: localAsset.mimeType,
              bytes: 0,
            };
            if (getCurrentMigrationContextToken() !== migrationContextToken) {
              return;
            }
            seedVideoPlaybackURLCache(
              migrationContextToken,
              localAsset.assetId,
              {
                url: localAsset.url,
                expiresAt: Date.now() + 5 * 60 * 1000,
                mimeType: localAsset.mimeType,
              },
            );
          } else {
            return;
          }

          if (getCurrentMigrationContextToken() !== migrationContextToken) {
            return;
          }

          const nextMetadata = createAIVideoAssetMetadata({
            mode: metadata.mode,
            model: metadata.model,
            prompt: metadata.prompt,
            params: metadata.params,
            asset: {
              ...asset,
              durationSeconds: metadata.durationSeconds,
              revisedPrompt: metadata.revisedPrompt,
            },
            createdAt: metadata.createdAt,
          });
          const currentContextToken = getCurrentMigrationContextToken();
          if (!currentContextToken) {
            return;
          }
          const replacement = replaceAIVideoAssetIfCurrent({
            elements: excalidrawAPI.getSceneElements(),
            snapshot: candidate.snapshot,
            currentContextToken,
            metadata: nextMetadata,
          });
          if (replacement.didReplace) {
            excalidrawAPI.updateScene({
              elements: replacement.elements,
              captureUpdate: CaptureUpdateAction.NEVER,
            });
          }
        } catch {
          // Keep the complete legacy element unchanged. A later scene change or
          // remount retries the idempotent ingest while the provider URL works.
        } finally {
          aiVideoMigrationInFlightRef.current.delete(signature);
        }
      }),
    );
  }, [collabAPI, excalidrawAPI, isVaultMode]);

  migrateAIVideoAssetsRef.current = migrateAIVideoAssets;

  useEffect(() => {
    if (!excalidrawAPI) {
      return;
    }
    const scheduleMigration = () => {
      window.setTimeout(() => void migrateAIVideoAssets(), 0);
    };
    scheduleMigration();
    return excalidrawAPI.onChange(scheduleMigration);
  }, [excalidrawAPI, migrateAIVideoAssets]);

  // Only bypass the core embeddable whitelist for the current element when it
  // carries valid AI video metadata matching its stable link or legacy URL.
  const validateEmbeddable = useCallback(
    (
      link: string,
      element?: NonDeleted<ExcalidrawEmbeddableElement>,
    ): boolean | undefined => {
      if (isVaultMode) {
        return false;
      }
      return element &&
        element.link === link &&
        isValidAIVideoEmbeddable(element)
        ? true
        : undefined;
    },
    [isVaultMode],
  );

  // Render validated AI-generated video embeddables as a native video player.
  // This renders directly in Excalidraw's DOM (not inside an
  // iframe), so playback works for cross-origin CDN URLs without CORS headers —
  // unlike first-frame capture, plain playback never taints a canvas. Returning
  // `null` for non-video embeddables leaves them on the default iframe path.
  const renderEmbeddable = useCallback(
    (element: NonDeleted<ExcalidrawEmbeddableElement>, _appState: AppState) => {
      if (isVaultMode) {
        return (
          <div style={{ width: "100%", height: "100%" }} role="status">
            {t("vault.egress.denied")}
          </div>
        );
      }
      const videoURL = getAIVideoURLFromEmbeddable(element);
      const assetId = getAIVideoAssetIdFromEmbeddable(element);

      if (!videoURL && !assetId) {
        return null;
      }

      const playerStyle = {
        width: "100%",
        height: "100%",
        objectFit: "contain" as const,
        background: "#000",
        borderRadius: "inherit",
      };

      if (assetId) {
        if (!aiVideoAssetContext) {
          return (
            <div style={playerStyle} role="status">
              {t("ai.workbench.videoAssetUnavailable")}
            </div>
          );
        }
        return (
          <AIVideoAssetPlayer
            assetId={assetId}
            contextId={aiVideoAssetContext.id}
            resolveAsset={() => resolveAIVideoAsset(assetId)}
            style={playerStyle}
          />
        );
      }

      return (
        <video
          src={videoURL || undefined}
          controls
          playsInline
          preload="metadata"
          style={playerStyle}
          // Stop pointer events from bubbling to the canvas so the player's
          // controls (scrub/volume) work without moving the element.
          onPointerDown={(event) => event.stopPropagation()}
        />
      );
    },
    [aiVideoAssetContext, isVaultMode, resolveAIVideoAsset],
  );

  const aiGenerationLogCommands = useMemo(
    () =>
      createAIGenerationLogCommands({
        excalidrawAPI,
        logs: aiGenerationLogs,
        onReuseGenerationLog: requestGenerationLogReuse,
      }),
    [aiGenerationLogs, excalidrawAPI, requestGenerationLogReuse],
  );

  const aiSkillCommands = useMemo(
    () =>
      createAISkillCommands({
        excalidrawAPI,
        skills: aiSkills,
        onApplySkill: requestAssistantSkillApply,
      }),
    [aiSkills, excalidrawAPI, requestAssistantSkillApply],
  );

  const aiSettingsCommands = useMemo(() => createAISettingsCommands(), []);

  const coreAIWorkflowCommands = useMemo(
    () =>
      createCoreAIWorkflowCommands({
        excalidrawAPI,
        onAddSelectionAsReference: requestAIReferenceAdd,
      }),
    [excalidrawAPI, requestAIReferenceAdd],
  );

  const officeWorkflowCommands = useMemo(
    () =>
      createOfficeWorkflowCommands({
        excalidrawAPI,
        onOpenCollaboration: onCollabDialogOpen,
        onOpenShare: onShareDialogOpen,
        isCollaborationEnabled: () => !isCollabDisabled,
      }),
    [excalidrawAPI, isCollabDisabled, onCollabDialogOpen, onShareDialogOpen],
  );

  // browsers generally prevent infinite self-embedding, there are
  // cases where it still happens, and while we disallow self-embedding
  // by not whitelisting our own origin, this serves as an additional guard
  if (isSelfEmbedding) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          height: "100%",
        }}
      >
        <h1>I'm not a pretzel!</h1>
      </div>
    );
  }

  const ExcalidrawPlusCommand = {
    label: "Excalidraw+",
    category: DEFAULT_CATEGORIES.links,
    predicate: true,
    icon: <div style={{ width: 14 }}>{ExcalLogo}</div>,
    keywords: ["plus", "cloud", "server"],
    perform: () => {
      window.open(
        `${
          import.meta.env.VITE_APP_PLUS_LP
        }/plus?utm_source=excalidraw&utm_medium=app&utm_content=command_palette`,
        "_blank",
      );
    },
  };
  const ExcalidrawPlusAppCommand = {
    label: "Sign up",
    category: DEFAULT_CATEGORIES.links,
    predicate: true,
    icon: <div style={{ width: 14 }}>{ExcalLogo}</div>,
    keywords: [
      "excalidraw",
      "plus",
      "cloud",
      "server",
      "signin",
      "login",
      "signup",
    ],
    perform: () => {
      window.open(
        `${
          import.meta.env.VITE_APP_PLUS_APP
        }?utm_source=excalidraw&utm_medium=app&utm_content=command_palette`,
        "_blank",
      );
    },
  };

  return (
    <div
      style={{ height: "100%" }}
      className={clsx("excalidraw-app", {
        "is-collaborating": isCollaborating,
      })}
    >
      <Excalidraw
        aiEnabled={!isVaultMode}
        onChange={onChange}
        onTextEditorMount={vaultV2Session?.onTextEditorMount}
        onSceneReplace={handleLocalSceneReplace}
        onExport={onExport}
        initialData={initialStatePromiseRef.current.promise}
        isCollaborating={isCollaborating}
        onPointerUpdate={(payload) => {
          collabAPI?.onPointerUpdate(payload);
          forwardCastEditorPointerUpdate(payload);
        }}
        validateEmbeddable={validateEmbeddable}
        renderEmbeddable={renderEmbeddable}
        voiceOptions={voiceOptions}
        UIOptions={{
          canvasActions: {
            toggleTheme: true,
            export: {
              onExportToBackend,
              renderCustomUI:
                !isVaultMode && excalidrawAPI
                  ? (elements, appState, files) => {
                      return (
                        <ExportToExcalidrawPlus
                          elements={elements}
                          appState={appState}
                          files={files}
                          name={excalidrawAPI.getName()}
                          onError={(error) => {
                            excalidrawAPI?.updateScene({
                              appState: {
                                errorMessage: error.message,
                              },
                            });
                          }}
                          onSuccess={() => {
                            excalidrawAPI.updateScene({
                              appState: { openDialog: null },
                            });
                          }}
                        />
                      );
                    }
                  : undefined,
            },
          },
        }}
        langCode={langCode}
        renderCustomStats={renderCustomStats}
        renderCustomContextMenuItems={renderInputInviteContextMenuItems}
        detectScroll={false}
        handleKeyboardGlobally={true}
        autoFocus={true}
        theme={editorTheme}
        onThemeChange={setAppTheme}
        renderTopRightUI={(isMobile) => {
          const canManageVault =
            activeVault?.session.role === "editor" &&
            !["revoked", "expired", "closed"].includes(activeVault.syncStatus);
          const showCollaborationControls =
            !isMobile && !!collabAPI && !isCollabDisabled;

          if (
            !activeVault &&
            !(vaultV2Session && vaultV2UiState) &&
            !showCollaborationControls
          ) {
            return null;
          }

          return (
            <div className="excalidraw-ui-top-right">
              {vaultV2Session && vaultV2UiState && (
                <div className="VaultStatusControls">
                  <VaultV2Status
                    role={vaultV2Session.role}
                    state={vaultV2UiState}
                    onShowConflicts={showVaultV2Conflicts}
                  />
                  {canManageVaultV2 && (
                    <Button
                      className="VaultStatusControls__share"
                      onSelect={() => setIsVaultV2ShareDialogOpen(true)}
                    >
                      {t("vault.share.manage")}
                    </Button>
                  )}
                </div>
              )}
              {canManageVaultV2 && vaultV2ShareTarget && (
                <VaultShareDialog
                  open={isVaultV2ShareDialogOpen}
                  onClose={() => setIsVaultV2ShareDialogOpen(false)}
                  activeVault={vaultV2ShareTarget}
                />
              )}
              {activeVault && (
                <div className="VaultStatusControls">
                  <VaultStatus
                    role={activeVault.session.role}
                    syncStatus={activeVault.syncStatus}
                    autosaveErrorCode={activeVault.autosaveErrorCode}
                    autosaveUnsyncedReason={activeVault.autosaveUnsyncedReason}
                    autosaveLocalPersistence={
                      activeVault.autosaveLocalPersistence
                    }
                    autosaveBeforeUnloadState={
                      activeVault.autosaveBeforeUnloadState
                    }
                    recoveryState={vaultRecoveryState ?? undefined}
                    realtimeLostReason={activeVault.realtimeLostReason}
                    realtimeLostCode={activeVault.realtimeLostCode}
                    attachmentPending={activeVault.attachmentPending}
                    attachmentFailed={activeVault.attachmentFailed}
                    onReviewConflict={() => setIsVaultConflictDialogOpen(true)}
                  />
                  <VaultManagedAI excalidrawAPI={excalidrawAPI} />
                  {isVaultV2Enabled() && excalidrawAPI && (
                    <VaultMigrationControl
                      key={activeVault.session.vaultId}
                      role={activeVault.session.role}
                      api={createVaultMigrationApi(activeVault, excalidrawAPI)}
                    />
                  )}
                  {canManageVault && (
                    <Button
                      className="VaultStatusControls__share"
                      onSelect={() => setIsVaultShareDialogOpen(true)}
                    >
                      {t("vault.share.manage")}
                    </Button>
                  )}
                </div>
              )}
              {canManageVault && activeVault && (
                <VaultShareDialog
                  open={isVaultShareDialogOpen}
                  onClose={() => setIsVaultShareDialogOpen(false)}
                  activeVault={activeVault}
                />
              )}
              {activeVault && (
                <VaultConflictDialog
                  open={isVaultConflictDialogOpen}
                  conflict={vaultConflictInfo}
                  onClose={() => setIsVaultConflictDialogOpen(false)}
                  onExportLocal={exportVaultLocalCopy}
                />
              )}
              {showCollaborationControls && (
                <>
                  {excalidrawAPI?.getEditorInterface().formFactor ===
                    "desktop" && (
                    <ExcalidrawPlusPromoBanner
                      isSignedIn={isExcalidrawPlusSignedUser}
                    />
                  )}
                  {collabError.message && (
                    <CollabError collabError={collabError} />
                  )}
                  <LiveCollaborationTrigger
                    isCollaborating={isCollaborating}
                    onSelect={() =>
                      setShareDialogState({ isOpen: true, type: "share" })
                    }
                    editorInterface={editorInterface}
                  />
                </>
              )}
            </div>
          );
        }}
        onLinkOpen={(element, event) => {
          if (element.link && isElementLink(element.link)) {
            event.preventDefault();
            excalidrawAPI?.scrollToContent(element.link, { animate: true });
          }
        }}
      >
        <AppMainMenu
          onCollabDialogOpen={onCollabDialogOpen}
          isCollaborating={isCollaborating}
          isCollabEnabled={!isCollabDisabled}
          theme={appTheme}
          refresh={refreshApp}
          onCloudAccountOpen={() => setIsCloudAccountOpen(true)}
          onSingleFileDialogOpen={() => setIsSingleFileDialogOpen(true)}
          onEmbedOpen={({ mode, preset }) => {
            if (!excalidrawAPI) {
              return;
            }
            const instanceId = `menu-${Date.now()}`;
            const embedWindow = window.open(
              `/embed?instanceId=${encodeURIComponent(
                instanceId,
              )}&parentOrigin=${encodeURIComponent(
                window.location.origin,
              )}&mode=${mode}&preset=${preset}&lang=${encodeURIComponent(
                langCode,
              )}`,
              "_blank",
            );
            if (!embedWindow) {
              return;
            }
            const handleReady = (event: MessageEvent) => {
              if (
                event.source !== embedWindow ||
                event.origin !== window.location.origin ||
                event.data?.channel !== "excalidraw-embed" ||
                event.data?.kind !== "event" ||
                event.data?.name !== "ready" ||
                event.data?.instanceId !== instanceId
              ) {
                return;
              }
              window.removeEventListener("message", handleReady);
              embedWindow.postMessage(
                {
                  channel: "excalidraw-embed",
                  protocolVersion: 1,
                  instanceId,
                  requestId: `menu-load-${Date.now()}`,
                  kind: "command",
                  name: "loadScene",
                  payload: {
                    source: {
                      type: "scene",
                      scene: {
                        elements: excalidrawAPI.getSceneElements(),
                        appState: excalidrawAPI.getAppState(),
                        files: excalidrawAPI.getFiles(),
                      },
                    },
                  },
                },
                window.location.origin,
              );
            };
            window.addEventListener("message", handleReady);
          }}
          externalFeaturesDisabled={isVaultMode}
          manyMindsPersistenceScopeId={aiWorkbenchPersistenceScopeId}
          excalidrawAPI={excalidrawAPI}
          activeCloudScene={activeCloudScene}
          langCode={langCode}
        />
        <SingleFileDialog
          open={isSingleFileDialogOpen}
          onClose={() => setIsSingleFileDialogOpen(false)}
          excalidrawAPI={excalidrawAPI}
          langCode={langCode}
        />
        <AuthDialog
          open={isCloudAccountOpen}
          onClose={() => setIsCloudAccountOpen(false)}
          onSignedIn={() => setIsCloudSceneListOpen(true)}
          onOpenCloudScenes={() => {
            setIsCloudAccountOpen(false);
            setIsCloudSceneListOpen(true);
          }}
          onOpenAITasks={() => {
            setIsCloudAccountOpen(false);
            setIsCloudAITaskListOpen(true);
          }}
          onOpenEmbeds={() => {
            if (!activeCloudScene) {
              return;
            }
            setIsCloudAccountOpen(false);
            setEmbedListScene({
              id: activeCloudScene.id,
              title: activeCloudScene.title,
              version: activeCloudScene.version,
              updatedAt: activeCloudScene.updatedAt,
            });
            setEmbedListBackTarget("account");
            setIsCloudEmbedListOpen(true);
          }}
          onSaveCloudScene={async () => {
            await saveCurrentSceneToCloud();
          }}
          onSaveEncryptedCloudScene={async () => {
            await saveCurrentSceneAsEncryptedCloudScene();
          }}
          onStartCollabRoom={(room) => {
            if (!collabAPI) {
              throw new Error(t("cloud.collabRooms.genericError"));
            }
            if (collabAPI.isCollaborating()) {
              return;
            }
            if (
              excalidrawAPI?.getSceneElements().some(hasAIVideoGenerationMarker)
            ) {
              excalidrawAPI.setToast({
                message: t("ai.workbench.videoAssetCollabBlocked"),
              });
              return;
            }
            void collabAPI.startCollaboration(room, {
              preserveLocalScene: true,
            });
          }}
          collabRoomRefreshKey={collabRoomRefreshKey}
          onCollabRoomChanged={notifyCollabRoomChanged}
          onCollabRoomRevoked={stopCurrentCollabRoomIfRevoked}
          activeCloudScene={activeCloudScene}
          isCollaborationActive={isCollaborating}
          cloudSceneRemoteUpdate={cloudSceneRemoteUpdate}
          onCheckCurrentCloudScene={async () => {
            await checkActiveCloudSceneRemoteUpdate();
          }}
          onRefreshCurrentCloudScene={refreshActiveCloudSceneFromRemote}
        />
        <SceneListDialog
          open={isCloudSceneListOpen}
          activeSceneId={activeCloudScene?.id ?? null}
          onClose={() => setIsCloudSceneListOpen(false)}
          onBack={() => {
            setIsCloudSceneListOpen(false);
            setIsCloudAccountOpen(true);
          }}
          onOpenScene={onOpenCloudScene}
          onOpenEmbeds={(scene) => {
            setIsCloudSceneListOpen(false);
            setEmbedListScene(scene);
            setEmbedListBackTarget("scenes");
            setIsCloudEmbedListOpen(true);
          }}
        />
        <EmbedListDialog
          open={isCloudEmbedListOpen}
          scene={embedListScene}
          onClose={() => {
            setIsCloudEmbedListOpen(false);
            setEmbedListScene(null);
          }}
          onBack={() => {
            setIsCloudEmbedListOpen(false);
            if (embedListBackTarget === "account") {
              setIsCloudAccountOpen(true);
            } else {
              setIsCloudSceneListOpen(true);
            }
          }}
        />
        <AITaskListDialog
          open={isCloudAITaskListOpen}
          onClose={() => setIsCloudAITaskListOpen(false)}
          onBack={() => {
            setIsCloudAITaskListOpen(false);
            setIsCloudAccountOpen(true);
          }}
          onOpenScene={onOpenCloudScene}
        />
        <AppWelcomeScreen
          onCollabDialogOpen={onCollabDialogOpen}
          isCollabEnabled={!isCollabDisabled}
        />
        <ConfirmHost />
        <OverwriteConfirmDialog>
          <OverwriteConfirmDialog.Actions.ExportToImage />
          <OverwriteConfirmDialog.Actions.SaveToDisk />
          {excalidrawAPI && !isVaultMode && (
            <OverwriteConfirmDialog.Action
              title={t("overwriteConfirm.action.excalidrawPlus.title")}
              actionLabel={t("overwriteConfirm.action.excalidrawPlus.button")}
              onClick={() => {
                exportToExcalidrawPlus(
                  excalidrawAPI.getSceneElements(),
                  excalidrawAPI.getAppState(),
                  excalidrawAPI.getFiles(),
                  excalidrawAPI.getName(),
                );
              }}
            >
              {t("overwriteConfirm.action.excalidrawPlus.description")}
            </OverwriteConfirmDialog.Action>
          )}
        </OverwriteConfirmDialog>
        <AppFooter
          onChange={() => excalidrawAPI?.refresh()}
          excalidrawAPI={excalidrawAPI}
        />
        {excalidrawAPI && !isVaultMode && (
          <AIComponents excalidrawAPI={excalidrawAPI} />
        )}

        {!isVaultMode && <TTDDialogTrigger />}
        {isCollaborating && isOffline && (
          <div className="alertalert--warning">
            {t("alerts.collabOfflineWarning")}
          </div>
        )}
        {localStorageQuotaExceeded && (
          <div className="alert alert--danger">
            {t("alerts.localStorageQuotaExceeded")}
          </div>
        )}
        {latestShareableLink && (
          <ShareableLinkDialog
            link={latestShareableLink}
            onCloseRequest={() => setLatestShareableLink(null)}
            setErrorMessage={setErrorMessage}
          />
        )}
        {excalidrawAPI && !isCollabDisabled && (
          <Collab excalidrawAPI={excalidrawAPI} />
        )}

        <ShareDialog
          activeCloudScene={activeCloudScene}
          collabAPI={collabAPI}
          onExportToBackend={async () => {
            if (excalidrawAPI) {
              try {
                await onExportToBackend(
                  excalidrawAPI.getSceneElements(),
                  excalidrawAPI.getAppState(),
                  excalidrawAPI.getFiles(),
                );
              } catch (error: any) {
                setErrorMessage(error.message);
              }
            }
          }}
          onSaveCloudScene={async () => {
            await saveCurrentSceneToCloud();
          }}
          onStartCollabRoom={async (room) => {
            if (!collabAPI) {
              throw new Error(t("cloud.collabRooms.genericError"));
            }
            if (collabAPI.isCollaborating()) {
              return;
            }
            if (
              excalidrawAPI?.getSceneElements().some(hasAIVideoGenerationMarker)
            ) {
              excalidrawAPI.setToast({
                message: t("ai.workbench.videoAssetCollabBlocked"),
              });
              return;
            }
            await collabAPI.startCollaboration(room, {
              preserveLocalScene: true,
            });
          }}
          collabRoomRefreshKey={collabRoomRefreshKey}
          onCollabRoomChanged={notifyCollabRoomChanged}
          onCollabRoomRevoked={stopCurrentCollabRoomIfRevoked}
        />

        {!isVaultMode && (
          <AppSidebar
            excalidrawAPI={excalidrawAPI}
            persistenceScopeId={aiWorkbenchPersistenceScopeId}
            referenceAddRequest={aiReferenceAddRequest}
            assistantSkillRequest={assistantSkillRequest}
            promptTemplateRequest={promptTemplateRequest}
            generationLogReuseRequest={generationLogReuseRequest}
            onAddSelectionAsReference={requestAIReferenceAdd}
            onEnterMaskEditing={requestEnterMaskEditing}
            onMaskReady={registerWorkbenchMaskReadyHandler}
            onCloudAITaskRun={recordActiveCloudAITask}
            onPersistVideoOutput={persistActiveCloudVideoOutput}
          />
        )}

        {errorMessage && (
          <ErrorDialog onClose={() => setErrorMessage("")}>
            {errorMessage}
          </ErrorDialog>
        )}

        <CommandPalette
          customCommandPaletteItems={[
            ...(isVaultMode
              ? []
              : [
                  ...coreAIWorkflowCommands,
                  ...aiPromptTemplateCommands,
                  ...aiSkillCommands,
                  ...aiGenerationLogCommands,
                  ...aiSettingsCommands,
                ]),
            ...officeWorkflowCommands,
            {
              label: t("roomDialog.button_stopSession"),
              category: DEFAULT_CATEGORIES.app,
              predicate: () => !!collabAPI?.isCollaborating(),
              keywords: [
                "stop",
                "session",
                "end",
                "leave",
                "close",
                "exit",
                "collaboration",
              ],
              perform: () => {
                if (collabAPI) {
                  collabAPI.stopCollaboration();
                  if (!collabAPI.isCollaborating()) {
                    setShareDialogState({ isOpen: false });
                  }
                }
              },
            },
            {
              label: "GitHub",
              icon: GithubIcon,
              category: DEFAULT_CATEGORIES.links,
              predicate: true,
              keywords: [
                "issues",
                "bugs",
                "requests",
                "report",
                "features",
                "social",
                "community",
              ],
              perform: () => {
                window.open(
                  "https://github.com/excalidraw/excalidraw",
                  "_blank",
                  "noopener noreferrer",
                );
              },
            },
            {
              label: t("labels.followUs"),
              icon: XBrandIcon,
              category: DEFAULT_CATEGORIES.links,
              predicate: true,
              keywords: ["twitter", "contact", "social", "community"],
              perform: () => {
                window.open(
                  "https://x.com/excalidraw",
                  "_blank",
                  "noopener noreferrer",
                );
              },
            },
            {
              label: t("labels.discordChat"),
              category: DEFAULT_CATEGORIES.links,
              predicate: true,
              icon: DiscordIcon,
              keywords: [
                "chat",
                "talk",
                "contact",
                "bugs",
                "requests",
                "report",
                "feedback",
                "suggestions",
                "social",
                "community",
              ],
              perform: () => {
                window.open(
                  "https://discord.gg/UexuTaE",
                  "_blank",
                  "noopener noreferrer",
                );
              },
            },
            {
              label: "YouTube",
              icon: youtubeIcon,
              category: DEFAULT_CATEGORIES.links,
              predicate: true,
              keywords: ["features", "tutorials", "howto", "help", "community"],
              perform: () => {
                window.open(
                  "https://youtube.com/@excalidraw",
                  "_blank",
                  "noopener noreferrer",
                );
              },
            },
            ...(isExcalidrawPlusSignedUser
              ? [
                  {
                    ...ExcalidrawPlusAppCommand,
                    label: "Sign in / Go to Excalidraw+",
                  },
                ]
              : [ExcalidrawPlusCommand, ExcalidrawPlusAppCommand]),

            {
              label: t("overwriteConfirm.action.excalidrawPlus.button"),
              category: DEFAULT_CATEGORIES.export,
              icon: exportToPlus,
              predicate: true,
              keywords: ["plus", "export", "save", "backup"],
              perform: () => {
                if (excalidrawAPI) {
                  exportToExcalidrawPlus(
                    excalidrawAPI.getSceneElements(),
                    excalidrawAPI.getAppState(),
                    excalidrawAPI.getFiles(),
                    excalidrawAPI.getName(),
                  );
                }
              },
            },
            {
              label: t("labels.installPWA"),
              category: DEFAULT_CATEGORIES.app,
              predicate: () => !!pwaEvent,
              perform: () => {
                if (pwaEvent) {
                  pwaEvent.prompt();
                  pwaEvent.userChoice.then(() => {
                    // event cannot be reused, but we'll hopefully
                    // grab new one as the event should be fired again
                    pwaEvent = null;
                  });
                }
              },
            },
          ]}
        />
        {isVisualDebuggerEnabled() && excalidrawAPI && (
          <DebugCanvas
            appState={excalidrawAPI.getAppState()}
            scale={window.devicePixelRatio}
            ref={debugCanvasRef}
          />
        )}
      </Excalidraw>
      <AIMaskEditingController
        ref={maskEditingControllerRef}
        excalidrawAPI={excalidrawAPI}
        onMaskReady={handleMaskReady}
      />
    </div>
  );
};

const LazyEmbedApp = lazy(() => import("./embed/EmbedApp"));

const ExcalidrawApp = () => {
  if (window.location.pathname === "/ai-device") {
    return (
      <TopErrorBoundary>
        <Provider store={appJotaiStore}>
          <AIDeviceApproval />
        </Provider>
      </TopErrorBoundary>
    );
  }

  if (window.location.pathname === "/embed") {
    return (
      <TopErrorBoundary>
        <Provider store={appJotaiStore}>
          <Suspense fallback={null}>
            <LazyEmbedApp />
          </Suspense>
        </Provider>
      </TopErrorBoundary>
    );
  }

  const isCloudExportWindow =
    window.location.pathname === "/excalidraw-plus-export";
  if (isCloudExportWindow) {
    return <ExcalidrawPlusIframeExport />;
  }

  return (
    <TopErrorBoundary>
      <Provider store={appJotaiStore}>
        <ExcalidrawAPIProvider>
          <ExcalidrawWrapper />
        </ExcalidrawAPIProvider>
      </Provider>
    </TopErrorBoundary>
  );
};

export default ExcalidrawApp;
