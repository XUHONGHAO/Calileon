import { describe, expect, it } from "vitest";

import {
  acceptVaultRealtimeEnvelope,
  assertVaultEncryptedEnvelopeV1,
  canVaultRoleSendMessage,
  createVaultReplayState,
  encodeVaultEnvelopeAadV1,
} from "./protocol";

import type {
  VaultEnvelopeContextV1,
  VaultRealtimeEncryptedEnvelopeV1,
} from "./types";

const vaultId = "123e4567-e89b-42d3-a456-426614174000";
const messageId = "123e4567-e89b-42d3-a456-426614174001";
const senderSessionId = "123e4567-e89b-42d3-a456-426614174002";

const realtimeContext: VaultEnvelopeContextV1 = {
  version: 1,
  vaultId,
  purpose: "realtime",
  messageType: "realtime.content",
  messageId,
  senderSessionId,
  sequence: 1,
};

const realtimeEnvelope: VaultRealtimeEncryptedEnvelopeV1 = {
  ...realtimeContext,
  purpose: "realtime",
  messageType: "realtime.content",
  senderSessionId,
  sequence: 1,
  iv: "A".repeat(16),
  ciphertext: "A".repeat(22),
};

describe("Vault envelope v1 contract", () => {
  it("uses a canonical UTF-8 JSON array for AAD", () => {
    expect(
      new TextDecoder().decode(encodeVaultEnvelopeAadV1(realtimeContext)),
    ).toBe(
      `["excalidraw-vault-envelope",1,"${vaultId}","realtime","realtime.content","${messageId}","${senderSessionId}",1,null]`,
    );
  });

  it("rejects unknown or purpose-incompatible fields", () => {
    expect(() =>
      assertVaultEncryptedEnvelopeV1({
        ...realtimeEnvelope,
        generation: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "VAULT_ENVELOPE_INVALID" }));

    expect(() =>
      assertVaultEncryptedEnvelopeV1({
        ...realtimeEnvelope,
        messageType: "future.message",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_MESSAGE_TYPE_UNSUPPORTED" }),
    );
  });

  it("freezes viewer/editor message authorization", () => {
    expect(canVaultRoleSendMessage("viewer", "realtime.presence")).toBe(true);
    expect(canVaultRoleSendMessage("viewer", "realtime.content")).toBe(false);
    expect(canVaultRoleSendMessage("viewer", "snapshot.scene")).toBe(false);
    expect(canVaultRoleSendMessage("viewer", "asset.content")).toBe(false);
    expect(canVaultRoleSendMessage("editor", "realtime.content")).toBe(true);
    expect(canVaultRoleSendMessage("editor", "snapshot.scene")).toBe(true);
  });

  it("rejects duplicate message IDs and non-increasing session sequences", () => {
    const state = createVaultReplayState();
    acceptVaultRealtimeEnvelope(state, realtimeEnvelope);

    expect(() =>
      acceptVaultRealtimeEnvelope(state, realtimeEnvelope),
    ).toThrowError(expect.objectContaining({ code: "VAULT_REPLAY_REJECTED" }));
    expect(() =>
      acceptVaultRealtimeEnvelope(state, {
        ...realtimeEnvelope,
        messageId: "123e4567-e89b-42d3-a456-426614174003",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_SEQUENCE_REJECTED" }),
    );
  });

  it("bounds the message ID replay window", () => {
    const state = createVaultReplayState(1);
    acceptVaultRealtimeEnvelope(state, realtimeEnvelope);
    acceptVaultRealtimeEnvelope(state, {
      ...realtimeEnvelope,
      messageId: "123e4567-e89b-42d3-a456-426614174003",
      sequence: 2,
    });
    expect(state.seenMessageIds.has(realtimeEnvelope.messageId)).toBe(false);
  });
});
