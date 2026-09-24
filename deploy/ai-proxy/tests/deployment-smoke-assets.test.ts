import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

describe("AI proxy deployment smoke assets", () => {
  it("keeps the container smoke stack self-contained", () => {
    const compose = fs.readFileSync(
      path.join(directory, "compose.yml"),
      "utf8",
    );
    const caddy = fs.readFileSync(
      path.join(directory, "Caddyfile.smoke"),
      "utf8",
    );
    const smokeServer = fs.readFileSync(
      path.join(directory, "smoke-server.mjs"),
      "utf8",
    );

    expect(compose).toContain('profiles: ["smoke"]');
    expect(compose).toContain("smoke-upstream");
    expect(compose).toContain("Caddyfile.smoke:/etc/caddy/Caddyfile:ro");
    expect(caddy).toContain("flush_interval -1");
    expect(caddy).toContain("smoke-upstream:8090");
    expect(smokeServer).toContain("text/event-stream");
    expect(smokeServer).toContain("application/octet-stream");
  });

  it("does not include deployment credentials in the checked-in smoke client", () => {
    const client = fs.readFileSync(
      path.join(directory, "smoke-client.mjs"),
      "utf8",
    );
    expect(client).not.toMatch(/(api[_-]?key|secret|password|jwt|bearer)/i);
  });
});
