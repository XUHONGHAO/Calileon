import { describe, expect, it, vi } from "vitest";

import type { SocketId } from "@excalidraw/excalidraw/types";

import { WS_SUBTYPES } from "../../app_constants";

import { VAULT_SOCKET_EVENTS } from "./backendContract";
import { assertVaultDeploymentReady } from "./capabilities";
import { createVaultPersistenceService } from "./persistence";
import { VaultRealtimeSession } from "./realtime";
import { openVaultClientSession } from "./session";
import { VaultRealtimeTransport } from "./transport";

const vaultId = "123e4567-e89b-42d3-a456-426614174000";
const invitationId = "123e4567-e89b-42d3-a456-426614174001";
const senderSessionId = "123e4567-e89b-42d3-a456-426614174002";
const remoteSenderSessionId = "123e4567-e89b-42d3-a456-426614174003";
const rootKey = "A".repeat(43);
const invitationCapability = "B".repeat(43);

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

const resolution = {
  vaultId,
  invitationId,
  role: "editor" as const,
  authorizationVersion: 1,
  activeRoomId: "vault_room_1234567890",
  snapshotGeneration: 0,
  expiresAt: null,
};

class FakeSocket {
  listeners = new Map<string, Set<(...args: any[]) => void>>();
  closed = false;
  joinAck: unknown = { ok: true, resolution };
  joinCount = 0;
  lastJoinRequest: unknown = null;
  // When set, the join ack is held until the test releases it.
  deferJoinAck = false;
  pendingJoinAck: (() => void) | null = null;

  on(event: string, listener: (...args: any[]) => void) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: (...args: any[]) => void) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: any[]) {
    if (event === VAULT_SOCKET_EVENTS.join) {
      this.joinCount += 1;
      this.lastJoinRequest = args[0];
      const ack = args[1] as (value: unknown) => void;
      if (this.deferJoinAck) {
        this.pendingJoinAck = () => ack(this.joinAck);
        return;
      }
      ack(this.joinAck);
      return;
    }
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }

  close() {
    this.closed = true;
  }
}

const createClientSession = async () => {
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
    link: { version: 1, vaultId, rootKey, invitationCapability },
    senderSessionId,
  });
};

describe("Vault realtime transport", () => {
  it("joins with the raw capability only in the socket admission request", async () => {
    const socket = new FakeSocket();
    const transport = new VaultRealtimeTransport({
      clientSession: await createClientSession(),
      socket,
      callbacks: { onMessage: vi.fn() },
    });
    await transport.connect();
    expect(socket.lastJoinRequest).toEqual({
      protocolVersion: 1,
      vaultId,
      invitationCapability,
      senderSessionId,
    });
    transport.dispose();
  });

  it("decrypts and emits only validated incoming messages", async () => {
    const onMessage = vi.fn();
    const socket = new FakeSocket();
    const transport = new VaultRealtimeTransport({
      clientSession: await createClientSession(),
      socket,
      callbacks: { onMessage },
    });
    await transport.connect();
    const remote = new VaultRealtimeSession({
      vaultId,
      rootKey,
      role: "editor",
      senderSessionId: remoteSenderSessionId,
    });
    const payload = {
      type: WS_SUBTYPES.UPDATE,
      payload: { elements: [] },
    } as const;
    const envelope = await remote.encrypt(payload);
    socket.emit(VAULT_SOCKET_EVENTS.server, {
      sourceSocketId: "remote-socket",
      admittedSenderSessionId: remoteSenderSessionId,
      envelope,
    });
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledOnce());
    expect(onMessage).toHaveBeenCalledWith({
      payload,
      sourceSocketId: "remote-socket" as SocketId,
    });
    transport.dispose();
  });

  it("rejects a stale or injected join resolution", async () => {
    const socket = new FakeSocket();
    socket.joinAck = {
      ok: true,
      resolution: { ...resolution, snapshotGeneration: 1 },
    };
    const transport = new VaultRealtimeTransport({
      clientSession: await createClientSession(),
      socket,
      callbacks: { onMessage: vi.fn() },
    });
    await expect(transport.connect()).rejects.toMatchObject({
      code: "VAULT_CAPABILITY_INVALID",
    });
    expect(socket.closed).toBe(true);
  });

  it("waits longer than the room server's 5 s capability resolve before giving up", async () => {
    const clientSession = await createClientSession();
    vi.useFakeTimers();
    try {
      // A resolve that takes as long as the server's own timeout still admits.
      const slow = new FakeSocket();
      slow.deferJoinAck = true;
      const admitted = new VaultRealtimeTransport({
        clientSession,
        socket: slow,
        callbacks: { onMessage: vi.fn() },
      });
      const joined = admitted.connect();
      await vi.advanceTimersByTimeAsync(5_500);
      expect(slow.closed).toBe(false);
      slow.pendingJoinAck!();
      await expect(joined).resolves.toBe(admitted);
      admitted.dispose();

      // No ack at all still fails closed once the client timeout elapses.
      const silent = new FakeSocket();
      silent.deferJoinAck = true;
      const onTeardown = vi.fn();
      const timedOut = new VaultRealtimeTransport({
        clientSession,
        socket: silent,
        callbacks: { onMessage: vi.fn(), onTeardown },
      });
      const failed = timedOut.connect();
      const assertion = expect(failed).rejects.toMatchObject({
        code: "VAULT_PERSISTENCE_UNAVAILABLE",
      });
      await vi.advanceTimersByTimeAsync(8_000);
      await assertion;
      expect(silent.closed).toBe(true);
      expect(onTeardown).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed and reopens from persistence after a socket reconnect", async () => {
    const onDisconnect = vi.fn();
    const onReconnect = vi.fn(async () => {});
    const socket = new FakeSocket();
    const transport = new VaultRealtimeTransport({
      clientSession: await createClientSession(),
      socket,
      callbacks: { onMessage: vi.fn(), onDisconnect, onReconnect },
    });
    await transport.connect();

    socket.emit("disconnect");
    expect(onDisconnect).toHaveBeenCalledWith(
      expect.objectContaining({ code: "VAULT_PERSISTENCE_UNAVAILABLE" }),
    );

    socket.emit("connect");
    await vi.waitFor(() => expect(onReconnect).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(socket.closed).toBe(true));
    expect(socket.joinCount).toBe(1);
  });

  it("tears down immediately on a matching revoke notice", async () => {
    const onTeardown = vi.fn();
    const socket = new FakeSocket();
    const transport = new VaultRealtimeTransport({
      clientSession: await createClientSession(),
      socket,
      callbacks: { onMessage: vi.fn(), onTeardown },
    });
    await transport.connect();
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
  });
});
