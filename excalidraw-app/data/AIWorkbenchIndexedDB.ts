import {
  clear,
  createStore,
  delMany,
  getMany,
  keys,
  promisifyRequest,
} from "idb-keyval";

export type AIWorkbenchPayloadKind =
  | "reference"
  | "mask"
  | "many-minds-batch"
  | "many-minds-asset";

export type AIWorkbenchStoredMaskPayload<TElement = unknown> = {
  blob: Blob;
  elements: readonly TElement[];
};

export type AIWorkbenchRevisionPayload<TValue> = {
  id: string;
  value: TValue;
};

export type AIWorkbenchRevisionDescriptor = {
  scopeId: string;
  revision: string;
  kind: AIWorkbenchPayloadKind;
};

const DATABASE_NAME = "excalidraw-ai-workbench-db";
const STORE_NAME = "media-store";
const KEY_VERSION_PREFIX = "aiwb:v1";
const BLOB_ENVELOPE_MARKER = "excalidraw-ai-workbench-blob-v1";

type StoredBlobEnvelope = {
  marker: typeof BLOB_ENVELOPE_MARKER;
  mimeType: string;
  bytes: ArrayBuffer;
};

const isStoredBlobEnvelope = (value: unknown): value is StoredBlobEnvelope =>
  !!value &&
  typeof value === "object" &&
  (value as StoredBlobEnvelope).marker === BLOB_ENVELOPE_MARKER &&
  typeof (value as StoredBlobEnvelope).mimeType === "string" &&
  (value as StoredBlobEnvelope).bytes instanceof ArrayBuffer;

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

const encodeBlob = async (blob: Blob): Promise<StoredBlobEnvelope> => ({
  marker: BLOB_ENVELOPE_MARKER,
  mimeType: blob.type,
  bytes: await readBlobAsArrayBuffer(blob),
});

const encodePayloadForStorage = async (value: unknown): Promise<unknown> => {
  if (value instanceof Blob) {
    return encodeBlob(value);
  }
  if (
    value &&
    typeof value === "object" &&
    "blob" in value &&
    (value as { blob?: unknown }).blob instanceof Blob
  ) {
    return {
      ...value,
      blob: await encodeBlob((value as { blob: Blob }).blob),
    };
  }
  return value;
};

const decodeBlob = (value: StoredBlobEnvelope) =>
  new Blob([value.bytes], { type: value.mimeType });

const decodePayloadFromStorage = (value: unknown): unknown => {
  if (isStoredBlobEnvelope(value)) {
    return decodeBlob(value);
  }
  if (
    value &&
    typeof value === "object" &&
    "blob" in value &&
    isStoredBlobEnvelope((value as { blob?: unknown }).blob)
  ) {
    return {
      ...value,
      blob: decodeBlob((value as { blob: StoredBlobEnvelope }).blob),
    };
  }
  return value;
};

const mediaStore = createStore(DATABASE_NAME, STORE_NAME);

const encodeKeyPart = (value: string) => encodeURIComponent(value);

export class AIWorkbenchRevisionConflictError extends Error {
  constructor() {
    super("AI Workbench revision payloads already exist.");
    this.name = "AIWorkbenchRevisionConflictError";
  }
}

/**
 * App-local storage for AI Workbench binary payloads. This store is deliberately
 * separate from LocalData.fileStorage because references and masks do not share
 * the scene-file cleanup lifecycle.
 */
export class AIWorkbenchIndexedDBAdapter {
  static readonly databaseName = DATABASE_NAME;
  static readonly storeName = STORE_NAME;

  static createRevisionPrefix({
    scopeId,
    revision,
    kind,
  }: AIWorkbenchRevisionDescriptor) {
    return `${KEY_VERSION_PREFIX}:${kind}:${encodeKeyPart(
      scopeId,
    )}:${encodeKeyPart(revision)}:`;
  }

  static createRevisionPayloadKey(
    descriptor: AIWorkbenchRevisionDescriptor,
    payloadId: string,
  ) {
    return `${this.createRevisionPrefix(descriptor)}${encodeKeyPart(
      payloadId,
    )}`;
  }

  /** Atomically writes all entries in a single IndexedDB transaction. */
  static async setMany<TValue>(
    entries: readonly (readonly [string, TValue])[],
  ) {
    const encodedEntries = await Promise.all(
      entries.map(
        async ([key, value]) =>
          [key, await encodePayloadForStorage(value)] as const,
      ),
    );

    return mediaStore("readwrite", (store) => {
      try {
        encodedEntries.forEach(([key, value]) => store.put(value, key));
      } catch (error) {
        // idb-keyval's stock setMany() relies on the browser aborting after a
        // synchronous put() failure. Abort explicitly so fake-indexeddb and
        // older engines cannot commit entries queued before the bad value.
        store.transaction.abort();
        throw error;
      }

      return promisifyRequest(store.transaction);
    });
  }

  static async getMany<TValue>(payloadKeys: readonly string[]) {
    const values = await getMany<unknown>([...payloadKeys], mediaStore);
    return values.map(decodePayloadFromStorage) as (TValue | undefined)[];
  }

  /** Atomically deletes all supplied keys in a single transaction. */
  static deleteMany(payloadKeys: readonly string[]) {
    return delMany([...payloadKeys], mediaStore);
  }

  static async listKeys(prefix?: string) {
    const storedKeys = await keys<IDBValidKey>(mediaStore);
    const stringKeys = storedKeys.filter(
      (key): key is string => typeof key === "string",
    );

    return prefix
      ? stringKeys.filter((key) => key.startsWith(prefix))
      : stringKeys;
  }

  static listRevisionKeys(descriptor: AIWorkbenchRevisionDescriptor) {
    return this.listKeys(this.createRevisionPrefix(descriptor));
  }

  /**
   * Writes a new immutable revision. Callers commit their lightweight
   * localStorage manifest only after this promise resolves.
   */
  static async setRevisionPayloads<TValue>(
    descriptor: AIWorkbenchRevisionDescriptor,
    payloads: readonly AIWorkbenchRevisionPayload<TValue>[],
  ) {
    const payloadKeys = payloads.map((payload) =>
      this.createRevisionPayloadKey(descriptor, payload.id),
    );

    if (new Set(payloadKeys).size !== payloadKeys.length) {
      throw new AIWorkbenchRevisionConflictError();
    }

    const existingValues = await this.getMany<unknown>(payloadKeys);
    if (existingValues.some((value) => value !== undefined)) {
      throw new AIWorkbenchRevisionConflictError();
    }

    await this.setMany(
      payloads.map(
        (payload, index) => [payloadKeys[index], payload.value] as const,
      ),
    );

    return payloadKeys;
  }

  static clearAll() {
    return clear(mediaStore);
  }
}
