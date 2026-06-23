import { STORAGE_KEYS } from "../../app_constants";

export interface CloudSceneBinding {
  id: string;
  ownerId: string;
  title: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  localPayloadHash: string;
  localFingerprint?: string;
  savedPayloadHash: string | null;
}

interface StoredCloudSceneBinding extends CloudSceneBinding {
  schemaVersion: 1;
}

const isValidStoredBinding = (
  value: Partial<StoredCloudSceneBinding> | null,
): value is StoredCloudSceneBinding =>
  !!value &&
  value.schemaVersion === 1 &&
  typeof value.id === "string" &&
  typeof value.ownerId === "string" &&
  typeof value.title === "string" &&
  typeof value.version === "number" &&
  typeof value.createdAt === "number" &&
  typeof value.updatedAt === "number" &&
  typeof value.localPayloadHash === "string" &&
  (typeof value.localFingerprint === "string" ||
    value.localFingerprint === undefined) &&
  (typeof value.savedPayloadHash === "string" ||
    value.savedPayloadHash === null);

export const getCloudPayloadHash = (payload: string) => {
  let hash = 2166136261;
  for (let i = 0; i < payload.length; i++) {
    hash ^= payload.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${payload.length}:${(hash >>> 0).toString(36)}`;
};

export const getCloudSceneFingerprint = (
  elements: readonly {
    id: string;
    type: string;
    isDeleted?: boolean;
    fileId?: string | null;
  }[],
) =>
  elements
    .filter((element) => !element.isDeleted)
    .map((element) =>
      element.fileId
        ? `${element.id}:${element.type}:${element.fileId}`
        : `${element.id}:${element.type}`,
    )
    .sort()
    .join("|");

export const saveCloudSceneBinding = (binding: CloudSceneBinding) => {
  try {
    const stored: StoredCloudSceneBinding = {
      ...binding,
      schemaVersion: 1,
    };
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_CLOUD_SCENE,
      JSON.stringify(stored),
    );
  } catch (error) {
    console.warn(error);
  }
};

export const loadCloudSceneBinding = (
  ownerId: string,
  expected?:
    | string
    | {
        localPayloadHash?: string;
        localFingerprint?: string;
      },
): CloudSceneBinding | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_CLOUD_SCENE);
    if (!raw) {
      return null;
    }

    const stored = JSON.parse(raw);
    if (!isValidStoredBinding(stored) || stored.ownerId !== ownerId) {
      return null;
    }

    if (expected) {
      const expectedLocalPayloadHash =
        typeof expected === "string" ? expected : expected.localPayloadHash;
      const expectedLocalFingerprint =
        typeof expected === "string" ? undefined : expected.localFingerprint;
      const matchesPayloadHash =
        !!expectedLocalPayloadHash &&
        stored.localPayloadHash === expectedLocalPayloadHash;
      const matchesFingerprint =
        !!expectedLocalFingerprint &&
        stored.localFingerprint === expectedLocalFingerprint;

      if (!matchesPayloadHash && !matchesFingerprint) {
        return null;
      }
    }

    const { schemaVersion, ...binding } = stored;
    return binding;
  } catch (error) {
    console.warn(error);
    return null;
  }
};

export const clearCloudSceneBinding = () => {
  try {
    localStorage.removeItem(STORAGE_KEYS.LOCAL_STORAGE_CLOUD_SCENE);
  } catch (error) {
    console.warn(error);
  }
};
