const DB_NAME = "excalidraw-ai-video-db";
const STORE_NAME = "url-vault";
const DB_VERSION = 1;

export type LocalAIVideoAsset = {
  assetId: string;
  url: string;
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
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error("IDB open failed"));
  });

const runRequest = async <T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
) => {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
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

export const removeLocalAIVideoAsset = (assetId: string) =>
  runRequest<undefined>("readwrite", (store) => store.delete(assetId));

export const __clearLocalAIVideoURLVaultForTests = async () => {
  await runRequest<undefined>("readwrite", (store) => store.clear());
};
