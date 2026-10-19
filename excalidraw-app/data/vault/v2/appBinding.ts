/**
 * Default production dependencies for the v2 route (W6). Loaded by the App
 * through a dynamic import only when `VITE_APP_VAULT_V2_ENABLED === "true"`,
 * so Yjs and the v2 code stay out of the main bundle otherwise.
 *
 * v2 reuses the v1 deployment configuration (capability URLs, room server
 * URL): it is the same deployment advertising protocol 2.
 */
import type { ExcalidrawElement } from "@excalidraw/element/types";

import type { AppState } from "@excalidraw/excalidraw/types";

import { createSupabaseVaultBackend } from "../../cloud";
import { createSupabaseVaultEncryptedAssetService } from "../../cloud/supabase/SupabaseVaultEncryptedAssetService";
import {
  createSupabaseVaultV2Creator,
  createSupabaseVaultV2SnapshotStore,
} from "../../cloud/supabase/SupabaseVaultV2SnapshotStore";
import {
  assertVaultClientConfig,
  readVaultClientConfig,
} from "../clientConfig";
import {
  createHttpVaultDeploymentDiscoveryTransport,
  discoverVaultDeployment,
} from "../deploymentDiscovery";
import { VaultLocalStore } from "../local-store/store";
import { createHttpVaultRoomProvisionTransport } from "../roomProvision";

import { VaultV2Assets } from "./assets";
import { VaultV2LocalStore } from "./localStore";
import { migrateVaultToV2, readVaultV2Migration } from "./migration";
import { VaultV2NoticeTracker } from "./notices";
import {
  assertVaultV2Deployment,
  createVaultV2Route,
  openVaultV2Route,
} from "./route";
import { VaultV2UiStore } from "./uiState";

import type { VaultEncryptedAssetService } from "../assets";
import type { VaultOwnerService } from "../owner";
import type { VaultV2EditorApi } from "./controller";
import type { VaultV2AssetEditorApi } from "./assets";
import type { VaultV2MigrationJournal } from "./localStore";
import type { VaultV2MigrationSource } from "./migration";
import type { VaultV2RouteDependencies } from "./route";
import type { VaultV2Session, VaultV2SessionSocket } from "./session";

/**
 * the v2 session as the App holds it: scene sync + attachments (W5) + the
 * state the status pill renders and the one-off notices (W6)
 */
export type VaultV2AppSession = Omit<VaultV2Session, "attach"> & {
  attach: (api: VaultV2EditorApi & VaultV2AssetEditorApi) => void;
  readonly ui: VaultV2UiStore;
};

const discoverForApp = async () => {
  const config = readVaultClientConfig();
  assertVaultClientConfig(config);
  const discovered = await discoverVaultDeployment(
    createHttpVaultDeploymentDiscoveryTransport({
      persistenceCapabilitiesUrl: config.persistenceCapabilitiesUrl,
      roomCapabilitiesUrl: config.roomCapabilitiesUrl,
    }),
  );
  return { config, ...discovered };
};

const withJournal = async <T>(
  body: (journal: VaultV2MigrationJournal) => Promise<T>,
) => {
  const store = await VaultV2LocalStore.open();
  try {
    return await body(store.migrations());
  } finally {
    store.close();
  }
};

/** W4: the new link if this v1 Vault was migrated on this device */
export const readVaultV2MigratedLinkForApp = (
  source: Pick<VaultV2MigrationSource, "vaultId" | "rootKey">,
) =>
  withJournal(async (journal) => {
    const migration = await readVaultV2Migration(
      source,
      journal,
      window.location.href,
    );
    return migration?.editorLink ?? null;
  });

/**
 * W4/W5: migrates the open v1 Vault. The owner and asset services come from
 * its (protocol-agnostic) v1 backend; image files are copied via the P4b
 * attachment queue before the new snapshot is committed.
 */
export const migrateVaultToV2ForApp = async (
  source: VaultV2MigrationSource,
  services: { owner: VaultOwnerService; assets: VaultEncryptedAssetService },
) => {
  const { config, capabilities } = await discoverForApp();
  assertVaultV2Deployment(capabilities);
  const assetStore = await VaultLocalStore.open();
  try {
    const result = await withJournal((journal) =>
      migrateVaultToV2(source, {
        journal,
        createV2: createSupabaseVaultV2Creator(),
        owner: services.owner,
        rooms: createHttpVaultRoomProvisionTransport({
          provisionUrl: config.roomProvisionUrl,
        }),
        createSnapshotStore: createSupabaseVaultV2SnapshotStore,
        baseUrl: window.location.href,
        assets: { service: services.assets, store: assetStore },
      }),
    );
    return result.editorLink;
  } finally {
    assetStore.close();
  }
};

/** W6: owner flow, a new empty v2 Vault; returns its editor link */
export const createVaultV2ForApp = async () => {
  const { config, ready, capabilities } = await discoverForApp();
  const created = await createVaultV2Route({
    discover: async () => capabilities,
    createV2: createSupabaseVaultV2Creator(),
    owner: createSupabaseVaultBackend(ready).owner,
    rooms: createHttpVaultRoomProvisionTransport({
      provisionUrl: config.roomProvisionUrl,
    }),
    baseUrl: window.location.href,
  });
  return created.editorLink;
};

export const openVaultV2ForApp = async (
  href: string,
  callbacks: Pick<
    VaultV2RouteDependencies,
    "onStatus" | "onBlocked" | "onError"
  >,
) => {
  const { default: socketIOClient } = await import("socket.io-client");
  let discovered: Awaited<ReturnType<typeof discoverForApp>> | null = null;
  const ui = new VaultV2UiStore();
  let tracker: VaultV2NoticeTracker | null = null;
  let firstSync = false;
  const { link, session } = await openVaultV2Route(href, {
    discover: async () => {
      discovered = await discoverForApp();
      return discovered.capabilities;
    },
    createSocket: () =>
      socketIOClient(import.meta.env.VITE_APP_WS_SERVER_URL, {
        transports: ["websocket", "polling"],
      }) as unknown as VaultV2SessionSocket,
    createSnapshotStore: createSupabaseVaultV2SnapshotStore,
    openLocalStore: async () => {
      const store = await VaultV2LocalStore.open();
      ui.update({ localSafe: true });
      return store;
    },
    onStatus: (status) => {
      ui.update({ status });
      if (status === "synced" && !firstSync) {
        // what the first sync brought in is history, not news
        firstSync = true;
        tracker?.arm();
      }
      callbacks.onStatus?.(status);
    },
    onBlocked: (error) => {
      ui.update({ status: "blocked", blockedCode: error.code });
      callbacks.onBlocked?.(error);
    },
    onError: callbacks.onError,
  });
  ui.update({ status: session.status() });

  // W6: conflict list + one-off notices after every materialize
  const noticeTracker = new VaultV2NoticeTracker(session.controller.scene);
  tracker = noticeTracker;
  if (firstSync) {
    noticeTracker.arm();
  }
  const offFlush = session.controller.onFlush((result) => {
    const notices = noticeTracker.update(result.report, result.changedIds);
    ui.update({ conflictElementIds: noticeTracker.conflictElementIds });
    notices.forEach((notice) => ui.emit(notice));
  });

  // W5: attachments through the 0029 asset service + P4b attachment queue
  let assetStore: VaultLocalStore | null = null;
  if (session.role === "editor") {
    try {
      assetStore = await VaultLocalStore.open();
    } catch (error) {
      // no durable queue: uploads go direct
      callbacks.onError?.(error);
    }
  }
  const assets = new VaultV2Assets({
    vaultId: link.vaultId,
    roomId: session.activeRoomId,
    rootKey: link.rootKey,
    invitationCapability: link.invitationCapability,
    role: session.role,
    service: createSupabaseVaultEncryptedAssetService(discovered!.ready),
    store: assetStore,
    onStateChange: (state) =>
      ui.update({
        attachmentPending: state.pending,
        attachmentFailed: state.failed,
        ...(state.failed === 0 ? { attachmentFailure: null } : {}),
      }),
    onFailureChange: (attachmentFailure) => ui.update({ attachmentFailure }),
    onError: callbacks.onError,
  });

  const appSession: VaultV2AppSession = Object.freeze({
    ...session,
    ui,
    attach: (api: VaultV2EditorApi & VaultV2AssetEditorApi) => {
      session.attach(api);
      assets.attach(api);
    },
    onChange: (
      elements: readonly ExcalidrawElement[],
      appState: Partial<AppState>,
    ) => {
      session.onChange(elements, appState);
      // local and remote changes both pass here (remote via updateScene)
      assets.schedule();
    },
    dispose: () => {
      offFlush();
      assets.dispose();
      assetStore?.close();
      session.dispose();
    },
  });
  return { link, session: appSession };
};
