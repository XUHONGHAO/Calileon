/**
 * Phase 0 passthrough: share links + collaboration-link helpers.
 *
 * Re-exposes today's functions from `data/index.ts` VERBATIM (same signatures,
 * same behavior). The legacy share link (`exportToBackend`/`importFromBackend`)
 * targets the json.excalidraw.com-style backend; the collaboration-link helpers
 * are pure URL/key logic. Reshaping to the frozen `ShareService` contract is
 * Phase 2 work — nothing here changes in Phase 0.
 *
 * `getSyncableElements` / `isSyncableElement` and the socket data types are the
 * realtime wire protocol; they are re-exported here only so collab has a single
 * import surface under `data/cloud/`.
 */

export {
  exportToBackend,
  importFromBackend,
  isCollaborationLink,
  getCollaborationLinkData,
  generateCollaborationLinkData,
  getCollaborationLink,
  isSyncableElement,
  getSyncableElements,
} from "../..";

export type {
  SyncableExcalidrawElement,
  SocketUpdateData,
  SocketUpdateDataIncoming,
  SocketUpdateDataSource,
  EncryptedData,
} from "../..";
