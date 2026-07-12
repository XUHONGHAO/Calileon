import { STORAGE_KEYS } from "../app_constants";

type ActiveSceneIdentity = {
  id: string | null | undefined;
};

type ActiveCollaborationIdentity = {
  roomId: string | null | undefined;
};

export type AIWorkbenchPersistenceScopeContext = {
  activeEmbeddedScene?: ActiveSceneIdentity | null;
  activeSharedScene?: ActiveSceneIdentity | null;
  activeCloudScene?: ActiveSceneIdentity | null;
  activeCollaboration?: ActiveCollaborationIdentity | null;
  localDocumentId: string;
};

export type LegacyAIWorkbenchScopeInput = {
  pathname: string;
  search: string;
  sceneName?: string | null;
};

export type AIWorkbenchLocalDocumentLifecycleContext = {
  hasActiveEmbeddedScene: boolean;
  hasActiveSharedScene: boolean;
  hasActiveCloudScene: boolean;
  isCollaborating: boolean;
};

let fallbackLocalDocumentId: string | null = null;

const readIdentity = (value: string | null | undefined) => value?.trim() || "";

const createLocalDocumentId = () => {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

export const getOrCreateLocalDocumentId = (options?: {
  storage?: Pick<Storage, "getItem" | "setItem">;
  createId?: () => string;
}) => {
  const storage = options?.storage || window.localStorage;
  const createId = options?.createId || createLocalDocumentId;
  let generatedId = "";

  try {
    const storedId = readIdentity(
      storage.getItem(
        STORAGE_KEYS.LOCAL_STORAGE_AI_WORKBENCH_LOCAL_DOCUMENT_ID,
      ),
    );
    if (storedId) {
      return storedId;
    }

    generatedId = fallbackLocalDocumentId || readIdentity(createId());
    if (!generatedId) {
      throw new Error("Could not create a local document id.");
    }

    storage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_AI_WORKBENCH_LOCAL_DOCUMENT_ID,
      generatedId,
    );
    return generatedId;
  } catch {
    fallbackLocalDocumentId ||=
      generatedId || readIdentity(createId()) || "local-document";
    return fallbackLocalDocumentId;
  }
};

export const rotateLocalDocumentId = (options?: {
  storage?: Pick<Storage, "setItem">;
  createId?: () => string;
}) => {
  const storage = options?.storage || window.localStorage;
  const createId = options?.createId || createLocalDocumentId;
  const nextId = readIdentity(createId());

  if (!nextId) {
    throw new Error("Could not create a local document id.");
  }

  // Keep the in-memory identity in sync even when localStorage is unavailable.
  // This prevents a failed write from falling back to the previous document's
  // scope for the remainder of the session.
  fallbackLocalDocumentId = nextId;

  try {
    storage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_AI_WORKBENCH_LOCAL_DOCUMENT_ID,
      nextId,
    );
  } catch {
    // The caller still receives a session-stable replacement identity.
  }

  return nextId;
};

export const shouldRotateLocalDocumentId = ({
  hasActiveEmbeddedScene,
  hasActiveSharedScene,
  hasActiveCloudScene,
  isCollaborating,
}: AIWorkbenchLocalDocumentLifecycleContext) =>
  !hasActiveEmbeddedScene &&
  !hasActiveSharedScene &&
  !hasActiveCloudScene &&
  !isCollaborating;

export const resolveAIWorkbenchPersistenceScope = ({
  activeEmbeddedScene,
  activeSharedScene,
  activeCloudScene,
  activeCollaboration,
  localDocumentId,
}: AIWorkbenchPersistenceScopeContext): string | null => {
  if (activeEmbeddedScene) {
    const sceneId = readIdentity(activeEmbeddedScene.id);
    return sceneId ? `embed:${sceneId}` : null;
  }

  if (activeSharedScene) {
    const sceneId = readIdentity(activeSharedScene.id);
    return sceneId ? `share:${sceneId}` : null;
  }

  if (activeCloudScene) {
    const sceneId = readIdentity(activeCloudScene.id);
    return sceneId ? `cloud:${sceneId}` : null;
  }

  if (activeCollaboration) {
    const roomId = readIdentity(activeCollaboration.roomId);
    return roomId ? `collab:${roomId}` : null;
  }

  const stableLocalDocumentId = readIdentity(localDocumentId);
  return stableLocalDocumentId ? `local:${stableLocalDocumentId}` : null;
};

export const getAIWorkbenchReferenceManifestKey = (scopeId: string) =>
  `${
    STORAGE_KEYS.LOCAL_STORAGE_AI_WORKBENCH_REFERENCE_MANIFEST_PREFIX
  }${encodeURIComponent(scopeId)}`;

export const getAIWorkbenchMaskManifestKey = (scopeId: string) =>
  `${
    STORAGE_KEYS.LOCAL_STORAGE_AI_WORKBENCH_MASK_MANIFEST_PREFIX
  }${encodeURIComponent(scopeId)}`;

export const createLegacyAIWorkbenchScope = ({
  pathname,
  search,
  sceneName,
}: LegacyAIWorkbenchScopeInput) =>
  `${pathname}${search}:${sceneName?.trim() || "default"}`;

export const getLegacyAIWorkbenchReferenceKey = (
  input: LegacyAIWorkbenchScopeInput,
) =>
  `ai-reference-images-${encodeURIComponent(
    createLegacyAIWorkbenchScope(input),
  )}`;

export const getLegacyAIWorkbenchMaskKey = (
  input: LegacyAIWorkbenchScopeInput,
) =>
  `ai-inpaint-masks-${encodeURIComponent(createLegacyAIWorkbenchScope(input))}`;
