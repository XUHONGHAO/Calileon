import { VaultError } from "../errors";

import {
  VAULT_LOCAL_ATTACHMENT_TASK_STORE,
  VAULT_LOCAL_DB_NAME,
  VAULT_LOCAL_DB_VERSION,
  VAULT_LOCAL_META_STORE,
  VAULT_LOCAL_OUTBOX_STORE,
  VAULT_LOCAL_SNAPSHOT_STORE,
  type VaultLocalStoreName,
} from "./domain";

export interface VaultLocalIndexedDbOptions {
  databaseName?: string;
  indexedDB?: IDBFactory | null;
}

const getIndexedDb = (indexedDB?: IDBFactory | null): IDBFactory => {
  const factory = indexedDB === undefined ? globalThis.indexedDB : indexedDB;
  if (!factory) {
    throw new VaultError(
      "VAULT_LOCAL_STORAGE_UNAVAILABLE",
      "IndexedDB is unavailable for Vault local storage.",
      { recoverable: true },
    );
  }
  return factory;
};

const ensureStore = (db: IDBDatabase, name: VaultLocalStoreName) => {
  if (!db.objectStoreNames.contains(name)) {
    db.createObjectStore(
      name,
      name === VAULT_LOCAL_SNAPSHOT_STORE ? { keyPath: "key" } : undefined,
    );
  }
};

export const openVaultLocalDatabase = (
  options: VaultLocalIndexedDbOptions = {},
): Promise<IDBDatabase> => {
  const factory = getIndexedDb(options.indexedDB);
  const databaseName = options.databaseName ?? VAULT_LOCAL_DB_NAME;
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(databaseName, VAULT_LOCAL_DB_VERSION);
    } catch {
      reject(
        new VaultError(
          "VAULT_LOCAL_STORAGE_UNAVAILABLE",
          "Vault local database could not be opened.",
          { recoverable: true },
        ),
      );
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      ensureStore(db, VAULT_LOCAL_SNAPSHOT_STORE);
      ensureStore(db, VAULT_LOCAL_ATTACHMENT_TASK_STORE);
      ensureStore(db, VAULT_LOCAL_OUTBOX_STORE);
      ensureStore(db, VAULT_LOCAL_META_STORE);
    };
    request.onerror = () => {
      const name = request.error?.name;
      reject(
        new VaultError(
          name === "VersionError"
            ? "VAULT_LOCAL_SCHEMA_UNSUPPORTED"
            : "VAULT_LOCAL_STORAGE_UNAVAILABLE",
          name === "VersionError"
            ? "Unsupported Vault local database schema."
            : "Vault local database could not be opened.",
          { recoverable: name !== "VersionError" },
        ),
      );
    };
    request.onblocked = () => {
      reject(
        new VaultError(
          "VAULT_LOCAL_STORAGE_UNAVAILABLE",
          "Vault local database upgrade is blocked.",
          { recoverable: true },
        ),
      );
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
};

export const runVaultLocalTransaction = async <T>(
  db: IDBDatabase,
  storeName: VaultLocalStoreName,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> => {
  let transaction: IDBTransaction;
  try {
    transaction = db.transaction(storeName, mode);
  } catch {
    throw new VaultError(
      "VAULT_LOCAL_STORAGE_UNAVAILABLE",
      "Vault local storage transaction could not start.",
      { recoverable: true },
    );
  }
  const requestResult = new Promise<T | undefined>((resolve, reject) => {
    let request: IDBRequest<T> | void;
    try {
      request = run(transaction.objectStore(storeName));
    } catch {
      reject(
        new VaultError(
          "VAULT_LOCAL_STORAGE_UNAVAILABLE",
          "Vault local storage transaction failed.",
          { recoverable: true },
        ),
      );
      return;
    }
    if (!request) {
      resolve(undefined);
      return;
    }
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new VaultError(
          "VAULT_LOCAL_STORAGE_UNAVAILABLE",
          "Vault local storage request failed.",
          { recoverable: true },
        ),
      );
  });
  const transactionComplete = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        new VaultError(
          "VAULT_LOCAL_STORAGE_UNAVAILABLE",
          "Vault local storage transaction failed.",
          { recoverable: true },
        ),
      );
    transaction.onabort = () =>
      reject(
        new VaultError(
          "VAULT_LOCAL_STORAGE_UNAVAILABLE",
          "Vault local storage transaction was aborted.",
          { recoverable: true },
        ),
      );
  });
  try {
    const result = await requestResult;
    await transactionComplete;
    return result;
  } catch (error) {
    // Observe the second failure as well. IndexedDB commonly reports a
    // request error followed by transaction abort/error for the same write.
    await Promise.allSettled([requestResult, transactionComplete]);
    throw error;
  }
};

export const runVaultLocalMultiStoreTransaction = async <T>(
  db: IDBDatabase,
  storeNames: readonly VaultLocalStoreName[],
  mode: IDBTransactionMode,
  run: (transaction: IDBTransaction) => IDBRequest<T> | void,
): Promise<T | undefined> => {
  let transaction: IDBTransaction;
  try {
    transaction = db.transaction(storeNames as string[], mode);
  } catch {
    throw new VaultError(
      "VAULT_LOCAL_STORAGE_UNAVAILABLE",
      "Vault local storage transaction could not start.",
      { recoverable: true },
    );
  }
  const requestResult = new Promise<T | undefined>((resolve, reject) => {
    let request: IDBRequest<T> | void;
    try {
      request = run(transaction);
    } catch {
      reject(
        new VaultError(
          "VAULT_LOCAL_STORAGE_UNAVAILABLE",
          "Vault local storage transaction failed.",
          { recoverable: true },
        ),
      );
      return;
    }
    if (!request) {
      resolve(undefined);
      return;
    }
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new VaultError(
          "VAULT_LOCAL_STORAGE_UNAVAILABLE",
          "Vault local storage request failed.",
          { recoverable: true },
        ),
      );
  });
  const transactionComplete = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(
        new VaultError(
          "VAULT_LOCAL_STORAGE_UNAVAILABLE",
          "Vault local storage transaction failed.",
          { recoverable: true },
        ),
      );
    transaction.onabort = () =>
      reject(
        new VaultError(
          "VAULT_LOCAL_STORAGE_UNAVAILABLE",
          "Vault local storage transaction was aborted.",
          { recoverable: true },
        ),
      );
  });
  try {
    const result = await requestResult;
    await transactionComplete;
    return result;
  } catch (error) {
    await Promise.allSettled([requestResult, transactionComplete]);
    throw error;
  }
};
