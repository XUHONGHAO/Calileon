import { UserIdleState } from "@excalidraw/common";
import { describe, expect, it } from "vitest";

import type { SocketId } from "@excalidraw/excalidraw/types";

import { WS_SUBTYPES } from "../../app_constants";

import { encryptVaultJson, generateVaultRootKey } from "./crypto";
import { getVaultRealtimeMessageType, VaultRealtimeSession } from "./realtime";

const vaultId = "123e4567-e89b-42d3-a456-426614174000";
const socketId = (value: string) => value as SocketId;

const sceneUpdate = {
  type: WS_SUBTYPES.UPDATE,
  payload: { elements: [] },
} as const;

const followUpdate = {
  type: WS_SUBTYPES.USER_FOLLOW_CHANGE,
  payload: {
    action: "FOLLOW",
    userToFollow: {
      socketId: socketId("socket-target"),
      username: "P4-PLAINTEXT-SENTINEL-20260713",
    },
  },
} as const;

describe("Vault realtime session", () => {
  it("classifies every content and presence family explicitly", () => {
    expect(getVaultRealtimeMessageType(sceneUpdate)).toBe("realtime.content");
    expect(getVaultRealtimeMessageType(followUpdate)).toBe("realtime.presence");
    expect(() =>
      getVaultRealtimeMessageType({ type: "FUTURE_EVENT" } as never),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_MESSAGE_TYPE_UNSUPPORTED" }),
    );
  });

  it("encrypts follow state and keeps its concrete subtype inside ciphertext", async () => {
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

    const envelope = await sender.encrypt(followUpdate);

    expect(envelope.messageType).toBe("realtime.presence");
    expect(JSON.stringify(envelope)).not.toContain("USER_FOLLOW_CHANGE");
    expect(JSON.stringify(envelope)).not.toContain(
      "P4-PLAINTEXT-SENTINEL-20260713",
    );
    await expect(
      receiver.decrypt(envelope, {
        sourceSocketId: socketId("sender-socket"),
        admittedSenderSessionId: sender.senderSessionId,
      }),
    ).resolves.toEqual({
      payload: followUpdate,
      sourceSocketId: socketId("sender-socket"),
    });
  });

  it("prevents viewer content writes before encryption", async () => {
    const session = new VaultRealtimeSession({
      vaultId,
      rootKey: generateVaultRootKey(),
      role: "viewer",
    });
    await expect(session.encrypt(sceneUpdate)).rejects.toEqual(
      expect.objectContaining({ code: "VAULT_CAPABILITY_FORBIDDEN" }),
    );
  });

  it("rejects an inner content event wrapped as presence", async () => {
    const rootKey = generateVaultRootKey();
    const receiver = new VaultRealtimeSession({
      vaultId,
      rootKey,
      role: "editor",
    });
    const admittedSenderSessionId = crypto.randomUUID();
    const envelope = await encryptVaultJson(
      rootKey,
      {
        version: 1,
        vaultId,
        purpose: "realtime",
        messageType: "realtime.presence",
        messageId: crypto.randomUUID(),
        senderSessionId: admittedSenderSessionId,
        sequence: 1,
      },
      sceneUpdate,
    );

    await expect(
      receiver.decrypt(envelope as never, {
        sourceSocketId: socketId("sender-socket"),
        admittedSenderSessionId,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "VAULT_ENVELOPE_INVALID" }),
    );
  });

  it("does not consume replay state until authentication succeeds", async () => {
    const rootKey = generateVaultRootKey();
    const sender = new VaultRealtimeSession({
      vaultId,
      rootKey,
      role: "editor",
    });
    const receiver = new VaultRealtimeSession({
      vaultId,
      rootKey,
      role: "editor",
    });
    const envelope = await sender.encrypt(sceneUpdate);
    const tampered = {
      ...envelope,
      ciphertext: `${
        envelope.ciphertext[0] === "A" ? "B" : "A"
      }${envelope.ciphertext.slice(1)}`,
    };

    await expect(
      receiver.decrypt(tampered, {
        sourceSocketId: socketId("sender-socket"),
        admittedSenderSessionId: sender.senderSessionId,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "VAULT_DECRYPT_FAILED" }),
    );
    await expect(
      receiver.decrypt(envelope, {
        sourceSocketId: socketId("sender-socket"),
        admittedSenderSessionId: sender.senderSessionId,
      }),
    ).resolves.toEqual({
      payload: sceneUpdate,
      sourceSocketId: socketId("sender-socket"),
    });
    await expect(
      receiver.decrypt(envelope, {
        sourceSocketId: socketId("sender-socket"),
        admittedSenderSessionId: sender.senderSessionId,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "VAULT_REPLAY_REJECTED" }),
    );
  });

  it("rejects spoofed presence socket IDs", async () => {
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
    const envelope = await sender.encrypt({
      type: WS_SUBTYPES.IDLE_STATUS,
      payload: {
        socketId: socketId("spoofed-socket"),
        userState: UserIdleState.IDLE,
        username: "Alice",
      },
    });

    await expect(
      receiver.decrypt(envelope, {
        sourceSocketId: socketId("admitted-socket"),
        admittedSenderSessionId: sender.senderSessionId,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "VAULT_ENVELOPE_INVALID" }),
    );
  });

  it("rejects a spoofed sender sequence namespace from the transport", async () => {
    const rootKey = generateVaultRootKey();
    const sender = new VaultRealtimeSession({
      vaultId,
      rootKey,
      role: "editor",
    });
    const receiver = new VaultRealtimeSession({
      vaultId,
      rootKey,
      role: "editor",
    });
    const envelope = await sender.encrypt(sceneUpdate);

    await expect(
      receiver.decrypt(envelope, {
        sourceSocketId: socketId("sender-socket"),
        admittedSenderSessionId: crypto.randomUUID(),
      }),
    ).rejects.toEqual(
      expect.objectContaining({ code: "VAULT_ENVELOPE_INVALID" }),
    );
  });

  it("clears key material when the session is destroyed", async () => {
    const session = new VaultRealtimeSession({
      vaultId,
      rootKey: generateVaultRootKey(),
      role: "editor",
    });
    session.destroy();
    await expect(session.encrypt(sceneUpdate)).rejects.toEqual(
      expect.objectContaining({ code: "VAULT_KEY_INVALID" }),
    );
  });
});
