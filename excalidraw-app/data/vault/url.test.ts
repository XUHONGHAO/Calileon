import { describe, expect, it } from "vitest";

import { VaultError } from "./errors";
import { getVaultLink, getVaultLinkData, hasVaultUrlMarker } from "./url";

const vaultId = "123e4567-e89b-42d3-a456-426614174000";
const rootKey = "A".repeat(43);
const invitationCapability = `${"B".repeat(42)}A`;

describe("Vault URL contract", () => {
  it("serializes the canonical independent fragment fields", () => {
    const link = getVaultLink(
      {
        version: 1,
        vaultId,
        rootKey,
        invitationCapability,
      },
      "https://vault.example/board?ignored=1#room=legacy,key",
    );

    expect(link).toBe(
      `https://vault.example/board#vault=1&id=${vaultId}&key=${rootKey}&cap=${invitationCapability}`,
    );
    expect(getVaultLinkData(link)).toEqual({
      version: 1,
      vaultId,
      rootKey,
      invitationCapability,
    });
  });

  it("returns null only when the Vault marker is absent", () => {
    const legacy = "https://vault.example/#room=room-id,room-key";
    expect(hasVaultUrlMarker(legacy)).toBe(false);
    expect(getVaultLinkData(legacy)).toBeNull();
  });

  it("rejects malformed Vault links instead of allowing legacy fallback", () => {
    expect(() =>
      getVaultLinkData(
        `https://vault.example/#vault=1&id=${vaultId}&key=${rootKey}`,
      ),
    ).toThrowError(VaultError);
    expect(() =>
      getVaultLinkData(
        `https://vault.example/#vault=1&id=${vaultId}&key=${rootKey}&cap=${invitationCapability}&room=legacy`,
      ),
    ).toThrowError(expect.objectContaining({ code: "VAULT_URL_INVALID" }));
  });

  it("rejects unsupported protocol versions with a stable code", () => {
    expect(() =>
      getVaultLinkData(
        `https://vault.example/#vault=2&id=${vaultId}&key=${rootKey}&cap=${invitationCapability}`,
      ),
    ).toThrowError(
      expect.objectContaining({ code: "VAULT_PROTOCOL_UNSUPPORTED" }),
    );
  });
});
