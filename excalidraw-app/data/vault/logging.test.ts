import { afterEach, describe, expect, it, vi } from "vitest";

import { VaultError } from "./errors";
import { reportVaultError, toVaultLogRecord } from "./logging";

describe("Vault safe logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs only stable codes and allowlisted metadata", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new VaultError(
      "VAULT_DECRYPT_FAILED",
      "P4-PLAINTEXT-SENTINEL-20260713 key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );

    reportVaultError(error, {
      operation: "realtime.decrypt",
      vaultId: "123e4567-e89b-42d3-a456-426614174000",
      messageId: "123e4567-e89b-42d3-a456-426614174001",
      sequence: 4,
      generation: 7,
      ciphertextBytes: 128,
    });

    const serialized = JSON.stringify(consoleSpy.mock.calls);
    expect(serialized).toContain("VAULT_DECRYPT_FAILED");
    expect(serialized).toContain("realtime.decrypt");
    expect(serialized).toContain("123e4567-e89b-42d3-a456-426614174000");
    expect(serialized).toContain('"generation":7');
    expect(serialized).not.toContain("P4-PLAINTEXT-SENTINEL-20260713");
    expect(serialized).not.toContain(
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
  });

  it("maps unknown SDK errors to VAULT_INTERNAL without expanding them", () => {
    const record = toVaultLogRecord(
      {
        message: "secret response",
        data: { elements: ["secret"] },
      },
      { operation: "snapshot.cas" },
    );
    expect(record).toEqual({
      operation: "snapshot.cas",
      code: "VAULT_INTERNAL",
      recoverable: false,
    });
  });

  it("drops runtime metadata outside the allowlist and unsafe labels", () => {
    const record = toVaultLogRecord(new Error("ignored"), {
      operation: "P4-PLAINTEXT-SENTINEL-20260713",
      vaultId: `123e4567-e89b-42d3-a456-426614174000${"A".repeat(43)}`,
      generation: 9,
      ...({ payload: { elements: ["secret"] } } as object),
    });
    const serialized = JSON.stringify(record);

    expect(record.operation).toBe("vault.unknown");
    expect(record.generation).toBe(9);
    expect(record.vaultId).toBeUndefined();
    expect(serialized).not.toContain("P4-PLAINTEXT-SENTINEL-20260713");
    expect(serialized).not.toContain("elements");
    expect(serialized).not.toContain("A".repeat(43));
  });
});
