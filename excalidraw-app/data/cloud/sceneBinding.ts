import { STORAGE_KEYS } from "../../app_constants";

export interface CloudSceneBinding {
  id: string;
  ownerId: string;
  title: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  localPayloadHash: string;
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
  expectedLocalPayloadHash?: string,
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

    if (
      expectedLocalPayloadHash &&
      stored.localPayloadHash !== expectedLocalPayloadHash
    ) {
      return null;
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
