import { GatewayError } from "./errors.js";

import type { EnvelopeCipher } from "./crypto.js";
import type { GatewayStore } from "./types.js";

type CachedCredential = {
  value: Buffer;
  expiresAt: number;
  version: number;
};

const credentialContext = (credentialId: string) => ({
  purpose: "provider-credential",
  credentialId,
});

export class GatewayCredentialVault {
  private readonly cache = new Map<string, CachedCredential>();

  constructor(
    private readonly store: GatewayStore,
    private readonly cipher: EnvelopeCipher,
    private readonly cacheMs: number,
  ) {}

  async put(id: string, plaintext: Buffer) {
    const copy = Buffer.from(plaintext);
    try {
      const envelope = await this.cipher.encrypt(copy, credentialContext(id));
      const version = await this.store.putCredential(id, envelope);
      this.drop(id);
      return version;
    } finally {
      copy.fill(0);
    }
  }

  async remove(id: string) {
    this.drop(id);
    await this.store.removeCredential(id);
  }

  async get(id: string) {
    const cached = this.cache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      return Buffer.from(cached.value);
    }
    this.drop(id);
    const stored = await this.store.getCredential(id);
    if (!stored) {
      throw new GatewayError("AI_GATEWAY_CREDENTIAL_UNAVAILABLE", 503);
    }
    const plaintext = await this.cipher.decrypt(
      stored.envelope,
      credentialContext(id),
    );
    try {
      this.cache.set(id, {
        value: Buffer.from(plaintext),
        expiresAt: Date.now() + this.cacheMs,
        version: stored.version,
      });
      return Buffer.from(plaintext);
    } finally {
      plaintext.fill(0);
    }
  }

  drop(id: string) {
    const cached = this.cache.get(id);
    if (cached) {
      cached.value.fill(0);
      this.cache.delete(id);
    }
  }

  clear() {
    for (const id of this.cache.keys()) {
      this.drop(id);
    }
  }
}
