import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateProductionEnvironment } from "../src/productionPreflight.js";

const strong = (prefix: string) => `${prefix}-012345678901234567890123456789`;

const baseEnv = (routeConfigPath: string): NodeJS.ProcessEnv => ({
  NODE_ENV: "production",
  AI_PROXY_ALLOWED_ORIGINS: "https://canvas.example.com",
  AI_PROXY_CLIENT_TOKENS: strong("proxy-token"),
  AI_GATEWAY_ENABLED: "true",
  AI_GATEWAY_DATABASE_URL:
    "postgresql://gateway:password@db.example.com:5432/ai_gateway?sslmode=verify-full",
  AI_GATEWAY_JWKS_URL: "https://auth.example.com/.well-known/jwks.json",
  AI_GATEWAY_AUTH_ISSUER: "https://auth.example.com",
  AI_GATEWAY_AUTH_AUDIENCE: "authenticated",
  AI_GATEWAY_AUTH_ALGORITHMS: "RS256,ES256",
  AI_GATEWAY_CONFIG_FILE: routeConfigPath,
  AI_GATEWAY_KMS_PROVIDER: "aws-kms",
  AI_GATEWAY_KMS_KEY_ID: "arn:aws:kms:us-east-1:123456789012:key/real-key-id",
  AI_GATEWAY_METRICS_TOKEN: strong("metrics-token"),
  AI_GATEWAY_DEVICE_VERIFICATION_URI: "https://canvas.example.com/ai-device",
  AI_GATEWAY_ALLOWED_ORIGINS: "https://canvas.example.com,null",
});

const writeRouteConfig = () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "ai-gateway-preflight-"),
  );
  const file = path.join(directory, "routes.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      defaultPolicy: "standard",
      policies: [
        {
          id: "standard",
          dailyCredits: 10,
          monthlyCredits: 100,
          requestsPerMinute: 5,
          maxConcurrency: 2,
        },
      ],
      routes: [
        {
          id: "text-route",
          label: "Text",
          capability: "text-agent",
          wireProtocol: "openai-chat-sse",
          model: "managed-model",
          costUnits: 1,
          operations: {
            stream: {
              method: "POST",
              path: "/v1/chat/completions",
              replayable: true,
            },
          },
          candidates: [
            {
              id: "primary",
              baseUrl: "https://provider.example.com",
              credentialHeader: "none",
            },
          ],
        },
      ],
    }),
  );
  return { directory, file };
};

describe("production deployment preflight", () => {
  it("accepts a complete production gateway configuration without exposing values", () => {
    const route = writeRouteConfig();
    const result = validateProductionEnvironment(baseEnv(route.file));
    expect(result).toEqual({
      ok: true,
      issues: [],
      managedGatewayEnabled: true,
    });
    fs.rmSync(route.directory, { recursive: true, force: true });
  });

  it("rejects weak secrets, insecure database transport, and missing catalogs", () => {
    const result = validateProductionEnvironment({
      ...baseEnv("C:/missing/routes.json"),
      AI_PROXY_CLIENT_TOKENS: "short",
      AI_GATEWAY_METRICS_TOKEN: "short",
      AI_GATEWAY_DATABASE_URL:
        "postgresql://gateway:password@db.example.com:5432/ai_gateway",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.map(({ code }) => code)).toEqual(
      expect.arrayContaining([
        "PROXY_CONFIG_INVALID",
        "DATABASE_TLS_REQUIRED",
        "METRICS_TOKEN_WEAK",
        "ROUTE_CONFIG_MISSING",
      ]),
    );
  });

  it("can gate the thin proxy without requiring managed gateway dependencies", () => {
    const result = validateProductionEnvironment({
      NODE_ENV: "production",
      AI_PROXY_ALLOWED_ORIGINS: "https://canvas.example.com",
      AI_PROXY_CLIENT_TOKENS: strong("proxy-token"),
      AI_GATEWAY_ENABLED: "false",
    });
    expect(result).toEqual({
      ok: true,
      issues: [],
      managedGatewayEnabled: false,
    });
  });
});
