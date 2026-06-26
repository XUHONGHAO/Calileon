import { FIREBASE_STORAGE_PREFIXES } from "../../app_constants";

import * as firebaseStore from "./passthrough/firebaseStore";

import type { CollabPersistenceService } from "./types";
import type { SyncableExcalidrawElement } from "..";

export const createFirebaseCollabPersistenceService =
  (): CollabPersistenceService => ({
    isAvailable: () => true,
    backend: "firebase",
    isRoomActive: async () => true,
    isSaved: ({ roomId, roomKey, socket, elements }) =>
      firebaseStore.isSavedToFirebase({ roomId, roomKey, socket }, elements),
    saveScene: ({ roomId, roomKey, socket, elements, appState }) =>
      firebaseStore.saveToFirebase(
        { roomId, roomKey, socket },
        elements as readonly SyncableExcalidrawElement[],
        appState,
      ),
    loadScene: ({ roomId, roomKey, socket }) => {
      if (!roomId || !roomKey) {
        return Promise.resolve(null);
      }
      return firebaseStore.loadFromFirebase(roomId, roomKey, socket);
    },
    saveFiles: ({ roomId, files }) => {
      if (!roomId) {
        return Promise.resolve({ savedFiles: [], erroredFiles: [] });
      }
      return firebaseStore.saveFilesToFirebase({
        prefix: `${FIREBASE_STORAGE_PREFIXES.collabFiles}/${roomId}`,
        files,
      });
    },
    loadFiles: ({ roomId, roomKey, fileIds }) => {
      if (!roomId || !roomKey) {
        return Promise.resolve({
          loadedFiles: [],
          erroredFiles: new Map(),
        });
      }
      return firebaseStore.loadFilesFromFirebase(
        `files/rooms/${roomId}`,
        roomKey,
        fileIds,
      );
    },
    saveSnapshot: async () => {
      // Firebase fallback persists scenes through saveScene().
    },
    loadSnapshot: async () => null,
  });
