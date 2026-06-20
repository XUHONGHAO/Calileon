/**
 * Cloud backend assembly entry (decision 0006 §5).
 *
 * Upper layers import the frozen contract only from here — never an adapter or
 * a platform SDK directly. Phase 0 always assembles `LocalAdapter`; Phase 1
 * will select Supabase implementations based on `capabilities`.
 *
 * NOTE: today's actual local/share/collab operations are exposed separately
 * via `./passthrough/*` (re-exported below for a single import surface). They
 * keep their current signatures and behavior verbatim (zero behavior change).
 */

import { readCapabilities } from "./capabilities";
import {
  createLocalAiGateway,
  createLocalAssetStorage,
  createLocalAuthProvider,
  createLocalCastService,
  createLocalEmbedService,
  createLocalRealtimeService,
  createLocalSceneStorage,
  createLocalShareService,
} from "./LocalAdapter";

import type { CloudBackend } from "./types";

let _backend: CloudBackend | null = null;

const assembleLocalBackend = (): CloudBackend => ({
  capabilities: readCapabilities(),
  auth: createLocalAuthProvider(),
  scenes: createLocalSceneStorage(),
  assets: createLocalAssetStorage(),
  shares: createLocalShareService(),
  realtime: createLocalRealtimeService(),
  cast: createLocalCastService(),
  embed: createLocalEmbedService(),
  ai: createLocalAiGateway(),
});

/**
 * Returns the active cloud backend singleton. Phase 0: always LocalAdapter.
 */
export const getCloudBackend = (): CloudBackend => {
  if (!_backend) {
    _backend = assembleLocalBackend();
  }
  return _backend;
};

// —— Frozen contract re-exports ——
export * from "./types";
export { BackendError } from "./errors";
export type { BackendErrorCode } from "./errors";
export { readCapabilities } from "./capabilities";

// —— Phase 0 passthrough surface (today's behavior, verbatim) ——
export * as localStore from "./passthrough/localStore";
export * as shareLink from "./passthrough/shareLink";
export * as firebaseStore from "./passthrough/firebaseStore";

// Realtime wire-protocol types (live in data/index.ts; surfaced here so collab
// has a single import surface). Not part of the frozen contract.
export type {
  SyncableExcalidrawElement,
  SocketUpdateData,
  SocketUpdateDataIncoming,
  SocketUpdateDataSource,
  EncryptedData,
} from "..";
