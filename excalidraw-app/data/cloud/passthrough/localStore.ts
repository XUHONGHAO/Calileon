/**
 * Phase 0 passthrough: local persistence (localStorage + IndexedDB).
 *
 * This module re-exposes today's local-persistence functions VERBATIM — same
 * signatures, same behavior, zero change. It exists only to give callers a
 * single import surface under `data/cloud/` so that components/menus no longer
 * reach into `data/localStorage` and `data/LocalData` directly (DoD §2).
 *
 * Real reshaping to the frozen `SceneStorage` contract is Phase 1 work; nothing
 * here is changed in Phase 0.
 */

export {
  importFromLocalStorage,
  importUsernameFromLocalStorage,
  saveUsernameToLocalStorage,
  getElementsStorageSize,
  getTotalStorageSize,
} from "../../localStorage";

export {
  LocalData,
  LibraryIndexedDBAdapter,
  LibraryLocalStorageMigrationAdapter,
  localStorageQuotaExceededAtom,
} from "../../LocalData";
