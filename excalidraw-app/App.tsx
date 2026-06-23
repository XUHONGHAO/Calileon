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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { isInitializedImageElement } from "@excalidraw/element";
import clsx from "clsx";
import {
  parseLibraryTokensFromUrl,
  useHandleLibrary,
} from "@excalidraw/excalidraw/data/library";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  FileId,
  ExcalidrawFreeDrawElement,
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
import { AppWelcomeScreen } from "./components/AppWelcomeScreen";
import { AITaskListDialog } from "./components/AITaskListDialog";
import { AuthDialog } from "./components/AuthDialog";
import { SceneListDialog } from "./components/SceneListDialog";
import {
  ExportToExcalidrawPlus,
  exportToExcalidrawPlus,
} from "./components/ExportToExcalidrawPlus";
import { TopErrorBoundary } from "./components/TopErrorBoundary";
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

import { localStore, shareLink, firebaseStore } from "./data/cloud";
import { getCloudBackend } from "./data/cloud";
import {
  loadAssetRefsForElements,
  loadSceneAssets,
  uploadSceneAssets,
  uploadSharedSceneAssets,
} from "./data/cloud/cloudAssets";
import { recordCloudAITask } from "./data/cloud/cloudAITasks";
import { getCloudShareTokenFromUrl } from "./data/cloud/cloudShareLinks";
import {
  getCloudSceneFingerprint,
  getCloudPayloadHash,
  loadCloudSceneBinding,
  saveCloudSceneBinding,
} from "./data/cloud/sceneBinding";

import { updateStaleImageStatuses } from "./data/FileManager";
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
import type { SceneRecord } from "./data/cloud";
import type { CloudAITaskRun } from "./data/cloud/cloudAITasks";

polyfill();

const CLOUD_AUTOSAVE_DEBOUNCE_MS = 3000;
const CLOUD_BINDING_SYNC_DEBOUNCE_MS = 500;

type ActiveCloudScene = {
  id: string;
  ownerId: string;
  title: string;
  version: number;
  createdAt: number;
  updatedAt: number;
};

type ActiveSharedScene = ActiveCloudScene & {
  token: string;
  mode: "read" | "write";
};

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

const initializeScene = async (opts: {
  collabAPI: CollabAPI | null;
  excalidrawAPI: ExcalidrawImperativeAPI;
}): Promise<
  {
    scene: ExcalidrawInitialDataState | null;
    activeSharedScene?: ActiveSharedScene | null;
    isCloudShareScene?: boolean;
  } & (
    | { isExternalScene: true; id: string; key: string }
    | { isExternalScene: false; id?: null; key?: null }
  )
> => {
  const searchParams = new URLSearchParams(window.location.search);
  const id = searchParams.get("id");
  const jsonBackendMatch = window.location.hash.match(
    /^#json=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/,
  );
  const externalUrlMatch = window.location.hash.match(/^#url=(.*)$/);
  const cloudShareToken = getCloudShareTokenFromUrl(window.location.href);

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
  let isCloudShareScene = false;
  const isExternalScene = !!(
    id ||
    jsonBackendMatch ||
    roomLinkData ||
    cloudShareToken
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
      if (cloudShareToken) {
        try {
          const shared = await getCloudBackend().shares.loadScene(
            cloudShareToken,
          );
          const payload = shared.scene.payload as {
            elements?: any;
            appState?: any;
          };
          const restoredElements = restoreElements(
            payload.elements ?? null,
            null,
            {
              repairBindings: true,
              deleteInvisibleElements: true,
            },
          );
          const assetResult = await loadAssetRefsForElements({
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
            version: shared.scene.version,
            createdAt: shared.scene.createdAt,
            updatedAt: shared.scene.updatedAt,
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
      }
      scene.scrollToContent = true;
      if (!roomLinkData && !cloudShareToken) {
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
        return { scene: data, isExternalScene };
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

    return isExternalScene && jsonBackendMatch
      ? {
          scene,
          isExternalScene,
          id: jsonBackendMatch[1],
          key: jsonBackendMatch[2],
        }
      : { scene, isExternalScene: false, activeSharedScene: null };
  }
  return { scene: null, isExternalScene: false, activeSharedScene: null };
};

const ExcalidrawWrapper = () => {
  const excalidrawAPI = useExcalidrawAPI();

  const [errorMessage, setErrorMessage] = useState("");
  const [isCloudAccountOpen, setIsCloudAccountOpen] = useState(false);
  const [isCloudSceneListOpen, setIsCloudSceneListOpen] = useState(false);
  const [isCloudAITaskListOpen, setIsCloudAITaskListOpen] = useState(false);
  const cloudAuth = useCloudAuth();
  const [activeCloudScene, setActiveCloudScene] =
    useState<ActiveCloudScene | null>(null);
  const activeCloudSceneRef = useRef<ActiveCloudScene | null>(null);
  const [activeSharedScene, setActiveSharedScene] =
    useState<ActiveSharedScene | null>(null);
  const activeSharedSceneRef = useRef<ActiveSharedScene | null>(null);
  const lastCloudLocalPayloadHashRef = useRef<string | null>(null);
  const lastCloudSavedPayloadHashRef = useRef<string | null>(null);
  const lastSharedSavedPayloadHashRef = useRef<string | null>(null);
  const cloudAutosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const cloudBindingSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const cloudSaveInFlightRef = useRef(false);
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
    if (cloudAuth.isSignedIn) {
      return;
    }

    setActiveCloudScene(null);
    activeCloudSceneRef.current = null;
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
  const [isCollaborating] = useAtomWithInitialValue(isCollaboratingAtom, () => {
    return isCollaborationLink(window.location.href);
  });
  const collabError = useAtomValue(collabErrorIndicatorAtom);

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
        const fileIds =
          data.scene.elements?.reduce((acc, element) => {
            if (isInitializedImageElement(element)) {
              return acc.concat(element.fileId);
            }
            return acc;
          }, [] as FileId[]) || [];

        if (data.isExternalScene && !data.isCloudShareScene) {
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
      setActiveSharedScene(data.activeSharedScene ?? null);
      activeSharedSceneRef.current = data.activeSharedScene ?? null;
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
      loadImages(data, /* isInitialLoad */ true);
      initialStatePromiseRef.current.promise.resolve(data.scene);
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
        excalidrawAPI.updateScene({ appState: { isLoading: true } });

        initializeScene({ collabAPI, excalidrawAPI }).then((data) => {
          setActiveSharedScene(data.activeSharedScene ?? null);
          activeSharedSceneRef.current = data.activeSharedScene ?? null;
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
        });
      }
    };

    const syncData = debounce(() => {
      if (isTestEnv()) {
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
                isInitializedImageElement(element) &&
                // only load and update images that aren't already loaded
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
      LocalData.flushSave();
    };

    const visibilityChange = (event: FocusEvent | Event) => {
      if (event.type === EVENT.BLUR || document.hidden) {
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
    window.addEventListener(EVENT.BLUR, visibilityChange, false);
    document.addEventListener(EVENT.VISIBILITY_CHANGE, visibilityChange, false);
    window.addEventListener(EVENT.FOCUS, visibilityChange, false);
    return () => {
      window.removeEventListener(EVENT.HASHCHANGE, onHashChange, false);
      window.removeEventListener(EVENT.UNLOAD, onUnload, false);
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
  ]);

  useEffect(() => {
    const unloadHandler = (event: BeforeUnloadEvent) => {
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

        if (silent && payloadHash === lastCloudSavedPayloadHashRef.current) {
          return false;
        }

        if (activeScene?.id && checkRemoteVersion) {
          const remoteScene = await backend.scenes.load(activeScene.id);
          if (remoteScene.version > activeScene.version) {
            if (
              silent ||
              !window.confirm(t("cloud.scenes.remoteNewerConfirm"))
            ) {
              excalidrawAPI.setToast({
                message: t("cloud.scenes.remoteNewer"),
              });
              return false;
            }
          }
        }

        const now = Date.now();
        const title = excalidrawAPI.getName() || t("labels.untitled");
        const result = await backend.scenes.save({
          id: activeScene?.id ?? null,
          ownerId: cloudAuth.user.id,
          title,
          payloadKind: "plain",
          payload: JSON.parse(serializedPayload),
          version: activeScene?.version ?? 0,
          createdAt: activeScene?.createdAt ?? now,
          updatedAt: now,
          deletedAt: null,
        });

        let didSyncAssets = true;
        try {
          await uploadSceneAssets({
            backend,
            sceneId: result.id,
            elements,
            files,
          });
        } catch (error) {
          didSyncAssets = false;
          console.warn(error);
        }

        const nextActiveScene: ActiveCloudScene = {
          id: result.id,
          ownerId: cloudAuth.user.id,
          title,
          version: result.version,
          createdAt: activeScene?.createdAt ?? now,
          updatedAt: now,
        };

        setActiveCloudScene(nextActiveScene);
        activeCloudSceneRef.current = nextActiveScene;
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
        if (silent && payloadHash === lastSharedSavedPayloadHashRef.current) {
          return false;
        }

        const now = Date.now();
        const title = excalidrawAPI.getName() || activeScene.title;
        const result = await backend.shares.saveScene(activeScene.token, {
          id: activeScene.id,
          ownerId: activeScene.ownerId,
          title,
          payloadKind: "plain",
          payload: JSON.parse(serializedPayload),
          version: activeScene.version,
          createdAt: activeScene.createdAt,
          updatedAt: now,
          deletedAt: null,
        });

        let didSyncAssets = true;
        try {
          await uploadSharedSceneAssets({
            shares: backend.shares,
            token: activeScene.token,
            sceneId: result.id,
            elements,
            files,
          });
        } catch (error) {
          didSyncAssets = false;
          console.warn(error);
        }

        const nextActiveScene: ActiveSharedScene = {
          ...activeScene,
          title,
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
    const canSaveAccount =
      !!activeCloudSceneRef.current?.id &&
      cloudAuth.isAuthAvailable &&
      cloudAuth.isSignedIn &&
      !!cloudAuth.user;

    if (
      (!canSaveShared && !canSaveAccount) ||
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
        activeSharedSceneRef.current?.mode === "write"
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
    saveCurrentSharedSceneToCloud,
  ]);

  const onChange = (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    if (collabAPI?.isCollaborating()) {
      collabAPI.syncElements(elements);
    }

    // this check is redundant, but since this is a hot path, it's best
    // not to evaludate the nested expression every time
    if (!LocalData.isSavePaused()) {
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

    scheduleCloudBindingSync(elements, appState, files);
    scheduleCloudAutosave();

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
    if (exportedElements.length === 0) {
      throw new Error(t("alerts.cannotExportEmptyCanvas"));
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

      const payload = record.payload as {
        elements?: any;
        appState?: any;
      };

      if (collabAPI?.isCollaborating()) {
        collabAPI.stopCollaboration(false);
      }
      setActiveSharedScene(null);
      activeSharedSceneRef.current = null;
      lastSharedSavedPayloadHashRef.current = null;

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
          const assetResult = await loadSceneAssets({
            backend: getCloudBackend(),
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
          version: record.version,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        };
        setActiveCloudScene(nextActiveScene);
        activeCloudSceneRef.current = nextActiveScene;
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
      excalidrawAPI?.toggleSidebar({
        name: DEFAULT_SIDEBAR.name,
        tab,
        force: true,
      });
    },
    [excalidrawAPI],
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
  }, [requestAIReferenceAdd]);

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
      if (pending === 0) {
        return;
      }

      // Yield initial progress
      yield {
        type: "progress",
        progress: (total - pending) / total,
        message: `Loading images (${total - pending}/${total})...`,
      };

      // Wait for all pending images to finish
      while (true) {
        snapshot = await FileStatusStore.pull(snapshot.version);
        const { pending: nowPending, total: nowTotal } =
          FileStatusStore.getPendingCount(snapshot.value);

        yield {
          type: "progress",
          progress: (nowTotal - nowPending) / nowTotal,
          message: `Loading images (${nowTotal - nowPending}/${nowTotal})...`,
        };

        if (nowPending === 0) {
          await new Promise((r) => setTimeout(r, 500));
          yield {
            type: "progress",
            message: `Preparing export...`,
          };
          return;
        }
      }
    },
    [],
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
        onChange={onChange}
        onExport={onExport}
        initialData={initialStatePromiseRef.current.promise}
        isCollaborating={isCollaborating}
        onPointerUpdate={collabAPI?.onPointerUpdate}
        UIOptions={{
          canvasActions: {
            toggleTheme: true,
            export: {
              onExportToBackend,
              renderCustomUI: excalidrawAPI
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
          if (isMobile || !collabAPI || isCollabDisabled) {
            return null;
          }

          return (
            <div className="excalidraw-ui-top-right">
              {excalidrawAPI?.getEditorInterface().formFactor === "desktop" && (
                <ExcalidrawPlusPromoBanner
                  isSignedIn={isExcalidrawPlusSignedUser}
                />
              )}

              {collabError.message && <CollabError collabError={collabError} />}
              <LiveCollaborationTrigger
                isCollaborating={isCollaborating}
                onSelect={() =>
                  setShareDialogState({ isOpen: true, type: "share" })
                }
                editorInterface={editorInterface}
              />
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
          onSaveCloudScene={async () => {
            await saveCurrentSceneToCloud();
          }}
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
        <OverwriteConfirmDialog>
          <OverwriteConfirmDialog.Actions.ExportToImage />
          <OverwriteConfirmDialog.Actions.SaveToDisk />
          {excalidrawAPI && (
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
        <AppFooter onChange={() => excalidrawAPI?.refresh()} />
        {excalidrawAPI && <AIComponents excalidrawAPI={excalidrawAPI} />}

        <TTDDialogTrigger />
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
        />

        <AppSidebar
          excalidrawAPI={excalidrawAPI}
          referenceAddRequest={aiReferenceAddRequest}
          assistantSkillRequest={assistantSkillRequest}
          promptTemplateRequest={promptTemplateRequest}
          generationLogReuseRequest={generationLogReuseRequest}
          onAddSelectionAsReference={requestAIReferenceAdd}
          onEnterMaskEditing={requestEnterMaskEditing}
          onMaskReady={registerWorkbenchMaskReadyHandler}
          onCloudAITaskRun={recordActiveCloudAITask}
        />

        {errorMessage && (
          <ErrorDialog onClose={() => setErrorMessage("")}>
            {errorMessage}
          </ErrorDialog>
        )}

        <CommandPalette
          customCommandPaletteItems={[
            ...coreAIWorkflowCommands,
            ...aiPromptTemplateCommands,
            ...aiSkillCommands,
            ...aiGenerationLogCommands,
            ...aiSettingsCommands,
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

const ExcalidrawApp = () => {
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
