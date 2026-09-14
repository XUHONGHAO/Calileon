import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadGatewayDeclarativeConfig,
  loadGatewayRuntimeConfig,
} from "./gateway/config.js";
import {
  AwsKmsDataKeyProvider,
  EnvelopeCipher,
  LocalKekProvider,
} from "./gateway/crypto.js";
import { GatewayCredentialVault } from "./gateway/credentials.js";
import { PostgresGatewayStore } from "./gateway/store.js";

const requireTTY = () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("AI Gateway administration requires an interactive TTY.");
  }
};

const readSecret = async (prompt: string) => {
  requireTTY();
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  let value = "";
  try {
    for await (const chunk of process.stdin) {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n") {
          process.stdout.write("\n");
          return value;
        }
        if (character === "\u0003") {
          throw new Error("Cancelled.");
        }
        if (character === "\b" || character === "\u007f") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
        }
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  return value;
};

let store: PostgresGatewayStore | null = null;
let credentials: GatewayCredentialVault | null = null;

const getRuntime = () =>
  loadGatewayRuntimeConfig(process.env, process.env.NODE_ENV === "production");

const getDatabaseURLForMigration = () => {
  const databaseUrl = (process.env.AI_GATEWAY_DATABASE_URL || "").trim();
  if (!databaseUrl) {
    throw new Error("AI_GATEWAY_DATABASE_URL is required for migrations.");
  }
  return databaseUrl;
};

const getStore = (databaseUrl: string) => {
  store ||= new PostgresGatewayStore(databaseUrl);
  return store;
};

const getCredentialServices = () => {
  const runtime = getRuntime();
  const gatewayStore = getStore(runtime.databaseUrl);
  const keyProvider =
    runtime.kmsProvider === "aws-kms"
      ? new AwsKmsDataKeyProvider(runtime.kmsKeyId)
      : new LocalKekProvider(runtime.localKek);
  const cipher = new EnvelopeCipher(keyProvider);
  credentials ||= new GatewayCredentialVault(
    gatewayStore,
    cipher,
    runtime.credentialCacheMs,
  );
  return { runtime, store: gatewayStore, cipher, credentials };
};

const args = process.argv.slice(2);

const main = async () => {
  const [group, action, ...rest] = args;
  if (group === "config" && action === "validate") {
    const runtime = getRuntime();
    loadGatewayDeclarativeConfig(runtime.routeConfigPath, runtime.production);
    console.info("Gateway configuration is valid.");
    return;
  }
  if (group === "migrate") {
    const gatewayStore = getStore(getDatabaseURLForMigration());
    const here = path.dirname(fileURLToPath(import.meta.url));
    const migrationPath = path.resolve(
      here,
      "../migrations/0001_ai_gateway.sql",
    );
    await gatewayStore.migrate?.(fs.readFileSync(migrationPath, "utf8"));
    console.info("AI Gateway migrations applied.");
    return;
  }
  requireTTY();
  const services = getCredentialServices();
  const runtime = services.runtime;
  const gatewayStore = services.store;
  const cipher = services.cipher;
  const gatewayCredentials = services.credentials;
  if (group === "credential" && action === "put" && rest[0]) {
    const plaintext = Buffer.from(await readSecret("Provider credential: "));
    try {
      if (!plaintext.byteLength) {
        throw new Error("The credential cannot be empty.");
      }
      const version = await gatewayCredentials.put(rest[0], plaintext);
      console.info(`Credential ${rest[0]} stored at version ${version}.`);
    } finally {
      plaintext.fill(0);
    }
    return;
  }
  if (group === "credential" && action === "delete" && rest[0]) {
    await gatewayCredentials.remove(rest[0]);
    console.info(`Credential ${rest[0]} deleted.`);
    return;
  }
  if (group === "policy" && action === "assign" && rest.length >= 3) {
    const [issuer, subject, policyId] = rest;
    const declarative = loadGatewayDeclarativeConfig(
      runtime.routeConfigPath,
      runtime.production,
    );
    if (!declarative.policies.some((policy) => policy.id === policyId)) {
      throw new Error("The policy is not present in the declarative config.");
    }
    await gatewayStore.assignPolicy(
      { issuer, subject, source: "jwt" },
      policyId,
    );
    console.info(`Policy ${policyId} assigned to ${issuer}/${subject}.`);
    return;
  }
  if (group === "audit" && action === "read" && rest[0]) {
    const reasonIndex = rest.indexOf("--reason");
    const reason = reasonIndex >= 0 ? rest[reasonIndex + 1]?.trim() : "";
    if (reason.length < 10) {
      throw new Error(
        "Audit access requires --reason with at least 10 characters.",
      );
    }
    const audit = await gatewayStore.getAuditForAdmin?.(rest[0]);
    if (!audit) {
      throw new Error("The audit record was not found or has expired.");
    }
    await gatewayStore.recordAuditAccess({
      auditId: rest[0],
      reason,
      operator: process.env.USERNAME || process.env.USER || "unknown",
    });
    const plaintext = await cipher.decrypt(audit.envelope, {
      purpose: "prompt-audit",
      issuer: audit.identity.issuer,
      subject: audit.identity.subject,
      routeId: audit.routeId,
    });
    try {
      process.stdout.write(`${plaintext.toString("utf8")}\n`);
    } finally {
      plaintext.fill(0);
    }
    return;
  }
  if (group === "purge") {
    const count = await gatewayStore.purgeExpired(Date.now());
    console.info(`Purged ${count} expired AI Gateway records.`);
    return;
  }
  throw new Error(
    "Usage: admin config validate | migrate | credential put|delete <id> | policy assign <issuer> <subject> <policy> | audit read <id> --reason <text> | purge",
  );
};

main()
  .catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Administration failed.",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    credentials?.clear();
    await store?.close();
  });
