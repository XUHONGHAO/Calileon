import { getVaultLinkData } from "../url";

import { getVaultV2Link } from "./link";
import {
  assertVaultV2Deployment,
  isVaultV2Enabled,
  isVaultV2Route,
  openVaultV2Route,
} from "./route";

const VAULT_ID = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const SECRET = "A".repeat(43);
const v2Link = getVaultV2Link(
  { vaultId: VAULT_ID, rootKey: SECRET, invitationCapability: SECRET },
  "https://calileon.com/",
);
const v1Link = `https://calileon.com/#vault=1&id=${VAULT_ID}&key=${SECRET}&cap=${SECRET}`;

describe("Vault v2 route gate (W6, flag default OFF)", () => {
  it("is off unless the flag is exactly 'true'", () => {
    expect(isVaultV2Enabled({})).toBe(false);
    expect(isVaultV2Enabled({ VITE_APP_VAULT_V2_ENABLED: "1" })).toBe(false);
    expect(isVaultV2Enabled({ VITE_APP_VAULT_V2_ENABLED: "true" })).toBe(true);
  });

  it("the default test build has v2 off", () => {
    expect(isVaultV2Enabled()).toBe(false);
  });

  it("routes only v2 links, and only with the flag on", () => {
    const on = { VITE_APP_VAULT_V2_ENABLED: "true" };
    expect(isVaultV2Route(v2Link, on)).toBe(true);
    expect(isVaultV2Route(v1Link, on)).toBe(false);
    expect(isVaultV2Route("https://calileon.com/#room=a,b", on)).toBe(false);
    expect(isVaultV2Route(v2Link, {})).toBe(false);
  });

  it("with the flag off a v2 link falls to v1 and fails closed", () => {
    expect(() => getVaultLinkData(v2Link)).toThrow(
      expect.objectContaining({ code: "VAULT_PROTOCOL_UNSUPPORTED" }),
    );
  });

  it("requires protocol 2 on both deployment sides", () => {
    expect(() =>
      assertVaultV2Deployment({
        protocolVersions: [1],
        roomProtocolVersions: [1, 2],
      }),
    ).toThrow(expect.objectContaining({ code: "VAULT_PROTOCOL_UNSUPPORTED" }));
    expect(() =>
      assertVaultV2Deployment({
        protocolVersions: [1, 2],
        roomProtocolVersions: [1],
      }),
    ).toThrow(
      expect.objectContaining({ code: "VAULT_ROOM_PROTOCOL_UNSUPPORTED" }),
    );
  });

  it("does not open a socket when the deployment lacks v2", async () => {
    const createSocket = vi.fn();
    await expect(
      openVaultV2Route(v2Link, {
        discover: async () => ({
          protocolVersions: [1],
          roomProtocolVersions: [1],
        }),
        createSocket,
        createSnapshotStore: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: "VAULT_PROTOCOL_UNSUPPORTED" });
    expect(createSocket).not.toHaveBeenCalled();
  });

  it("closes the socket and local store when admission fails", async () => {
    const close = vi.fn();
    const closeStore = vi.fn();
    const socket = {
      connected: true,
      on: vi.fn(),
      off: vi.fn(),
      close,
      emit: (_event: string, _req: unknown, ack: (v: unknown) => void) =>
        ack({ ok: false, code: "VAULT_CAPABILITY_REVOKED" }),
    };
    await expect(
      openVaultV2Route(v2Link, {
        discover: async () => ({
          protocolVersions: [1, 2],
          roomProtocolVersions: [1, 2],
        }),
        createSocket: () => socket,
        createSnapshotStore: vi.fn(),
        openLocalStore: async () => ({ close: closeStore } as any),
      }),
    ).rejects.toMatchObject({ code: "VAULT_CAPABILITY_REVOKED" });
    expect(close).toHaveBeenCalled();
    expect(closeStore).toHaveBeenCalled();
  });
});
