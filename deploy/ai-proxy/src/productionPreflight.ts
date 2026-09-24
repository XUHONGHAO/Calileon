import fs from "node:fs";

import { loadAIProxyConfig } from "./config.js";
import {
  loadGatewayDeclarativeConfig,
  loadGatewayRuntimeConfig,
} from "./gateway/config.js";

export type ProductionPreflightIssue = Readonly<{
  code: string;
  message: string;
}>;

export type ProductionPreflightResult = Readonly<{
  ok: boolean;
  issues: readonly ProductionPreflightIssue[];
  managedGatewayEnabled: boolean;
}>;

const MIN_SECRET_BYTES = 32;
const PLACEHOLDER_PATTERN = /(?:replace-with|example\.invalid|change-me|todo)/i;

const addIssue = (
  issues: ProductionPreflightIssue[],
  code: string,
  message: string,
) => {
  issues.push({ code, message });
};

const isStrongSecret = (value: string | undefined) =>
  !!value && Buffer.byteLength(value, "utf8") >= MIN_SECRET_BYTES;

const isSecurePostgresMode = (value: string) => {
  try {
    const url = new URL(value);
    const sslMode = url.searchParams.get("sslmode");
    return (
      sslMode === "require" ||
      sslMode === "verify-ca" ||
      sslMode === "verify-full"
    );
  } catch {
    return false;
  }
};

/**
 * Validate a production deployment without logging any environment value.
 * This is intentionally stricter than development config parsing so an
 * operator gets a single actionable gate before starting a real deployment.
 */
export const validateProductionEnvironment = (
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = fs.existsSync,
): ProductionPreflightResult => {
  const issues: ProductionPreflightIssue[] = [];

  if (env.NODE_ENV !== "production") {
    addIssue(issues, "NODE_ENV_NOT_PRODUCTION", "NODE_ENV must be production.");
  }

  try {
    const proxy = loadAIProxyConfig({ ...env, NODE_ENV: "production" });
    if (proxy.clientTokens.some((token) => PLACEHOLDER_PATTERN.test(token))) {
      addIssue(
        issues,
        "PROXY_TOKEN_PLACEHOLDER",
        "AI_PROXY_CLIENT_TOKENS contains a placeholder value.",
      );
    }
  } catch (error) {
    addIssue(
      issues,
      "PROXY_CONFIG_INVALID",
      error instanceof Error
        ? error.message
        : "The proxy configuration is invalid.",
    );
  }

  const managedGatewayEnabled =
    (env.AI_GATEWAY_ENABLED || "").trim().toLowerCase() === "true";
  if (!managedGatewayEnabled) {
    return { ok: issues.length === 0, issues, managedGatewayEnabled };
  }

  let runtime: ReturnType<typeof loadGatewayRuntimeConfig>;
  try {
    runtime = loadGatewayRuntimeConfig(
      { ...env, AI_GATEWAY_ENABLED: "true" },
      true,
    );
  } catch (error) {
    addIssue(
      issues,
      "GATEWAY_CONFIG_INVALID",
      error instanceof Error
        ? error.message
        : "The managed gateway configuration is invalid.",
    );
    return { ok: issues.length === 0, issues, managedGatewayEnabled };
  }

  if (
    runtime.kmsProvider !== "aws-kms" ||
    PLACEHOLDER_PATTERN.test(runtime.kmsKeyId)
  ) {
    addIssue(
      issues,
      "KMS_NOT_PRODUCTION_READY",
      "Managed production deployments require a non-placeholder AWS KMS key.",
    );
  }

  if (!isSecurePostgresMode(runtime.databaseUrl)) {
    addIssue(
      issues,
      "DATABASE_TLS_REQUIRED",
      "AI_GATEWAY_DATABASE_URL must set sslmode=require, verify-ca, or verify-full.",
    );
  }

  if (
    !isStrongSecret(runtime.metricsToken) ||
    PLACEHOLDER_PATTERN.test(runtime.metricsToken)
  ) {
    addIssue(
      issues,
      "METRICS_TOKEN_WEAK",
      "AI_GATEWAY_METRICS_TOKEN must be a non-placeholder token of at least 32 bytes.",
    );
  }

  if (!fileExists(runtime.routeConfigPath)) {
    addIssue(
      issues,
      "ROUTE_CONFIG_MISSING",
      "The configured managed route catalog file does not exist.",
    );
  } else {
    try {
      loadGatewayDeclarativeConfig(runtime.routeConfigPath, true);
    } catch (error) {
      addIssue(
        issues,
        "ROUTE_CONFIG_INVALID",
        error instanceof Error
          ? error.message
          : "The managed route catalog is invalid.",
      );
    }
  }

  return { ok: issues.length === 0, issues, managedGatewayEnabled };
};

if (process.argv[1]?.endsWith("productionPreflight.ts")) {
  const result = validateProductionEnvironment();
  if (!result.ok) {
    // This is a CLI gate; emit only stable codes and non-sensitive messages.
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(result));
    process.exitCode = 1;
  } else {
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        ok: true,
        managedGatewayEnabled: result.managedGatewayEnabled,
      }),
    );
  }
}
