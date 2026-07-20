import { describe, expect, it } from "vitest";

import { WS_SUBTYPES } from "../../app_constants";

import {
  assertVaultAdmissionToken,
  assertVaultCapabilityResolution,
  assertVaultSocketBroadcastForAdmission,
  assertVaultSocketJoinRequest,
  isVaultAdmission,
  issueVaultAdmission,
} from "./admission";
import { assertVaultDeploymentReady } from "./capabilities";
import { generateVaultRootKey } from "./crypto";
import { VaultRealtimeSession } from "./realtime";

import type { VaultAdmission } from "./admission";
import type { VaultCapabilityResolution } from "./types";

const NOW = 1_800_000_000_000;
const senderSessionId = "123e4567-e89b-42d3-a456-426614174001";
const resolution: VaultCapabilityResolution = {
  vaultId: "123e4567-e89b-42d3-a456-426614174000",
  invitationId: "123e4567-e89b-42d3-a456-426614174002",
  role: "editor",
  authorizationVersion: 3,
  activeRoomId: "vault_room_1234567890",
  snapshotGeneration: 7,
  expiresAt: NOW + 60_000,
};

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

describe("Vault capability admission", () => {
  it("issues an immutable runtime proof bound to the resolved grant", () => {
    const admission = issueVaultAdmission(
      createDeploymentReady(),
      resolution,
      senderSessionId,
      NOW,
    );

    expect(admission).toMatchObject({
      kind: "vault-admission",
      vaultId: resolution.vaultId,
      activeRoomId: resolution.activeRoomId,
      role: resolution.role,
      authorizationVersion: resolution.authorizationVersion,
      invitationId: resolution.invitationId,
      senderSessionId,
      expiresAt: resolution.expiresAt,
    });
    expect(Object.isFrozen(admission)).toBe(true);
    expect(isVaultAdmission(admission, NOW)).toBe(true);
    expect(() => assertVaultAdmissionToken(admission, NOW)).not.toThrow();
  });

  it("rejects forged and expired admission proofs", () => {
    const forged = {
      kind: "vault-admission",
      ...resolution,
      senderSessionId,
    } as unknown as VaultAdmission;
    expect(isVaultAdmission(forged, NOW)).toBe(false);
    expect(() => assertVaultAdmissionToken(forged, NOW)).toThrowError(
      expect.objectContaining({ code: "VAULT_CAPABILITY_INVALID" }),
    );

    const admission = issueVaultAdmission(
      createDeploymentReady(),
      resolution,
      senderSessionId,
      NOW,
    );
    expect(() =>
      assertVaultAdmissionToken(admission, resolution.expiresAt!),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_CAPABILITY_EXPIRED" }),
    );
  });

  it.each([
    [{ ...resolution, role: "owner" }, "VAULT_CAPABILITY_INVALID"],
    [{ ...resolution, authorizationVersion: 0 }, "VAULT_CAPABILITY_INVALID"],
    [{ ...resolution, snapshotGeneration: -1 }, "VAULT_CAPABILITY_INVALID"],
    [
      { ...resolution, activeRoomId: "legacy-room" },
      "VAULT_CAPABILITY_INVALID",
    ],
    [{ ...resolution, state: "revoked" }, "VAULT_CAPABILITY_INVALID"],
    [{ ...resolution, expiresAt: NOW }, "VAULT_CAPABILITY_EXPIRED"],
  ] as const)(
    "fails closed for malformed or illegal resolution",
    (value, code) => {
      expect(() => assertVaultCapabilityResolution(value, NOW)).toThrowError(
        expect.objectContaining({ code }),
      );
    },
  );

  it("rejects a non-v4 sender session during issuance", () => {
    expect(() =>
      issueVaultAdmission(
        createDeploymentReady(),
        resolution,
        "123e4567-e89b-12d3-a456-426614174000",
        NOW,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_CAPABILITY_INVALID" }),
    );
  });

  it("validates the socket join wire contract exactly", () => {
    const request = {
      protocolVersion: 1,
      vaultId: resolution.vaultId,
      invitationCapability: "C".repeat(43),
      senderSessionId,
    };
    expect(() => assertVaultSocketJoinRequest(request)).not.toThrow();
    expect(() =>
      assertVaultSocketJoinRequest({ ...request, state: "active" }),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_CAPABILITY_INVALID" }),
    );
    expect(() =>
      assertVaultSocketJoinRequest({ ...request, protocolVersion: 2 }),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_PROTOCOL_UNSUPPORTED" }),
    );
  });

  it("guards server broadcasts with admission identity, role, and wire size", async () => {
    const viewerResolution = { ...resolution, role: "viewer" as const };
    const viewerSession = new VaultRealtimeSession({
      vaultId: resolution.vaultId,
      rootKey: generateVaultRootKey(),
      role: "viewer",
      senderSessionId,
    });
    const admission = issueVaultAdmission(
      createDeploymentReady(),
      viewerResolution,
      senderSessionId,
      NOW,
    );
    const envelope = await viewerSession.encrypt({
      type: WS_SUBTYPES.USER_FOLLOW_CHANGE,
      payload: {
        action: "FOLLOW",
        userToFollow: { socketId: "target", username: "Alice" },
      },
    } as never);
    const broadcast = {
      sourceSocketId: "socket-1",
      admittedSenderSessionId: senderSessionId,
      envelope,
    };

    expect(() =>
      assertVaultSocketBroadcastForAdmission(
        admission,
        broadcast,
        1_024,
        2_048,
      ),
    ).not.toThrow();
    expect(() =>
      assertVaultSocketBroadcastForAdmission(
        admission,
        { ...broadcast, admittedSenderSessionId: crypto.randomUUID() },
        1_024,
        2_048,
      ),
    ).toThrowError(expect.objectContaining({ code: "VAULT_ENVELOPE_INVALID" }));
    expect(() =>
      assertVaultSocketBroadcastForAdmission(
        admission,
        broadcast,
        2_049,
        2_048,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_PAYLOAD_TOO_LARGE" }),
    );
  });

  it("rejects content envelopes authorized only by a viewer admission", async () => {
    const editorSession = new VaultRealtimeSession({
      vaultId: resolution.vaultId,
      rootKey: generateVaultRootKey(),
      role: "editor",
      senderSessionId,
    });
    const viewerAdmission = issueVaultAdmission(
      createDeploymentReady(),
      { ...resolution, role: "viewer" },
      senderSessionId,
      NOW,
    );
    const envelope = await editorSession.encrypt({
      type: WS_SUBTYPES.UPDATE,
      payload: { elements: [] },
    });

    expect(() =>
      assertVaultSocketBroadcastForAdmission(
        viewerAdmission,
        {
          sourceSocketId: "socket-1",
          admittedSenderSessionId: senderSessionId,
          envelope,
        },
        1_024,
        2_048,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_CAPABILITY_FORBIDDEN" }),
    );
  });
});
