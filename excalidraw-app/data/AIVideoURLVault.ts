const DB_NAME = "excalidraw-ai-video-db";
const STORE_NAME = "url-vault";
// v2 (ADR 0039): video bytes for providers whose result URL needs the API key.
const BLOB_STORE_NAME = "blob-vault";
const DB_VERSION = 2;

export type LocalAIVideoAsset = {
  assetId: string;
  url: string;
  mimeType: string;
  createdAt: number;
};

export type LocalAIVideoBlobAsset = {
  assetId: string;
  blob: Blob;
  mimeType: string;
  bytes: number;
  createdAt: number;
};

// fake-indexeddb (tests) cannot clone a Blob, so bytes are stored as an
// ArrayBuffer, as in AIWorkbenchIndexedDB.
type StoredBlobRecord = {
  assetId: string;
  bytes: ArrayBuffer;
  mimeType: string;
  createdAt: number;
};

const openDatabase = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "assetId" });
      }
      if (!database.objectStoreNames.contains(BLOB_STORE_NAME)) {
        database.createObjectStore(BLOB_STORE_NAME, { keyPath: "assetId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("IDB open failed"));
  });

const runRequest = async <T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
  storeName = STORE_NAME,
) => {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const request = operation(transaction.objectStore(storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error || new Error("IDB request failed"));
      transaction.onabort = () =>
        reject(transaction.error || new Error("IDB transaction aborted"));
    });
  } finally {
    database.close();
  }
};

const readBlobAsArrayBuffer = (blob: Blob): Promise<ArrayBuffer> => {
  if (typeof blob.arrayBuffer === "function") {
    return blob.arrayBuffer();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () =>
      reject(reader.error || new Error("Blob read failed"));
    reader.readAsArrayBuffer(blob);
  });
};

export const createLocalAIVideoAssetId = (taskId: string) =>
  `local:${encodeURIComponent(taskId)}`;

export const persistLocalAIVideoURL = async (input: {
  taskId: string;
  url: string;
  mimeType: string;
}): Promise<LocalAIVideoAsset> => {
  const asset: LocalAIVideoAsset = {
    assetId: createLocalAIVideoAssetId(input.taskId),
    url: input.url,
    mimeType: input.mimeType,
    createdAt: Date.now(),
  };
  await runRequest("readwrite", (store) => store.put(asset));
  const restored = await loadLocalAIVideoAsset(asset.assetId);
  if (!restored || restored.url !== asset.url) {
    throw new Error("AI video URL vault verification failed");
  }
  return restored;
};

export const loadLocalAIVideoAsset = (assetId: string) =>
  runRequest<LocalAIVideoAsset | undefined>("readonly", (store) =>
    store.get(assetId),
  );

export const persistLocalAIVideoBlob = async (input: {
  taskId: string;
  blob: Blob;
  mimeType: string;
}): Promise<LocalAIVideoBlobAsset> => {
  const record: StoredBlobRecord = {
    assetId: createLocalAIVideoAssetId(input.taskId),
    bytes: await readBlobAsArrayBuffer(input.blob),
    mimeType: input.mimeType,
    createdAt: Date.now(),
  };
  await runRequest("readwrite", (store) => store.put(record), BLOB_STORE_NAME);
  revokeLocalAIVideoObjectURL(record.assetId);
  const restored = await loadLocalAIVideoBlobAsset(record.assetId);
  if (!restored || restored.bytes !== record.bytes.byteLength) {
    throw new Error("AI video blob vault verification failed");
  }
  return restored;
};

export const loadLocalAIVideoBlobAsset = async (
  assetId: string,
): Promise<LocalAIVideoBlobAsset | undefined> => {
  const record = await runRequest<StoredBlobRecord | undefined>(
    "readonly",
    (store) => store.get(assetId),
    BLOB_STORE_NAME,
  );
  if (!record || !(record.bytes instanceof ArrayBuffer)) {
    return undefined;
  }
  return {
    assetId: record.assetId,
    blob: new Blob([record.bytes], { type: record.mimeType }),
    mimeType: record.mimeType,
    bytes: record.bytes.byteLength,
    createdAt: record.createdAt,
  };
};

// One object URL per stored video for the page's lifetime, so repeated
// playback resolution does not leak a new URL each time.
const objectURLs = new Map<string, { url: string; mimeType: string }>();

const revokeLocalAIVideoObjectURL = (assetId: string) => {
  const entry = objectURLs.get(assetId);
  if (entry) {
    URL.revokeObjectURL(entry.url);
    objectURLs.delete(assetId);
  }
};

/**
 * Playback source for a local asset: the stored URL (older providers) or an
 * object URL over the stored bytes.
 */
export const resolveLocalAIVideoPlayback = async (
  assetId: string,
): Promise<{ url: string; mimeType: string } | undefined> => {
  const urlAsset = await loadLocalAIVideoAsset(assetId);
  if (urlAsset) {
    return { url: urlAsset.url, mimeType: urlAsset.mimeType };
  }
  const cached = objectURLs.get(assetId);
  if (cached) {
    return cached;
  }
  const blobAsset = await loadLocalAIVideoBlobAsset(assetId);
  if (!blobAsset) {
    return undefined;
  }
  const entry = {
    url: URL.createObjectURL(blobAsset.blob),
    mimeType: blobAsset.mimeType,
  };
  objectURLs.set(assetId, entry);
  return entry;
};

export const removeLocalAIVideoAsset = async (assetId: string) => {
  revokeLocalAIVideoObjectURL(assetId);
  await runRequest<undefined>("readwrite", (store) => store.delete(assetId));
  await runRequest<undefined>(
    "readwrite",
    (store) => store.delete(assetId),
    BLOB_STORE_NAME,
  );
};

export const __clearLocalAIVideoURLVaultForTests = async () => {
  for (const assetId of [...objectURLs.keys()]) {
    revokeLocalAIVideoObjectURL(assetId);
  }
  await runRequest<undefined>("readwrite", (store) => store.clear());
  await runRequest<undefined>(
    "readwrite",
    (store) => store.clear(),
    BLOB_STORE_NAME,
  );
};
