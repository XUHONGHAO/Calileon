import crypto from "node:crypto";

import { GatewayError } from "../src/gateway/errors.js";
import { JwksVerifier } from "../src/gateway/auth.js";

const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

const makeToken = (
  privateKey: crypto.KeyObject,
  algorithm: "RS256" | "ES256",
  claims: Record<string, unknown>,
  kid = "test-key",
) => {
  const header = encode({ alg: algorithm, kid, typ: "JWT" });
  const payload = encode(claims);
  const data = Buffer.from(`${header}.${payload}`);
  const signature =
    algorithm === "RS256"
      ? crypto.sign("RSA-SHA256", data, privateKey)
      : crypto.sign("sha256", data, {
          key: privateKey,
          dsaEncoding: "ieee-p1363",
        });
  return `${header}.${payload}.${signature.toString("base64url")}`;
};

const validClaims = (overrides: Record<string, unknown> = {}) => ({
  iss: "https://auth.example.test",
  sub: "user-1",
  aud: "authenticated",
  exp: Math.floor(Date.now() / 1000) + 300,
  ...overrides,
});

describe("managed gateway JWT/JWKS authentication", () => {
  it.each([
    ["RS256", "rsa"],
    ["ES256", "ec"],
  ] as const)(
    "verifies %s tokens and enforces claims",
    async (algorithm, kind) => {
      const pair =
        kind === "rsa"
          ? crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
          : crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
      const publicJwk = pair.publicKey.export({ format: "jwk" });
      const fetcher = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              keys: [{ ...publicJwk, kid: "test-key", alg: algorithm }],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
      );
      const verifier = new JwksVerifier(
        {
          jwksUrl: "https://auth.example.test/jwks",
          issuer: "https://auth.example.test",
          audience: "authenticated",
          algorithms: [algorithm],
          cacheMs: 60_000,
        },
        fetcher,
      );
      const token = makeToken(pair.privateKey, algorithm, validClaims());
      await expect(verifier.verify(token)).resolves.toMatchObject({
        issuer: "https://auth.example.test",
        subject: "user-1",
        source: "jwt",
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      await expect(verifier.verify(token)).resolves.toMatchObject({
        subject: "user-1",
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects issuer, audience, expiry, nbf, algorithm, and signature mismatches", async () => {
    const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicJwk = pair.publicKey.export({ format: "jwk" });
    const verifier = new JwksVerifier(
      {
        jwksUrl: "https://auth.example.test/jwks",
        issuer: "issuer",
        audience: "audience",
        algorithms: ["RS256"],
      },
      async () =>
        new Response(
          JSON.stringify({ keys: [{ ...publicJwk, kid: "k", alg: "RS256" }] }),
        ),
    );
    const base = validClaims({ iss: "issuer", aud: "audience" });
    for (const claims of [
      { ...base, iss: "other" },
      { ...base, aud: "other" },
      { ...base, exp: Math.floor(Date.now() / 1000) - 1 },
      { ...base, nbf: Math.floor(Date.now() / 1000) + 60 },
    ]) {
      await expect(
        verifier.verify(makeToken(pair.privateKey, "RS256", claims, "k")),
      ).rejects.toMatchObject({ code: "AI_GATEWAY_UNAUTHORIZED" });
    }
    const wrong = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    await expect(
      verifier.verify(makeToken(wrong.privateKey, "RS256", base, "k")),
    ).rejects.toMatchObject({ code: "AI_GATEWAY_UNAUTHORIZED" });
    const header = encode({ alg: "HS256", kid: "k" });
    const payload = encode(base);
    await expect(
      verifier.verify(`${header}.${payload}.bad`),
    ).rejects.toMatchObject({
      code: "AI_GATEWAY_UNAUTHORIZED",
    });
  });

  it("maps JWKS network and malformed responses to readiness errors", async () => {
    const unavailable = new JwksVerifier(
      {
        jwksUrl: "https://auth.example.test/jwks",
        issuer: "issuer",
        audience: "audience",
        algorithms: ["RS256"],
      },
      async () => {
        throw new Error("offline");
      },
    );
    await expect(unavailable.checkReady()).rejects.toMatchObject({
      code: "AI_GATEWAY_NOT_READY",
      status: 503,
    });
    const malformed = new JwksVerifier(
      {
        jwksUrl: "https://auth.example.test/jwks",
        issuer: "issuer",
        audience: "audience",
        algorithms: ["RS256"],
      },
      async () => new Response("not-json", { status: 200 }),
    );
    await expect(malformed.checkReady()).rejects.toBeInstanceOf(GatewayError);
  });

  it("rejects oversized JWKS documents and follows no redirects", async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      return new Response("{}", {
        status: 200,
        headers: { "content-length": String(1024 * 1024 + 1) },
      });
    });
    const verifier = new JwksVerifier(
      {
        jwksUrl: "https://auth.example.test/jwks",
        issuer: "issuer",
        audience: "audience",
        algorithms: ["RS256"],
      },
      fetcher,
    );
    await expect(verifier.checkReady()).rejects.toMatchObject({
      code: "AI_GATEWAY_NOT_READY",
    });
  });
});
