import { UserIdleState } from "@excalidraw/common";
import { describe, expect, it, vi } from "vitest";

import type { SocketId } from "@excalidraw/excalidraw/types";

import { WS_EVENTS, WS_SUBTYPES } from "../app_constants";
import {
  assertVaultDeploymentReady,
  generateVaultRootKey,
  issueVaultAdmission,
  VAULT_SOCKET_EVENTS,
  VaultRealtimeSession,
} from "../data/vault";

import Portal from "./Portal";

import type { VaultAdmission, VaultCapabilityResolution } from "../data/vault";
import type { Socket } from "socket.io-client";

const vaultId = "123e4567-e89b-42d3-a456-426614174000";
const socketId = (value: string) => value as SocketId;
const activeRoomId = "vault_room_1234567890";
const createDeploymentReady = () =>
  assertVaultDeploymentReady(
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
const createAdmission = (
  session: VaultRealtimeSession,
  overrides: Partial<VaultCapabilityResolution> = {},
) =>
  issueVaultAdmission(
    createDeploymentReady(),
    {
      vaultId,
      invitationId: "123e4567-e89b-42d3-a456-426614174002",
      role: session.role,
      authorizationVersion: 1,
      activeRoomId,
      snapshotGeneration: 0,
      expiresAt: null,
      ...overrides,
    },
    session.senderSessionId,
  );

const createSocket = () =>
  ({
    id: "socket-1",
    on: vi.fn(),
    emit: vi.fn(),
    close: vi.fn(),
  } as unknown as Socket);

const createPortal = () =>
  new Portal({
    state: { username: "Alice" },
    getSceneElementsIncludingDeleted: () => [],
    setCollaborators: vi.fn(),
  } as never);

describe("Portal Vault transport isolation", () => {
  it("keeps ordinary follow routing unchanged", () => {
    const socket = createSocket();
    const portal = createPortal();
    portal.open(socket, "room-id", "sTdLvMC_M3V8_vGa3UVRDg");

    expect(vi.mocked(socket.on).mock.calls.map(([event]) => event)).toEqual([
      "init-room",
      "new-user",
      "room-user-change",
    ]);

    const payload = {
      action: "FOLLOW",
      userToFollow: { socketId: socketId("target"), username: "Alice" },
    } as const;
    portal.broadcastUserFollowed(payload);

    expect(socket.emit).toHaveBeenCalledWith(
      WS_EVENTS.USER_FOLLOW_CHANGE,
      payload,
    );
  });

  it("routes Vault follow state only through an encrypted volatile envelope", async () => {
    const socket = createSocket();
    const portal = createPortal();
    const rootKey = generateVaultRootKey();
    const sender = new VaultRealtimeSession({
      vaultId,
      rootKey,
      role: "viewer",
    });
    const receiver = new VaultRealtimeSession({
      vaultId,
      rootKey,
      role: "editor",
    });
    portal.openVaultTransport(createAdmission(sender), socket, sender);
    portal.socketInitialized = true;

    expect(socket.on).not.toHaveBeenCalled();

    const payload = {
      action: "FOLLOW",
      userToFollow: {
        socketId: socketId("target"),
        username: "P4-PLAINTEXT-SENTINEL-20260713",
      },
    } as const;
    await portal.broadcastUserFollowed(payload);

    expect(socket.emit).toHaveBeenCalledTimes(1);
    const [event, roomId, envelope] = vi.mocked(socket.emit).mock.calls[0];
    expect(event).toBe(VAULT_SOCKET_EVENTS.serverVolatile);
    expect(roomId).toBe(activeRoomId);
    expect(JSON.stringify(envelope)).not.toContain(
      payload.userToFollow.username,
    );
    await expect(
      receiver.decrypt(envelope as never, {
        sourceSocketId: socketId("socket-1"),
        admittedSenderSessionId: sender.senderSessionId,
      }),
    ).resolves.toEqual({
      sourceSocketId: socketId("socket-1"),
      payload: {
        type: WS_SUBTYPES.USER_FOLLOW_CHANGE,
        payload,
      },
    });
  });

  it("serializes Vault encryption and emission in sequence order", async () => {
    const socket = createSocket();
    const portal = createPortal();
    const session = new VaultRealtimeSession({
      vaultId,
      rootKey: generateVaultRootKey(),
      role: "viewer",
    });
    portal.openVaultTransport(createAdmission(session), socket, session);
    portal.socketInitialized = true;

    await Promise.all([
      portal.broadcastIdleChange(UserIdleState.ACTIVE),
      portal.broadcastIdleChange(UserIdleState.IDLE),
    ]);

    const sequences = vi
      .mocked(socket.emit)
      .mock.calls.map((call) => (call[2] as { sequence: number }).sequence);
    expect(sequences).toEqual([1, 2]);
  });

  it("rejects forged admission tokens before attaching the socket", () => {
    const socket = createSocket();
    const portal = createPortal();
    const session = new VaultRealtimeSession({
      vaultId,
      rootKey: generateVaultRootKey(),
      role: "editor",
    });
    const forgedAdmission = {
      kind: "vault-admission",
      vaultId,
      activeRoomId,
      role: "editor",
      authorizationVersion: 1,
      invitationId: "123e4567-e89b-42d3-a456-426614174002",
      senderSessionId: session.senderSessionId,
      expiresAt: null,
    } as unknown as VaultAdmission;

    expect(() =>
      portal.openVaultTransport(forgedAdmission, socket, session),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_CAPABILITY_INVALID" }),
    );
    expect(portal.socket).toBeNull();
    expect(portal.roomId).toBeNull();
    expect(portal.vaultRealtimeSession).toBeNull();
    expect(socket.on).not.toHaveBeenCalled();
  });

  it.each([
    ["vaultId", { vaultId: "123e4567-e89b-42d3-a456-426614174099" }],
    ["role", { role: "viewer" as const }],
  ])("rejects a realtime session with mismatched %s", (_field, overrides) => {
    const socket = createSocket();
    const portal = createPortal();
    const session = new VaultRealtimeSession({
      vaultId,
      rootKey: generateVaultRootKey(),
      role: "editor",
    });
    const admission = createAdmission(session, overrides);

    expect(() =>
      portal.openVaultTransport(admission, socket, session),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_CAPABILITY_INVALID" }),
    );
    expect(portal.socket).toBeNull();
  });

  it("rejects a realtime session with a mismatched sender session", () => {
    const socket = createSocket();
    const portal = createPortal();
    const admittedSession = new VaultRealtimeSession({
      vaultId,
      rootKey: generateVaultRootKey(),
      role: "editor",
    });
    const attachedSession = new VaultRealtimeSession({
      vaultId,
      rootKey: generateVaultRootKey(),
      role: "editor",
    });

    expect(() =>
      portal.openVaultTransport(
        createAdmission(admittedSession),
        socket,
        attachedSession,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_CAPABILITY_INVALID" }),
    );
    expect(portal.socket).toBeNull();
  });

  it("never invokes the legacy file upload while Vault transport is active", async () => {
    const saveFiles = vi.fn().mockResolvedValue({
      savedFiles: new Map(),
      erroredFiles: new Map(),
    });
    const saveVaultFiles = vi.fn().mockResolvedValue({
      savedFiles: new Map(),
      erroredFiles: new Map(),
    });
    const portal = new Portal({
      state: { username: "Alice" },
      fileManager: { saveFiles },
      vaultFileManager: {
        saveFiles: saveVaultFiles,
        shouldUpdateImageElementStatus: () => false,
      },
      excalidrawAPI: {
        getSceneElementsIncludingDeleted: () => [],
        getFiles: () => ({}),
        updateScene: vi.fn(),
      },
      setCollaborators: vi.fn(),
    } as never);
    const session = new VaultRealtimeSession({
      vaultId,
      rootKey: generateVaultRootKey(),
      role: "editor",
    });
    portal.openVaultTransport(
      createAdmission(session),
      createSocket(),
      session,
    );

    portal.queueFileUpload();
    portal.queueFileUpload.flush();
    await Promise.resolve();

    expect(saveFiles).not.toHaveBeenCalled();
    expect(saveVaultFiles).toHaveBeenCalledOnce();
  });
});
