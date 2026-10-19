/**
 * Vault v2 (P4c) session: wires keys, socket transport, scene controller,
 * sync engine and local persistence for one opened Vault (W6). The App only
 * talks to this object:
 *
 *   const session = await openVaultV2Session({ link, ... });
 *   session.attach(excalidrawAPI);          // pushes the doc into the editor
 *   onChange → session.onChange(elements, appState)
 *   onTextEditorMount → session.onTextEditorMount
 *   session.dispose() on route change / unmount
 *
 * Order on open (W2 §6.1): join (role + room) → local copy → snapshot →
 * context → outbox. Open fails if the room refuses admission; there is no
 * plain-collaboration fallback.
 */
import type { ExcalidrawElement } from "@excalidraw/element/types";

import type { AppState } from "@excalidraw/excalidraw/types";

import { VaultError } from "../errors";

import { VaultV2SceneController } from "./controller";
import { VaultV2LocalDocSaver } from "./localStore";
import { createVaultV2Keys } from "./protocol";
import { VaultV2SocketTransport } from "./socketTransport";
import { VaultV2SyncEngine, createMemoryOutbox } from "./syncEngine";

import type { VaultV2EditorApi } from "./controller";
import type { VaultV2LinkData } from "./link";
import type { VaultV2LocalStore } from "./localStore";
import type { VaultV2Admission, VaultV2Socket } from "./socketTransport";
import type {
  VaultV2SnapshotStore,
  VaultV2Status,
  VaultV2SyncConfig,
} from "./syncEngine";

export type VaultV2SessionStatus = VaultV2Status;

export type VaultV2Session = {
  readonly vaultId: string;
  readonly role: VaultV2Admission["role"];
  readonly activeRoomId: string;
  readonly controller: VaultV2SceneController;
  readonly engine: VaultV2SyncEngine;
  readonly status: () => VaultV2SessionStatus;
  attach: (api: VaultV2EditorApi) => void;
  onChange: (
    elements: readonly ExcalidrawElement[],
    appState: Partial<AppState>,
  ) => void;
  onTextEditorMount: VaultV2SceneController["onTextEditorMount"];
  /** page hidden / before unload: flush batch, write snapshot, save locally */
  persistNow: () => Promise<void>;
  dispose: () => void;
};

/** socket.io-like: needs `connected` and `connect`/`disconnect` events */
export type VaultV2SessionSocket = VaultV2Socket & { close?: () => void };

export const openVaultV2Session = async (input: {
  link: VaultV2LinkData;
  socket: VaultV2SessionSocket;
  createSnapshotStore: (input: {
    vaultId: string;
    invitationCapability: string;
  }) => VaultV2SnapshotStore;
  localStore?: VaultV2LocalStore | null;
  actorId?: string;
  onStatus?: (status: VaultV2SessionStatus) => void;
  onBlocked?: (error: VaultError) => void;
  onError?: (error: unknown) => void;
  config?: Partial<VaultV2SyncConfig>;
  /** where page-lifecycle listeners attach (tests pass a fake) */
  lifecycle?: Pick<Window, "addEventListener" | "removeEventListener"> & {
    document?: Pick<Document, "visibilityState">;
  };
}): Promise<VaultV2Session> => {
  const { link } = input;
  const keys = createVaultV2Keys(link.rootKey, link.vaultId);
  let engine: VaultV2SyncEngine | null = null;
  let blocked = false;

  const transport = new VaultV2SocketTransport({
    socket: input.socket,
    vaultId: link.vaultId,
    invitationCapability: link.invitationCapability,
    onBlocked: (error) => {
      blocked = true;
      engine?.block();
      input.onBlocked?.(error);
    },
    onDisconnect: () => input.onStatus?.("offline"),
  });

  let admission: VaultV2Admission;
  try {
    admission = await transport.join();
  } catch (error) {
    transport.dispose();
    throw error;
  }

  const controller = new VaultV2SceneController({
    actorId: input.actorId ?? crypto.randomUUID(),
  });
  const localStore = input.localStore ?? null;
  const outbox = localStore
    ? localStore.outbox(link.vaultId)
    : createMemoryOutbox();

  let restoredGeneration = 0;
  if (localStore) {
    try {
      const restored = await localStore.restoreDoc({
        keys,
        vaultId: link.vaultId,
        roomId: admission.activeRoomId,
        scene: controller.scene,
      });
      restoredGeneration = restored?.generation ?? 0;
    } catch (error) {
      // a broken local cache never blocks opening; the server is the truth
      input.onError?.(error);
    }
  }

  engine = new VaultV2SyncEngine({
    controller,
    keys,
    vaultId: link.vaultId,
    roomId: admission.activeRoomId,
    role: admission.role,
    transport,
    snapshots: input.createSnapshotStore({
      vaultId: link.vaultId,
      invitationCapability: link.invitationCapability,
    }),
    outbox,
    onStatus: input.onStatus,
    onError: input.onError,
    config: input.config,
  });
  const activeEngine = engine;

  const saver = localStore
    ? new VaultV2LocalDocSaver({
        store: localStore,
        keys,
        vaultId: link.vaultId,
        roomId: admission.activeRoomId,
        scene: controller.scene,
        generation: () =>
          Math.max(restoredGeneration, activeEngine.knownGeneration),
        onError: input.onError,
      })
    : null;

  let reconnecting: Promise<void> | null = null;
  const onSocketConnect = () => {
    if (blocked || reconnecting) {
      return;
    }
    reconnecting = transport
      .join()
      .then(() => activeEngine.onReconnect())
      .catch((error) => input.onError?.(error))
      .finally(() => {
        reconnecting = null;
      });
  };
  input.socket.on("connect", onSocketConnect);

  const persistNow = async () => {
    await activeEngine.flushNow();
    await activeEngine.writeSnapshot("hidden");
    await saver?.flush();
  };
  const lifecycle =
    input.lifecycle ?? (typeof window !== "undefined" ? window : undefined);
  const onVisibility = () => {
    const state =
      input.lifecycle?.document?.visibilityState ??
      (typeof document !== "undefined" ? document.visibilityState : "visible");
    if (state === "hidden") {
      void persistNow().catch((error) => input.onError?.(error));
    }
  };
  const onPageHide = () => {
    void persistNow().catch((error) => input.onError?.(error));
  };
  lifecycle?.addEventListener("visibilitychange", onVisibility);
  lifecycle?.addEventListener("pagehide", onPageHide);

  let disposed = false;
  let started: Promise<void> | null = null;

  const session: VaultV2Session = {
    vaultId: link.vaultId,
    role: admission.role,
    activeRoomId: admission.activeRoomId,
    controller,
    engine: activeEngine,
    status: () => activeEngine.currentStatus,
    attach: (api: VaultV2EditorApi) => {
      controller.attach(api);
      if (!started) {
        started = activeEngine.start().catch((error) => {
          input.onError?.(error);
        });
      } else {
        controller.flushToEditor();
      }
    },
    onChange: (elements, appState) => {
      if (disposed || blocked || admission.role !== "editor") {
        return;
      }
      controller.captureLocal(elements, appState);
    },
    onTextEditorMount: (payload) =>
      admission.role === "editor" && !disposed
        ? controller.onTextEditorMount(payload)
        : undefined,
    persistNow,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      lifecycle?.removeEventListener("visibilitychange", onVisibility);
      lifecycle?.removeEventListener("pagehide", onPageHide);
      input.socket.off("connect", onSocketConnect);
      saver?.dispose();
      activeEngine.stop();
      controller.detach();
      transport.dispose();
      input.socket.close?.();
    },
  };
  return Object.freeze(session);
};

export const isVaultV2BlockingError = (error: unknown) =>
  error instanceof VaultError &&
  [
    "VAULT_CAPABILITY_INVALID",
    "VAULT_CAPABILITY_FORBIDDEN",
    "VAULT_CAPABILITY_EXPIRED",
    "VAULT_CAPABILITY_REVOKED",
    "VAULT_NOT_FOUND",
    "VAULT_NOT_ACTIVE",
    "VAULT_PROTOCOL_UNSUPPORTED",
  ].includes(error.code);
