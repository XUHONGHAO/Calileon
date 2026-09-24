import {
  AwsKmsDataKeyProvider,
  EnvelopeCipher,
  LocalKekProvider,
  redactAuditText,
} from "../src/gateway/crypto.js";

describe("managed gateway envelope encryption", () => {
  it("round-trips with the local development KEK and binds AAD context", async () => {
    const cipher = new EnvelopeCipher(
      new LocalKekProvider(Buffer.alloc(32, 4).toString("base64")),
    );
    const context = { purpose: "credential", credentialId: "primary" };
    const envelope = await cipher.encrypt(
      Buffer.from("provider-secret"),
      context,
    );

    await expect(cipher.decrypt(envelope, context)).resolves.toEqual(
      Buffer.from("provider-secret"),
    );
    await expect(
      cipher.decrypt(envelope, { ...context, credentialId: "other" }),
    ).rejects.toMatchObject({ code: "AI_GATEWAY_CREDENTIAL_UNAVAILABLE" });
    expect(JSON.stringify(envelope)).not.toContain("provider-secret");
  });

  it("passes the AWS KMS key id and encryption context", async () => {
    const plaintextKey = Buffer.alloc(32, 9);
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Plaintext: plaintextKey,
        CiphertextBlob: Buffer.from("wrapped"),
      })
      .mockResolvedValueOnce({ Plaintext: Buffer.alloc(32, 9) });
    const provider = new AwsKmsDataKeyProvider("kms-key", { send });
    const context = { purpose: "provider-credential", credentialId: "id-1" };
    const generated = await provider.generate(context);
    expect(send.mock.calls[0][0]).toMatchObject({
      KeyId: "kms-key",
      KeySpec: "AES_256",
      EncryptionContext: context,
    });
    await expect(provider.unwrap(generated.wrapped, context)).resolves.toEqual(
      Buffer.alloc(32, 9),
    );
    expect(send.mock.calls[1][0]).toMatchObject({
      KeyId: "kms-key",
      CiphertextBlob: generated.wrapped,
      EncryptionContext: context,
    });
  });

  it("clears generated plaintext data keys after encryption", async () => {
    const generatedKey = Buffer.alloc(32, 3);
    const cipher = new EnvelopeCipher({
      provider: "local-kek",
      keyId: "test",
      generate: async () => ({
        plaintext: generatedKey,
        wrapped: Buffer.from("wrapped"),
      }),
      unwrap: async () => Buffer.alloc(32, 3),
    });
    await cipher.encrypt(Buffer.from("content"), { purpose: "test" });
    expect(generatedKey.equals(Buffer.alloc(32))).toBe(true);
  });

  it("rejects malformed AWS KMS data keys before AES use", async () => {
    const generateProvider = new AwsKmsDataKeyProvider("kms-key", {
      send: vi.fn().mockResolvedValue({
        Plaintext: Buffer.alloc(16, 1),
        CiphertextBlob: Buffer.from("wrapped"),
      }),
    });
    await expect(
      generateProvider.generate({ purpose: "test" }),
    ).rejects.toMatchObject({ code: "AI_GATEWAY_CREDENTIAL_UNAVAILABLE" });

    const unwrapProvider = new AwsKmsDataKeyProvider("kms-key", {
      send: vi.fn().mockResolvedValue({ Plaintext: Buffer.alloc(31, 1) }),
    });
    await expect(
      unwrapProvider.unwrap(Buffer.from("wrapped"), { purpose: "test" }),
    ).rejects.toMatchObject({ code: "AI_GATEWAY_CREDENTIAL_UNAVAILABLE" });
  });

  it("redacts sensitive values and caps prompt audit text at 32 KiB UTF-8", () => {
    const prompt = `${"你".repeat(
      20_000,
    )} Bearer secret-token-value user@example.com sk-1234567890123456 https://example.test/file?token=signed-secret AIza12345678901234567890123456789012345`;
    const redacted = redactAuditText(prompt);
    expect(Buffer.byteLength(redacted, "utf8")).toBeLessThanOrEqual(32 * 1024);
    expect(redacted).not.toContain("secret-token-value");
    expect(redacted).not.toContain("user@example.com");
    expect(redacted).not.toContain("sk-1234567890123456");
    expect(redacted).not.toContain("signed-secret");
    expect(redacted).not.toContain("AIza12345678901234567890123456789012345");
  });
});
