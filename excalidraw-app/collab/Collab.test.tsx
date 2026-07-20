import { beforeEach, describe, expect, it, vi } from "vitest";

import { UserIdleState } from "@excalidraw/common";

import type { SocketId } from "@excalidraw/excalidraw/types";

import { appJotaiStore } from "../app-jotai";
import { WS_SUBTYPES } from "../app_constants";
import {
  assertVaultDeploymentReady,
  createVaultEncryptedAssetService,
  createVaultPersistenceService,
  openVaultClientSession,
  VAULT_SOCKET_EVENTS,
  VaultRealtimeSession,
} from "../data/vault";

import Collab, { isCollaboratingAtom } from "./Collab";

const { socketClient } = vi.hoisted(() => ({ socketClient: vi.fn() }));
vi.mock("socket.io-client", () => ({ default: socketClient }));

const vaultId = "123e4567-e89b-42d3-a456-426614174000";
const invitationId = "123e4567-e89b-42d3-a456-426614174001";
const senderSessionId = "123e4567-e89b-42d3-a456-426614174002";
const resolution = {
  vaultId,
  invitationId,
  role: "editor" as const,
  authorizationVersion: 1,
  activeRoomId: "vault_room_1234567890",
  snapshotGeneration: 0,
  expiresAt: null,
};

class FakeVaultSocket {
  id = "vault-socket";
  closed = false;
  listeners = new Map<string, Set<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  once(event: string, listener: (...args: any[]) => void) {
    return this.on(event, listener);
  }

  off(event: string, listener?: (...args: any[]) => void) {
    if (listener) {
      this.listeners.get(event)?.delete(listener);
    } else {
      this.listeners.delete(event);
    }
    return this;
  }

  emit(event: string, ...args: any[]) {
    if (event === VAULT_SOCKET_EVENTS.join) {
      const ack = args[1] as (value: unknown) => void;
      ack({ ok: true, resolution });
      return this;
    }
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
    return this;
  }

  close() {
    this.closed = true;
    return this;
  }
}

const createVaultSession = async () => {
  const deployment = assertVaultDeploymentReady(
    {
      enabled: true,
      protocolVersions: [1],
      roomProtocolVersions: [1],
      invitationService: true,
      encryptedSnapshotPersistence: true,
      encryptedAssetPersistence: true,
    },
    { isSecureContext: true, hasWebCrypto: true },
  );
  const unused = async () => {
    throw new Error("unused");
  };
  const persistence = createVaultPersistenceService(deployment, {
    resolveCapability: async () => resolution,
    loadSnapshot: async () => null,
    casSnapshot: unused,
    registerAsset: unused,
    resolveAsset: unused,
  });
  return await openVaultClientSession({
    deployment,
    persistence,
    link: {
      version: 1,
      vaultId,
      rootKey: "A".repeat(43),
      invitationCapability: "B".repeat(43),
    },
    senderSessionId,
  });
};

const createVaultAssetService = () => {
  const deployment = assertVaultDeploymentReady(
    {
      enabled: true,
      protocolVersions: [1],
      roomProtocolVersions: [1],
      invitationService: true,
      encryptedSnapshotPersistence: true,
      encryptedAssetPersistence: true,
    },
    { isSecureContext: true, hasWebCrypto: true },
  );
  return createVaultEncryptedAssetService(deployment, {
    upload: vi.fn(async ({ vaultId, fileId }) => ({
      vaultId,
      fileId,
      encryptedDigest: "A".repeat(43),
      ciphertextBytes: 1,
    })),
    download: vi.fn(async () => {
      throw new Error("unused");
    }),
  });
};

const createCollab = () =>
  new Collab({
    excalidrawAPI: {
      getSceneElementsIncludingDeleted: () => [],
      getAppState: () => ({}),
      updateScene: vi.fn(),
    },
  } as never);

const attachVaultTransport = (collab: Collab) => {
  collab.portal.vaultRealtimeSession = {} as VaultRealtimeSession;
  collab.portal.socketInitialized = true;
};

describe("Collab Vault persistence isolation", () => {
  beforeEach(() => {
    socketClient.mockReset();
    appJotaiStore.set(isCollaboratingAtom, false);
  });

  it("connects an admitted Vault session without legacy room initialization", async () => {
    const socket = new FakeVaultSocket();
    socketClient.mockReturnValue(socket);
    const collab = createCollab();
    collab.state = { ...collab.state, username: "Alice" };
    vi.spyOn(collab, "setActiveRoomLink").mockImplementation(() => {});
    vi.spyOn(collab, "resetErrorIndicator").mockImplementation(() => {});
    const onTeardown = vi.fn();

    await expect(
      collab.startVaultCollaboration(await createVaultSession(), {
        assetService: createVaultAssetService(),
        onTeardown,
      }),
    ).resolves.toBe(true);

    expect(collab.portal.socketInitialized).toBe(true);
    expect(collab.portal.roomKey).toBeNull();
    expect(collab.portal.roomId).toBe(resolution.activeRoomId);
    expect(collab.portal.vaultRealtimeSession).not.toBeNull();
    expect(appJotaiStore.get(isCollaboratingAtom)).toBe(true);
    expect(socket.listeners.has("init-room")).toBe(false);

    const remoteEditorSessionId = "123e4567-e89b-42d3-a456-426614174004";
    const remoteEditor = new VaultRealtimeSession({
      vaultId,
      rootKey: "A".repeat(43),
      role: "editor",
      senderSessionId: remoteEditorSessionId,
    });
    const contentEnvelope = await remoteEditor.encrypt({
      type: WS_SUBTYPES.UPDATE,
      payload: { elements: [] },
    });
    socket.emit(VAULT_SOCKET_EVENTS.server, {
      sourceSocketId: "remote-editor",
      admittedSenderSessionId: remoteEditorSessionId,
      envelope: contentEnvelope,
    });
    await vi.waitFor(() =>
      expect(collab.excalidrawAPI.updateScene).toHaveBeenCalledWith(
        expect.objectContaining({ elements: [] }),
      ),
    );

    const remoteSenderSessionId = "123e4567-e89b-42d3-a456-426614174003";
    const remote = new VaultRealtimeSession({
      vaultId,
      rootKey: "A".repeat(43),
      role: "viewer",
      senderSessionId: remoteSenderSessionId,
    });
    const envelope = await remote.encrypt({
      type: WS_SUBTYPES.IDLE_STATUS,
      payload: {
        socketId: "remote-socket" as SocketId,
        userState: UserIdleState.IDLE,
        username: "Alice",
      },
    });
    socket.emit(VAULT_SOCKET_EVENTS.server, {
      sourceSocketId: "remote-socket",
      admittedSenderSessionId: remoteSenderSessionId,
      envelope,
    });
    await vi.waitFor(() =>
      expect(collab.excalidrawAPI.updateScene).toHaveBeenCalledWith(
        expect.objectContaining({ collaborators: expect.any(Map) }),
      ),
    );

    socket.emit(VAULT_SOCKET_EVENTS.capabilityRevoked, {
      vaultId,
      invitationId,
      authorizationVersion: 2,
      reason: "revoked",
    });
    expect(socket.closed).toBe(true);
    expect(onTeardown).toHaveBeenCalledWith(
      expect.objectContaining({ code: "VAULT_CAPABILITY_REVOKED" }),
    );
    expect(appJotaiStore.get(isCollaboratingAtom)).toBe(false);
  });

  it("forwards Vault disconnect and reconnect recovery callbacks", async () => {
    const socket = new FakeVaultSocket();
    socketClient.mockReturnValue(socket);
    const collab = createCollab();
    vi.spyOn(collab, "setActiveRoomLink").mockImplementation(() => {});
    vi.spyOn(collab, "resetErrorIndicator").mockImplementation(() => {});
    vi.spyOn(collab, "setErrorIndicator").mockImplementation(() => {});
    const onDisconnect = vi.fn();
    const onReconnect = vi.fn(async () => {});

    await expect(
      collab.startVaultCollaboration(await createVaultSession(), {
        assetService: createVaultAssetService(),
        onDisconnect,
        onReconnect,
      }),
    ).resolves.toBe(true);

    socket.emit("disconnect");
    expect(onDisconnect).toHaveBeenCalledWith(
      expect.objectContaining({ code: "VAULT_PERSISTENCE_UNAVAILABLE" }),
    );
    expect(collab.excalidrawAPI.updateScene).toHaveBeenCalledWith({
      appState: {
        viewModeEnabled: true,
        errorMessage: expect.any(String),
      },
    });

    socket.emit("connect");
    await vi.waitFor(() => expect(onReconnect).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(socket.closed).toBe(true));
  });

  it("does not broadcast content from a Vault viewer", () => {
    const collab = createCollab();
    const broadcast = vi.spyOn(collab.portal, "broadcastScene");
    collab.portal.vaultRealtimeSession = {
      role: "viewer",
    } as VaultRealtimeSession;
    collab.syncElements([]);
    expect(broadcast).not.toHaveBeenCalled();
  });
  it("does not queue ordinary collaboration persistence for Vault", () => {
    const collab = createCollab();
    const saveLegacy = vi.spyOn(collab, "saveCollabRoomToPersistence");
    attachVaultTransport(collab);

    collab.queueSaveToPersistence();
    collab.queueSaveToPersistence.flush();

    expect(saveLegacy).not.toHaveBeenCalled();
  });

  it("does not save through ordinary collaboration persistence before unload", () => {
    const collab = createCollab();
    const saveLegacy = vi.spyOn(collab, "saveCollabRoomToPersistence");
    attachVaultTransport(collab);

    (
      collab as unknown as { beforeUnload: (event: BeforeUnloadEvent) => void }
    ).beforeUnload({} as BeforeUnloadEvent);

    expect(saveLegacy).not.toHaveBeenCalled();
  });

  it("does not save through ordinary collaboration persistence when stopping Vault", () => {
    const collab = createCollab();
    const saveLegacy = vi.spyOn(collab, "saveCollabRoomToPersistence");
    vi.spyOn(collab, "resetErrorIndicator").mockImplementation(() => {});
    vi.spyOn(collab, "setActiveRoomLink").mockImplementation(() => {});
    vi.spyOn(window, "confirm").mockReturnValue(false);
    attachVaultTransport(collab);

    collab.stopCollaboration();

    expect(saveLegacy).not.toHaveBeenCalled();
  });

  it("keeps ordinary collaboration queue and stop saves unchanged", () => {
    const collab = createCollab();
    const saveLegacy = vi
      .spyOn(collab, "saveCollabRoomToPersistence")
      .mockResolvedValue();
    vi.spyOn(collab, "resetErrorIndicator").mockImplementation(() => {});
    vi.spyOn(window, "confirm").mockReturnValue(false);
    collab.portal.socketInitialized = true;

    collab.queueSaveToPersistence();
    collab.queueSaveToPersistence.flush();
    collab.stopCollaboration();

    expect(saveLegacy).toHaveBeenCalledTimes(2);
  });
});
