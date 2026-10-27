import { describe, expect, it } from "vitest";

import {
  MAX_KDF_ITERATIONS,
  MIN_KDF_ITERATIONS,
  SettingsCryptoError,
  createKdf,
  decryptSettings,
  deriveSettingsKey,
  encryptSettings,
} from "./settingsCrypto";

const kdf = createKdf(MIN_KDF_ITERATIONS);

describe("settingsCrypto (ADR 0038 §3)", () => {
  it("round-trips settings without plaintext in the record", async () => {
    const key = await deriveSettingsKey("passphrase-1", kdf);
    const record = await encryptSettings(
      { apiKey: "sk-very-secret" },
      key,
      kdf,
      "u1",
    );
    expect(JSON.stringify(record)).not.toContain("sk-very-secret");
    expect(await decryptSettings(record, key, "u1")).toEqual({
      apiKey: "sk-very-secret",
    });
  });

  it("derives the same key from the same passphrase, in either normal form", async () => {
    // "é" precomposed vs. e + combining accent
    const a = await deriveSettingsKey("caf\u00e9 au lait", kdf);
    const b = await deriveSettingsKey("cafe\u0301 au lait", kdf);
    expect(a).toBe(b);
    expect(await deriveSettingsKey("another one", kdf)).not.toBe(a);
  });

  it("binds a ciphertext to its account", async () => {
    const key = await deriveSettingsKey("passphrase-1", kdf);
    const record = await encryptSettings({ a: 1 }, key, kdf, "u1");
    await expect(decryptSettings(record, key, "u2")).rejects.toMatchObject({
      code: "wrong-passphrase",
    });
  });

  it("detects a wrong passphrase and tampering", async () => {
    const key = await deriveSettingsKey("passphrase-1", kdf);
    const record = await encryptSettings({ a: 1 }, key, kdf, "u1");
    const wrong = await deriveSettingsKey("passphrase-2", kdf);
    await expect(decryptSettings(record, wrong, "u1")).rejects.toBeInstanceOf(
      SettingsCryptoError,
    );
    const tampered = {
      ...record,
      ciphertext: `A${record.ciphertext.slice(1)}`,
    };
    await expect(decryptSettings(tampered, key, "u1")).rejects.toMatchObject({
      code: "wrong-passphrase",
    });
  });

  it("refuses weak or unbounded key derivation parameters", async () => {
    for (const iterations of [1000, MAX_KDF_ITERATIONS + 1, 1.5]) {
      await expect(
        deriveSettingsKey("passphrase-1", { ...kdf, iterations }),
      ).rejects.toMatchObject({ code: "unsupported-kdf" });
    }
    await expect(
      deriveSettingsKey("passphrase-1", { ...kdf, salt: "c2hvcnQ=" }),
    ).rejects.toMatchObject({ code: "unsupported-kdf" });
  });

  it("refuses settings over the size cap", async () => {
    const key = await deriveSettingsKey("passphrase-1", kdf);
    await expect(
      encryptSettings({ blob: "x".repeat(600 * 1024) }, key, kdf, "u1"),
    ).rejects.toMatchObject({ code: "too-large" });
  });
});
