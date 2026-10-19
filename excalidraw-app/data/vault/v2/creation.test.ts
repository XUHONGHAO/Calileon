import { assertVaultDeploymentReady } from "../capabilities";
import { VaultError } from "../errors";
import { createVaultOwnerService } from "../owner";
import { getVaultLinkData } from "../url";

import { createVaultV2 } from "./creation";
import { getVaultV2Link, getVaultV2LinkData, isVaultV2Link } from "./link";

import type { VaultOwnerServiceImplementation } from "../owner";

const VAULT_ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const INVITATION_ID = "223e4567-e89b-42d3-a456-426614174000";
const ROOM_ID = "room_1234567890abcdef";
const SECRET = "A".repeat(43);

const deployment = () =>
  assertVaultDeploymentReady(
    {
      enabled: true,
      protocolVersions: [1, 2],
      roomProtocolVersions: [1, 2],
      invitationService: true,
      encryptedSnapshotPersistence: true,
      encryptedAssetPersistence: true,
    },
    { isSecureContext: true, hasWebCrypto: true },
  );

const owner = (overrides: Partial<VaultOwnerServiceImplementation> = {}) => {
  const calls: string[] = [];
  const unused = async () => {
    throw new Error("unused");
  };
  const service = createVaultOwnerService(deployment(), {
    create: unused,
    activate: async (input) => {
      calls.push(`activate:${input.activeRoomId}`);
      return {
        vaultId: input.vaultId,
        state: "active",
        activeRoomId: input.activeRoomId,
      };
    },
    failCreation: async (vaultId) => {
      calls.push(`fail:${vaultId}`);
    },
    createInvitation: unused,
    revokeInvitation: unused,
    revokeVault: unused,
    softDeleteVault: unused,
    ...overrides,
  });
  return { service, calls };
};

const rooms = {
  provision: async () => ({
    kind: "vault-room" as const,
    activeRoomId: ROOM_ID,
  }),
};

describe("Vault v2 link", () => {
  it("round-trips and is distinct from v1", () => {
    const link = getVaultV2Link(
      { vaultId: VAULT_ID, rootKey: SECRET, invitationCapability: SECRET },
      "https://calileon.com/",
    );
    expect(link).toContain("#vault=2&");
    expect(isVaultV2Link(link)).toBe(true);
    expect(getVaultV2LinkData(link)).toEqual({
      version: 2,
      vaultId: VAULT_ID,
      rootKey: SECRET,
      invitationCapability: SECRET,
    });
  });

  it("a v1 client fails closed on a v2 link", () => {
    const link = getVaultV2Link(
      { vaultId: VAULT_ID, rootKey: SECRET, invitationCapability: SECRET },
      "https://calileon.com/",
    );
    expect(() => getVaultLinkData(link)).toThrow(
      expect.objectContaining({ code: "VAULT_PROTOCOL_UNSUPPORTED" }),
    );
  });

  it("ignores v1 links and rejects malformed v2 links", () => {
    expect(
      getVaultV2LinkData(
        `https://x.test/#vault=1&id=${VAULT_ID}&key=${SECRET}&cap=${SECRET}`,
      ),
    ).toBeNull();
    expect(() =>
      getVaultV2LinkData(
        `https://x.test/#vault=2&id=${VAULT_ID}&key=${SECRET}`,
      ),
    ).toThrow(VaultError);
    expect(() =>
      getVaultV2LinkData(
        `https://x.test/#vault=2&id=nope&key=${SECRET}&cap=${SECRET}`,
      ),
    ).toThrow(VaultError);
  });
});

describe("createVaultV2", () => {
  it("creates, provisions, activates and returns a v2 editor link", async () => {
    const { service, calls } = owner();
    const createV2 = vi.fn(async (input: { vaultId: string }) => ({
      vaultId: input.vaultId,
      invitationId: INVITATION_ID,
    }));
    const created = await createVaultV2({
      createV2,
      owner: service,
      rooms,
      baseUrl: "https://calileon.com/",
    });
    expect(created.activeRoomId).toBe(ROOM_ID);
    expect(calls).toEqual([`activate:${ROOM_ID}`]);
    const link = getVaultV2LinkData(created.editorLink)!;
    expect(link.vaultId).toBe(created.vaultId);
    expect(createV2.mock.calls[0][0]).toMatchObject({
      vaultId: created.vaultId,
      editorExpiresAt: null,
    });
  });

  it("compensates with fail_vault_creation when provisioning fails", async () => {
    const { service, calls } = owner();
    await expect(
      createVaultV2({
        createV2: async (input) => ({
          vaultId: input.vaultId,
          invitationId: INVITATION_ID,
        }),
        owner: service,
        rooms: {
          provision: async () => {
            throw new VaultError("VAULT_PERSISTENCE_UNAVAILABLE", "down");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "VAULT_PERSISTENCE_UNAVAILABLE" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^fail:/);
  });

  it("compensates when activation fails", async () => {
    const { service, calls } = owner({
      activate: async () => {
        throw new VaultError("VAULT_NOT_ACTIVE", "nope");
      },
    });
    await expect(
      createVaultV2({
        createV2: async (input) => ({
          vaultId: input.vaultId,
          invitationId: INVITATION_ID,
        }),
        owner: service,
        rooms,
      }),
    ).rejects.toMatchObject({ code: "VAULT_NOT_ACTIVE" });
    expect(calls[0]).toMatch(/^fail:/);
  });
});
