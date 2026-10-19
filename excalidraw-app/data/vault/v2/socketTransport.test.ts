import { VAULT_SOCKET_EVENTS } from "../backendContract";
import { VaultError } from "../errors";

import {
  VaultV2SocketTransport,
  parseVaultV2Admission,
} from "./socketTransport";

import type { VaultEnvelopeV2 } from "./protocol";
import type { VaultV2Socket } from "./socketTransport";

const VAULT_ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const INVITATION_ID = "223e4567-e89b-42d3-a456-426614174000";
const ROOM_ID = "room_1234567890abcdef";
const CAPABILITY = "A".repeat(43);

const resolution = (overrides: Record<string, unknown> = {}) => ({
  vaultId: VAULT_ID,
  invitationId: INVITATION_ID,
  role: "editor",
  authorizationVersion: 1,
  activeRoomId: ROOM_ID,
  snapshotGeneration: 0,
  expiresAt: null,
  protocolVersion: 2,
  ...overrides,
});

const envelope = (
  overrides: Partial<VaultEnvelopeV2> = {},
): VaultEnvelopeV2 => ({
  version: 2,
  schemaVersion: 2,
  protocolVersion: 2,
  vaultId: VAULT_ID,
  roomId: ROOM_ID,
  purpose: "realtime.content",
  messageType: "sync.update",
  messageId: "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d",
  generation: 0,
  chunkIndex: 0,
  chunkCount: 1,
  iv: "AAAAAAAAAAAAAAAA",
  ciphertext: "A".repeat(22),
  ...overrides,
});

type Emitted = { event: string; args: any[] };

const fakeSocket = (respond: (event: string, args: any[]) => unknown) => {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const emitted: Emitted[] = [];
  const socket: VaultV2Socket & {
    emitted: Emitted[];
    fire: (event: string, ...args: any[]) => void;
    connected: boolean;
  } = {
    connected: true,
    emitted,
    on: (event, listener) => {
      if (!listeners.has(event)) {
        listeners.set(event, new Set());
      }
      listeners.get(event)!.add(listener);
    },
    off: (event, listener) => {
      listeners.get(event)?.delete(listener);
    },
    emit: (event, ...args) => {
      emitted.push({ event, args });
      const ack = args[args.length - 1];
      if (typeof ack === "function") {
        const reply = respond(event, args);
        if (reply !== undefined) {
          ack(reply);
        }
      }
    },
    fire: (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    },
  };
  return socket;
};

const okSocket = () =>
  fakeSocket((event) =>
    event === VAULT_SOCKET_EVENTS.join
      ? { ok: true, resolution: resolution() }
      : { ok: true },
  );

const transport = (
  socket: VaultV2Socket,
  extra: Partial<ConstructorParameters<typeof VaultV2SocketTransport>[0]> = {},
) =>
  new VaultV2SocketTransport({
    socket,
    vaultId: VAULT_ID,
    invitationCapability: CAPABILITY,
    ...extra,
  });

describe("Vault v2 socket transport (W2 S-1…S-5)", () => {
  it("joins with the v2 request shape and no sender session (S-1/S-3)", async () => {
    const socket = okSocket();
    const t = transport(socket);
    const admission = await t.join();
    expect(admission.activeRoomId).toBe(ROOM_ID);
    expect(t.isConnected()).toBe(true);
    const join = socket.emitted.find(
      (e) => e.event === VAULT_SOCKET_EVENTS.join,
    )!;
    expect(join.args[0]).toEqual({
      protocolVersion: 2,
      vaultId: VAULT_ID,
      invitationCapability: CAPABILITY,
    });
  });

  it("refuses a v1 or foreign admission", () => {
    expect(() =>
      parseVaultV2Admission(resolution({ protocolVersion: 1 }), VAULT_ID),
    ).toThrow(VaultError);
    const { protocolVersion: _omit, ...v1 } = resolution();
    expect(() => parseVaultV2Admission(v1, VAULT_ID)).toThrow(VaultError);
    expect(() =>
      parseVaultV2Admission(
        resolution({ vaultId: "7f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b" }),
        VAULT_ID,
      ),
    ).toThrow(VaultError);
    expect(() =>
      parseVaultV2Admission(resolution({ expiresAt: 5 }), VAULT_ID, 10),
    ).toThrow(VaultError);
  });

  it("blocks on an authorization rejection at join", async () => {
    const socket = fakeSocket(() => ({
      ok: false,
      code: "VAULT_CAPABILITY_REVOKED",
    }));
    const onBlocked = vi.fn();
    const t = transport(socket, { onBlocked });
    await expect(t.join()).rejects.toMatchObject({
      code: "VAULT_CAPABILITY_REVOKED",
    });
    expect(onBlocked).toHaveBeenCalledTimes(1);
    await expect(t.join()).rejects.toMatchObject({
      code: "VAULT_CAPABILITY_REVOKED",
    });
  });

  it("does not block on a transient join failure", async () => {
    const socket = fakeSocket(() => ({
      ok: false,
      code: "VAULT_PERSISTENCE_UNAVAILABLE",
    }));
    const onBlocked = vi.fn();
    const t = transport(socket, { onBlocked });
    await expect(t.join()).rejects.toThrow(VaultError);
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it("sends reliable envelopes with ack and presence as volatile", async () => {
    const socket = okSocket();
    const t = transport(socket);
    await t.join();
    await t.send([envelope(), envelope({ chunkIndex: 0 })], {
      volatile: false,
    });
    await t.send(
      [
        envelope({
          purpose: "realtime.presence",
          messageType: "presence.ephemeral",
        }),
      ],
      { volatile: true },
    );
    const sent = socket.emitted.filter(
      (e) => e.event !== VAULT_SOCKET_EVENTS.join,
    );
    expect(sent.map((e) => e.event)).toEqual([
      VAULT_SOCKET_EVENTS.server,
      VAULT_SOCKET_EVENTS.server,
      VAULT_SOCKET_EVENTS.serverVolatile,
    ]);
    expect(sent[0].args[0]).toBe(ROOM_ID);
    expect(sent[2].args).toHaveLength(2);
  });

  it("rejects a send the relay refuses, and refuses to send offline", async () => {
    const socket = fakeSocket((event) =>
      event === VAULT_SOCKET_EVENTS.join
        ? { ok: true, resolution: resolution() }
        : { ok: false, code: "VAULT_PAYLOAD_TOO_LARGE" },
    );
    const t = transport(socket);
    await t.join();
    await expect(
      t.send([envelope()], { volatile: false }),
    ).rejects.toMatchObject({ code: "VAULT_PAYLOAD_TOO_LARGE" });
    socket.fire("disconnect");
    expect(t.isConnected()).toBe(false);
    await expect(
      t.send([envelope()], { volatile: false }),
    ).rejects.toMatchObject({ code: "VAULT_PERSISTENCE_UNAVAILABLE" });
  });

  it("delivers only well-formed `{ envelope }` frames of this room (S-4)", async () => {
    const socket = okSocket();
    const t = transport(socket);
    const received: unknown[] = [];
    t.onEnvelope((e) => received.push(e));
    // before admission nothing is delivered
    socket.fire(VAULT_SOCKET_EVENTS.server, { envelope: envelope() });
    await t.join();
    socket.fire(VAULT_SOCKET_EVENTS.server, { envelope: envelope() });
    socket.fire(VAULT_SOCKET_EVENTS.server, {
      envelope: envelope(),
      sourceSocketId: "s",
    });
    socket.fire(VAULT_SOCKET_EVENTS.server, {
      envelope: envelope({ roomId: "room_other_1234567" }),
    });
    socket.fire(VAULT_SOCKET_EVENTS.server, {
      envelope: { ...envelope(), senderSessionId: INVITATION_ID },
    });
    expect(received).toHaveLength(1);
  });

  it("blocks on a matching revoke notice, ignores foreign ones", async () => {
    const socket = okSocket();
    const onBlocked = vi.fn();
    const t = transport(socket, { onBlocked });
    await t.join();
    const notice = {
      vaultId: VAULT_ID,
      invitationId: INVITATION_ID,
      authorizationVersion: 2,
      reason: "revoked",
    };
    socket.fire(VAULT_SOCKET_EVENTS.capabilityRevoked, {
      ...notice,
      invitationId: "323e4567-e89b-42d3-a456-426614174000",
    });
    expect(onBlocked).not.toHaveBeenCalled();
    socket.fire(VAULT_SOCKET_EVENTS.capabilityRevoked, notice);
    expect(onBlocked).toHaveBeenCalledWith(
      expect.objectContaining({ code: "VAULT_CAPABILITY_REVOKED" }),
    );
    expect(t.isConnected()).toBe(false);
  });

  it("re-joins after a disconnect and detaches on dispose", async () => {
    const socket = okSocket();
    const onDisconnect = vi.fn();
    const t = transport(socket, { onDisconnect });
    await t.join();
    socket.fire("disconnect");
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    await t.join();
    expect(t.isConnected()).toBe(true);
    t.dispose();
    expect(t.isConnected()).toBe(false);
    socket.fire("disconnect");
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });
});
