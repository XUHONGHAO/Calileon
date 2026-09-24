import crypto from "node:crypto";

import { GatewayError } from "./errors.js";

import type { EncryptedEnvelope } from "./types.js";

export type DataKeyProvider = {
  provider: EncryptedEnvelope["provider"];
  keyId: string;
  generate(context: Record<string, string>): Promise<{
    plaintext: Buffer;
    wrapped: Buffer;
  }>;
  unwrap(wrapped: Buffer, context: Record<string, string>): Promise<Buffer>;
};

const contextAAD = (context: Record<string, string>) =>
  Buffer.from(
    Object.entries(context)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
  );

const assertAes256DataKey = (value: Buffer) => {
  if (value.byteLength !== 32) {
    value.fill(0);
    throw new Error("The data key must contain exactly 32 bytes.");
  }
  return value;
};

export class LocalKekProvider implements DataKeyProvider {
  public readonly provider = "local-kek" as const;
  public readonly keyId = "local-development-kek";
  private readonly kek: Buffer;

  constructor(base64Key: string) {
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        base64Key,
      )
    ) {
      throw new GatewayError("AI_GATEWAY_NOT_READY", 500, {
        message: "The local KEK must be valid base64.",
        retryable: false,
      });
    }
    this.kek = Buffer.from(base64Key, "base64");
    if (this.kek.byteLength !== 32) {
      throw new GatewayError("AI_GATEWAY_NOT_READY", 500, {
        message: "The local KEK must contain exactly 32 bytes.",
        retryable: false,
      });
    }
  }

  async generate(context: Record<string, string>) {
    const plaintext = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.kek, iv);
    cipher.setAAD(contextAAD(context));
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const wrapped = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    return { plaintext, wrapped };
  }

  async unwrap(wrapped: Buffer, context: Record<string, string>) {
    if (wrapped.byteLength < 29) {
      throw new GatewayError("AI_GATEWAY_CREDENTIAL_UNAVAILABLE", 503);
    }
    const iv = wrapped.subarray(0, 12);
    const tag = wrapped.subarray(12, 28);
    const encrypted = wrapped.subarray(28);
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.kek, iv);
      decipher.setAAD(contextAAD(context));
      decipher.setAuthTag(tag);
      return assertAes256DataKey(
        Buffer.concat([decipher.update(encrypted), decipher.final()]),
      );
    } catch (error) {
      throw new GatewayError("AI_GATEWAY_CREDENTIAL_UNAVAILABLE", 503, {
        cause: error,
      });
    }
  }
}

export class AwsKmsDataKeyProvider implements DataKeyProvider {
  public readonly provider = "aws-kms" as const;

  constructor(
    public readonly keyId: string,
    private readonly client?: { send(command: unknown): Promise<any> },
  ) {}

  private async getClient() {
    if (this.client) {
      return {
        client: this.client,
        createGenerateCommand: (input: unknown) => input,
        createDecryptCommand: (input: unknown) => input,
      };
    }
    const moduleName = "@aws-sdk/client-kms";
    const kms = await import(moduleName);
    const client = new kms.KMSClient({});
    return {
      client,
      createGenerateCommand: (input: unknown) =>
        new kms.GenerateDataKeyCommand(input as any),
      createDecryptCommand: (input: unknown) =>
        new kms.DecryptCommand(input as any),
    };
  }

  async generate(context: Record<string, string>) {
    try {
      const { client, createGenerateCommand } = await this.getClient();
      const result = await client.send(
        createGenerateCommand({
          KeyId: this.keyId,
          KeySpec: "AES_256",
          EncryptionContext: context,
        }),
      );
      if (!result.Plaintext || !result.CiphertextBlob) {
        throw new Error("KMS returned an incomplete data key.");
      }
      return {
        plaintext: assertAes256DataKey(Buffer.from(result.Plaintext)),
        wrapped: Buffer.from(result.CiphertextBlob),
      };
    } catch (error) {
      throw new GatewayError("AI_GATEWAY_CREDENTIAL_UNAVAILABLE", 503, {
        cause: error,
      });
    }
  }

  async unwrap(wrapped: Buffer, context: Record<string, string>) {
    try {
      const { client, createDecryptCommand } = await this.getClient();
      const result = await client.send(
        createDecryptCommand({
          KeyId: this.keyId,
          CiphertextBlob: wrapped,
          EncryptionContext: context,
        }),
      );
      if (!result.Plaintext) {
        throw new Error("KMS returned no plaintext data key.");
      }
      return assertAes256DataKey(Buffer.from(result.Plaintext));
    } catch (error) {
      throw new GatewayError("AI_GATEWAY_CREDENTIAL_UNAVAILABLE", 503, {
        cause: error,
      });
    }
  }
}

export class EnvelopeCipher {
  constructor(private readonly keyProvider: DataKeyProvider) {}

  async encrypt(plaintext: Buffer, context: Record<string, string>) {
    const dataKey = await this.keyProvider.generate(context);
    const iv = crypto.randomBytes(12);
    try {
      assertAes256DataKey(dataKey.plaintext);
      const cipher = crypto.createCipheriv(
        "aes-256-gcm",
        dataKey.plaintext,
        iv,
      );
      cipher.setAAD(contextAAD(context));
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      const envelope: EncryptedEnvelope = Object.freeze({
        provider: this.keyProvider.provider,
        keyId: this.keyProvider.keyId,
        wrappedKey: dataKey.wrapped.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      });
      return envelope;
    } finally {
      dataKey.plaintext.fill(0);
    }
  }

  async decrypt(envelope: EncryptedEnvelope, context: Record<string, string>) {
    if (
      envelope.provider !== this.keyProvider.provider ||
      envelope.keyId !== this.keyProvider.keyId
    ) {
      throw new GatewayError("AI_GATEWAY_CREDENTIAL_UNAVAILABLE", 503);
    }
    const dataKey = await this.keyProvider.unwrap(
      Buffer.from(envelope.wrappedKey, "base64"),
      context,
    );
    try {
      assertAes256DataKey(dataKey);
      const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        dataKey,
        Buffer.from(envelope.iv, "base64"),
      );
      decipher.setAAD(contextAAD(context));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]);
    } catch (error) {
      throw new GatewayError("AI_GATEWAY_CREDENTIAL_UNAVAILABLE", 503, {
        cause: error,
      });
    } finally {
      dataKey.fill(0);
    }
  }
}

export const redactAuditText = (value: string) => {
  const redacted = value
    .replace(/\r\n?/g, "\n")
    .trim()
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(
      /\b(?:sk|rk|pk|sk-ant|ghp|gho|ghu|ghs|ghr)[-_][A-Za-z0-9_-]{12,}\b/gi,
      "[redacted-key]",
    )
    .replace(/\bAIza[A-Za-z0-9_-]{30,}\b/g, "[redacted-key]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted-key]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{12,}\b/gi, "[redacted-key]")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[redacted-jwt]",
    )
    .replace(
      /([?&](?:access_token|auth|api[-_]?key|key|token|secret|signature|sig)=)[^&#\s]+/gi,
      "$1[redacted]",
    )
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "[redacted-email]");
  const bytes = Buffer.from(redacted, "utf8");
  let end = Math.min(bytes.byteLength, 32 * 1024);
  // Do not split a multi-byte UTF-8 sequence. This keeps the persisted
  // contentBytes value an exact upper bound and avoids replacement glyphs
  // changing the audited text at the boundary.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
};
