#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const fail = (message) => failures.push(message);

const walk = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", "ops"].includes(entry.name)) {
      continue;
    }
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(target);
    } else if (
      !entry.name.endsWith(".example") &&
      !entry.name.endsWith(".map")
    ) {
      const content = fs.readFileSync(target, "utf8");
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) {
        fail(`private key material found in ${path.relative(root, target)}`);
      }
      if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(content)) {
        fail(`AWS access key material found in ${path.relative(root, target)}`);
      }
      if (
        /^\s*AI_GATEWAY_POSTGRES_PASSWORD\s*=\s*(?!replace-with)/m.test(content)
      ) {
        fail(
          `database password assignment found in ${path.relative(
            root,
            target,
          )}`,
        );
      }
    }
  }
};

walk(root);
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (
    entry.isFile() &&
    /^\.env(?:\.|$)/.test(entry.name) &&
    entry.name !== ".env.example"
  ) {
    fail(`deployment environment file is tracked: ${entry.name}`);
  }
}

const compose = fs.readFileSync(path.join(root, "compose.yml"), "utf8");
const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
const caddy = fs.readFileSync(path.join(root, "Caddyfile.example"), "utf8");
const runtime = fs.readFileSync(
  path.join(root, "src", "gateway", "config.ts"),
  "utf8",
);
const logger = fs.readFileSync(path.join(root, "src", "logger.ts"), "utf8");

if (
  !/read_only:\s*true/.test(compose) ||
  !/cap_drop:\s*\n\s*- ALL/.test(compose)
) {
  fail("Compose must keep the gateway read-only and drop all capabilities");
}
if (!/USER node/.test(dockerfile) || !/no-new-privileges:true/.test(compose)) {
  fail("The image must run as node with no-new-privileges");
}
if (!/flush_interval -1/.test(caddy) || !/output discard/.test(caddy)) {
  fail("Caddy must preserve streaming and discard sensitive access logs");
}
if (
  !/AI_GATEWAY_TRUST_PROXY.*false/.test(runtime) &&
  !/trustProxy: readBoolean\(env\.AI_GATEWAY_TRUST_PROXY, false\)/.test(runtime)
) {
  fail("Gateway proxy trust must default to false");
}
if (/request\.headers|request\.body|provider.*key/i.test(logger)) {
  fail("Proxy logger must not dump headers, bodies, or provider credentials");
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, scope: "deploy/ai-proxy" }));
}
