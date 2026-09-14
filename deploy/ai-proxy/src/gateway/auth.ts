import crypto from "node:crypto";

import { GatewayError } from "./errors.js";

import type { GatewayIdentity, GatewayStore } from "./types.js";

type GatewayJsonWebKey = Record<string, unknown> & {
  kid?: string;
  alg?: string;
  use?: string;
};

type JsonWebKeySet = { keys?: GatewayJsonWebKey[] };

type CachedSigningKey = {
  key: crypto.KeyObject;
  algorithms: ReadonlySet<string>;
};

const decodeJSONPart = (part: string) => {
  try {
    const value = JSON.parse(
      Buffer.from(part, "base64url").toString("utf8"),
    ) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("JWT part must be an object.");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new GatewayError("AI_GATEWAY_UNAUTHORIZED", 401, {
      retryable: false,
      cause: error,
    });
  }
};

const readAudience = (value: unknown) =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

export class JwksVerifier {
  private keys = new Map<string, CachedSigningKey>();
  private expiresAt = 0;
  private refreshInFlight: Promise<void> | null = null;

  constructor(
    private readonly config: {
      jwksUrl: string;
      issuer: string;
      audience: string;
      algorithms: readonly string[];
      cacheMs?: number;
    },
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async refreshNow() {
    let response: Response;
    try {
      response = await this.fetcher(this.config.jwksUrl, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
    } catch (error) {
      throw new GatewayError("AI_GATEWAY_NOT_READY", 503, { cause: error });
    }
    if (!response.ok) {
      throw new GatewayError("AI_GATEWAY_NOT_READY", 503);
    }
    let body: JsonWebKeySet;
    try {
      body = (await response.json()) as JsonWebKeySet;
    } catch (error) {
      throw new GatewayError("AI_GATEWAY_NOT_READY", 503, {
        message: "The JWKS endpoint returned invalid JSON.",
        cause: error,
      });
    }
    if (!body || !Array.isArray(body.keys)) {
      throw new GatewayError("AI_GATEWAY_NOT_READY", 503, {
        message: "The JWKS endpoint returned an invalid key set.",
      });
    }
    const next = new Map<string, CachedSigningKey>();
    for (const jwk of body.keys) {
      if (typeof jwk.kid !== "string" || !jwk.kid) {
        continue;
      }
      if (jwk.use && jwk.use !== "sig") {
        continue;
      }
      if (
        Array.isArray(jwk.key_ops) &&
        !jwk.key_ops.some((operation) => operation === "verify")
      ) {
        continue;
      }
      const keyType = typeof jwk.kty === "string" ? jwk.kty : "";
      const algorithm = typeof jwk.alg === "string" ? jwk.alg : undefined;
      const algorithms = new Set(
        this.config.algorithms.filter((configured) => {
          if (algorithm && algorithm !== configured) {
            return false;
          }
          return (
            (configured === "RS256" && keyType === "RSA") ||
            (configured === "ES256" && keyType === "EC")
          );
        }),
      );
      if (!algorithms.size) {
        continue;
      }
      try {
        next.set(jwk.kid, {
          key: crypto.createPublicKey({ key: jwk as any, format: "jwk" }),
          algorithms,
        });
      } catch {
        // Ignore unusable keys. A matching valid key remains mandatory.
      }
    }
    if (!next.size) {
      throw new GatewayError("AI_GATEWAY_NOT_READY", 503, {
        message: "The JWKS endpoint returned no usable signing keys.",
      });
    }
    this.keys = next;
    this.expiresAt = Date.now() + (this.config.cacheMs || 5 * 60_000);
  }

  private async refresh() {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.refreshNow().finally(() => {
        this.refreshInFlight = null;
      });
    }
    return this.refreshInFlight;
  }

  private async getKey(kid: string) {
    if (Date.now() >= this.expiresAt || !this.keys.has(kid)) {
      await this.refresh();
    }
    const key = this.keys.get(kid);
    if (!key) {
      throw new GatewayError("AI_GATEWAY_UNAUTHORIZED", 401, {
        retryable: false,
      });
    }
    return key;
  }

  async checkReady() {
    if (Date.now() >= this.expiresAt || !this.keys.size) {
      await this.refresh();
    }
    return true;
  }

  async verify(token: string): Promise<GatewayIdentity> {
    if (typeof token !== "string" || token.length > 16 * 1024) {
      throw new GatewayError("AI_GATEWAY_UNAUTHORIZED", 401, {
        retryable: false,
      });
    }
    const parts = token.split(".");
    if (
      parts.length !== 3 ||
      parts.some((part) => !part || !/^[A-Za-z0-9_-]+$/.test(part))
    ) {
      throw new GatewayError("AI_GATEWAY_UNAUTHORIZED", 401, {
        retryable: false,
      });
    }
    const header = decodeJSONPart(parts[0]);
    const claims = decodeJSONPart(parts[1]);
    const algorithm = typeof header.alg === "string" ? header.alg : "";
    const kid = typeof header.kid === "string" ? header.kid : "";
    if (!kid || !this.config.algorithms.includes(algorithm)) {
      throw new GatewayError("AI_GATEWAY_UNAUTHORIZED", 401, {
        retryable: false,
      });
    }
    const cached = await this.getKey(kid);
    const key = cached.key;
    if (!cached.algorithms.has(algorithm)) {
      throw new GatewayError("AI_GATEWAY_UNAUTHORIZED", 401, {
        retryable: false,
      });
    }
    if (
      (algorithm === "RS256" && key.asymmetricKeyType !== "rsa") ||
      (algorithm === "ES256" && key.asymmetricKeyType !== "ec")
    ) {
      throw new GatewayError("AI_GATEWAY_UNAUTHORIZED", 401, {
        retryable: false,
      });
    }
    const signature = Buffer.from(parts[2], "base64url");
    const data = Buffer.from(`${parts[0]}.${parts[1]}`);
    const verified =
      algorithm === "RS256"
        ? crypto.verify("RSA-SHA256", data, key, signature)
        : algorithm === "ES256"
        ? crypto.verify(
            "sha256",
            data,
            { key, dsaEncoding: "ieee-p1363" },
            signature,
          )
        : false;
    if (!verified) {
      throw new GatewayError("AI_GATEWAY_UNAUTHORIZED", 401, {
        retryable: false,
      });
    }
    const now = Math.floor(Date.now() / 1000);
    const issuer = typeof claims.iss === "string" ? claims.iss : "";
    const subject = typeof claims.sub === "string" ? claims.sub : "";
    const expiresAt = claims.exp;
    const notBefore = claims.nbf;
    const validExp =
      typeof expiresAt === "number" && Number.isFinite(expiresAt);
    const validNbf =
      notBefore == null ||
      (typeof notBefore === "number" && Number.isFinite(notBefore));
    if (
      issuer !== this.config.issuer ||
      !subject ||
      !validExp ||
      (expiresAt as number) <= now ||
      !validNbf ||
      (typeof notBefore === "number" && notBefore > now + 30) ||
      !readAudience(claims.aud).includes(this.config.audience)
    ) {
      throw new GatewayError("AI_GATEWAY_UNAUTHORIZED", 401, {
        retryable: false,
      });
    }
    return Object.freeze({
      issuer,
      subject,
      ...(typeof claims.email === "string" ? { email: claims.email } : {}),
      source: "jwt" as const,
    });
  }
}

export const hashOpaqueToken = (token: string) =>
  crypto.createHash("sha256").update(token).digest("hex");

export class GatewayAuthenticator {
  constructor(
    private readonly jwtVerifier: JwksVerifier,
    private readonly store: GatewayStore,
  ) {}

  async authenticate(authorization: string): Promise<GatewayIdentity> {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (!match) {
      throw new GatewayError("AI_GATEWAY_UNAUTHORIZED", 401, {
        retryable: false,
      });
    }
    const token = match[1].trim();
    if (!token) {
      throw new GatewayError("AI_GATEWAY_UNAUTHORIZED", 401, {
        retryable: false,
      });
    }
    if (token.split(".").length === 3) {
      return this.jwtVerifier.verify(token);
    }
    const identity = await this.store.resolveDeviceToken(
      hashOpaqueToken(token),
    );
    if (!identity) {
      throw new GatewayError("AI_GATEWAY_UNAUTHORIZED", 401, {
        retryable: false,
      });
    }
    return identity;
  }

  async checkReady() {
    await this.jwtVerifier.checkReady();
    return true;
  }
}
