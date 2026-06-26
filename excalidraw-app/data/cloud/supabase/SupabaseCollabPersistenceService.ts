/**
 * SupabaseCollabPersistenceService - Phase 4C encrypted collaboration room
 * snapshot persistence. Realtime remains excalidraw-room; this is recovery
 * storage only.
 */

import { MIME_TYPES, toBrandedType } from "@excalidraw/common";
import { reconcileElements } from "@excalidraw/excalidraw";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  decryptData,
  encryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion, isInvisiblySmallElement } from "@excalidraw/element";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";

import type {
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";

import type {
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";

import {
  DELETED_ELEMENT_TIMEOUT,
  FILE_CACHE_MAX_AGE_SEC,
} from "../../../app_constants";

import { getSupabaseClient } from "./client";
import { mapDataError } from "./errorMapping";

import type {
  CollabPersistenceFilesInput,
  CollabPersistenceLoadFilesInput,
  CollabPersistenceRoomRef,
  CollabPersistenceSaveSceneInput,
  CollabPersistenceService,
  CollabPersistenceSnapshot,
} from "../types";

interface SnapshotRpcResult {
  room_id: string;
  encrypted_payload: {
    version: number;
    iv: string;
    ciphertext: string;
  };
  updated_at: string;
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return window.btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array => {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const bytesToArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

const toEpochMs = (value: string | null): number => {
  if (!value) {
    return 0;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
};

const sceneVersionCache = new WeakMap<object, number>();

const encryptElements = async (
  key: string,
  elements: readonly OrderedExcalidrawElement[],
): Promise<{ encryptedData: ArrayBuffer; iv: Uint8Array }> => {
  const json = JSON.stringify(elements);
  const encoded = new TextEncoder().encode(json);
  const { encryptedBuffer, iv } = await encryptData(key, encoded);
  return { encryptedData: encryptedBuffer, iv };
};

const decryptElements = async (
  snapshot: CollabPersistenceSnapshot,
  roomKey: string,
): Promise<readonly OrderedExcalidrawElement[]> => {
  const decrypted = await decryptData(
    new Uint8Array(bytesToArrayBuffer(snapshot.iv)),
    snapshot.encryptedData,
    roomKey,
  );
  const decodedData = new TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  return JSON.parse(decodedData);
};

const getCollabStoragePath = (roomId: string, fileId: FileId) =>
  `collab/${roomId}/${fileId}`;

const getSyncableElements = (elements: readonly OrderedExcalidrawElement[]) =>
  elements.filter((element) => {
    if (element.isDeleted) {
      return element.updated > Date.now() - DELETED_ELEMENT_TIMEOUT;
    }
    return !isInvisiblySmallElement(element);
  });

export const createSupabaseCollabPersistenceService =
  (): CollabPersistenceService => {
    const isRoomActive = async (roomId: string): Promise<boolean> => {
      const client = getSupabaseClient();
      const { data, error } = await client.rpc("get_collab_room_access", {
        p_room_id: roomId,
      });
      if (error) {
        // Older schemas do not have this RPC yet. Do not break ordinary
        // non-cloud collaboration rooms just because metadata is unavailable.
        console.warn(error);
        return true;
      }
      return data !== "revoked";
    };

    const saveSnapshot = async (
      input: CollabPersistenceSnapshot,
    ): Promise<void> => {
      const client = getSupabaseClient();
      const { error } = await client.rpc("save_collab_room_snapshot", {
        p_room_id: input.roomId,
        p_encrypted_payload: {
          version: 1,
          iv: bytesToBase64(input.iv),
          ciphertext: bytesToBase64(new Uint8Array(input.encryptedData)),
        },
      });
      if (error) {
        throw mapDataError(error);
      }
    };

    const loadSnapshot = async (
      roomId: string,
    ): Promise<CollabPersistenceSnapshot | null> => {
      const client = getSupabaseClient();
      const { data, error } = await client.rpc("load_collab_room_snapshot", {
        p_room_id: roomId,
      });
      if (error) {
        throw mapDataError(error);
      }
      if (!data) {
        return null;
      }

      const result = data as SnapshotRpcResult;
      const encryptedBytes = base64ToBytes(result.encrypted_payload.ciphertext);

      return {
        roomId: result.room_id,
        iv: base64ToBytes(result.encrypted_payload.iv),
        encryptedData: bytesToArrayBuffer(encryptedBytes),
        updatedAt: toEpochMs(result.updated_at),
      };
    };

    const isSaved = ({
      roomId,
      roomKey,
      socket,
      elements,
    }: CollabPersistenceRoomRef & {
      elements: readonly OrderedExcalidrawElement[];
    }): boolean => {
      if (socket && roomId && roomKey) {
        return sceneVersionCache.get(socket) === getSceneVersion(elements);
      }
      return true;
    };

    const saveScene = async ({
      roomId,
      roomKey,
      socket,
      elements,
      appState,
    }: CollabPersistenceSaveSceneInput) => {
      if (
        !roomId ||
        !roomKey ||
        !socket ||
        isSaved({ roomId, roomKey, socket, elements })
      ) {
        return null;
      }

      const previousSnapshot = await loadSnapshot(roomId);
      const syncableElements = getSyncableElements(elements);
      let elementsToStore = syncableElements;

      if (previousSnapshot) {
        const previousElements = getSyncableElements(
          restoreElements(
            await decryptElements(previousSnapshot, roomKey),
            null,
          ),
        );
        elementsToStore = getSyncableElements(
          reconcileElements(
            syncableElements,
            previousElements as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
            appState,
          ),
        );
      }

      const encrypted = await encryptElements(roomKey, elementsToStore);
      await saveSnapshot({
        roomId,
        encryptedData: encrypted.encryptedData,
        iv: encrypted.iv,
        updatedAt: Date.now(),
      });

      sceneVersionCache.set(socket, getSceneVersion(elementsToStore));
      return toBrandedType<RemoteExcalidrawElement[]>(elementsToStore);
    };

    const loadScene = async ({
      roomId,
      roomKey,
      socket,
    }: CollabPersistenceRoomRef) => {
      if (!roomId || !roomKey) {
        return null;
      }
      const snapshot = await loadSnapshot(roomId);
      if (!snapshot) {
        return null;
      }

      const elements = getSyncableElements(
        restoreElements(await decryptElements(snapshot, roomKey), null, {
          deleteInvisibleElements: true,
        }),
      );

      if (socket) {
        sceneVersionCache.set(socket, getSceneVersion(elements));
      }

      return elements;
    };

    const saveFiles = async ({
      roomId,
      files,
    }: CollabPersistenceFilesInput) => {
      const savedFiles: FileId[] = [];
      const erroredFiles: FileId[] = [];
      if (!roomId) {
        return { savedFiles, erroredFiles };
      }

      const client = getSupabaseClient();
      await Promise.all(
        files.map(async ({ id, buffer }) => {
          const storagePath = getCollabStoragePath(roomId, id);
          try {
            const { error: uploadError } = await client.storage
              .from("excalidraw-assets")
              .upload(storagePath, buffer, {
                upsert: true,
                cacheControl: `${FILE_CACHE_MAX_AGE_SEC}`,
                contentType: "application/octet-stream",
              });
            if (uploadError) {
              throw uploadError;
            }

            const { error: rpcError } = await client.rpc(
              "register_collab_room_asset",
              {
                p_room_id: roomId,
                p_file_id: id,
                p_storage_path: storagePath,
                p_mime_type: "application/octet-stream",
                p_bytes: buffer.byteLength,
              },
            );
            if (rpcError) {
              throw rpcError;
            }
            savedFiles.push(id);
          } catch (error) {
            erroredFiles.push(id);
            console.error(error);
          }
        }),
      );

      return { savedFiles, erroredFiles };
    };

    const loadFiles = async ({
      roomId,
      roomKey,
      fileIds,
    }: CollabPersistenceLoadFilesInput) => {
      const loadedFiles: BinaryFileData[] = [];
      const erroredFiles = new Map<FileId, true>();
      if (!roomId || !roomKey) {
        return { loadedFiles, erroredFiles };
      }

      const client = getSupabaseClient();
      await Promise.all(
        [...new Set(fileIds)].map(async (id) => {
          try {
            const { data, error } = await client.storage
              .from("excalidraw-assets")
              .createSignedUrl(getCollabStoragePath(roomId, id), 60);
            if (error || !data?.signedUrl) {
              throw error;
            }

            const response = await fetch(data.signedUrl);
            if (response.status >= 400) {
              erroredFiles.set(id, true);
              return;
            }

            const arrayBuffer = await response.arrayBuffer();
            const { data: decompressed, metadata } =
              await decompressData<BinaryFileMetadata>(
                new Uint8Array(arrayBuffer),
                { decryptionKey: roomKey },
              );
            const dataURL = new TextDecoder().decode(decompressed) as DataURL;

            loadedFiles.push({
              mimeType: metadata.mimeType || MIME_TYPES.binary,
              id,
              dataURL,
              created: metadata?.created || Date.now(),
              lastRetrieved: metadata?.created || Date.now(),
            });
          } catch (error) {
            erroredFiles.set(id, true);
            console.error(error);
          }
        }),
      );

      return { loadedFiles, erroredFiles };
    };

    return {
      isAvailable: () => true,
      backend: "supabase",
      isRoomActive,
      isSaved,
      saveScene,
      loadScene,
      saveFiles,
      loadFiles,
      saveSnapshot,
      loadSnapshot,
    };
  };
