import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

describe("AI gateway operational assets", () => {
  it("ships reversible backup, restore, and failure drill entry points", () => {
    const backup = fs.readFileSync(
      path.join(directory, "ops", "backup.ps1"),
      "utf8",
    );
    const restore = fs.readFileSync(
      path.join(directory, "ops", "restore.ps1"),
      "utf8",
    );
    const drill = fs.readFileSync(
      path.join(directory, "ops", "failure-drill.ps1"),
      "utf8",
    );

    expect(backup).toContain("pg_dump");
    expect(backup).toContain("Remove-Item");
    expect(restore).toContain("ConfirmRestore");
    expect(restore).toContain("single-transaction");
    expect(drill).toContain("database-unavailable");
    expect(drill).toContain("readyz");
  });

  it("keeps the security gate focused on hardening invariants", () => {
    const audit = fs.readFileSync(
      path.join(directory, "ops", "security-audit.mjs"),
      "utf8",
    );
    const runbook = fs.readFileSync(
      path.join(directory, "ops", "OPERATIONS.md"),
      "utf8",
    );
    const acceptance = fs.readFileSync(
      path.join(directory, "ops", "production-acceptance.mjs"),
      "utf8",
    );

    expect(audit).toContain("PRIVATE KEY");
    expect(audit).toContain("output discard");
    expect(audit).toContain("no-new-privileges");
    expect(runbook).toContain("yarn ai-proxy:preflight");
    expect(runbook).toContain("yarn ai-proxy:security-audit");
    expect(runbook).toContain("-ConfirmRestore");
    expect(acceptance).toContain("AI_GATEWAY_ACCEPTANCE_JWT");
    expect(acceptance).toContain("/ai-gateway/v1/catalog");
  });
});
