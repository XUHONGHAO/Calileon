import { afterEach, describe, expect, it } from "vitest";

import {
  getErrorReportLocalStorage,
  sanitizeSentryBreadcrumbForTelemetry,
  sanitizeSentryEventForTelemetry,
  sanitizeVaultTelemetryValue,
} from "./redaction";

const vaultId = "123e4567-e89b-42d3-a456-426614174000";
const rootKey = "A".repeat(43);
const capability = `${"B".repeat(42)}A`;
const sentinel = "P4-PLAINTEXT-SENTINEL-20260713";
const vaultUrl = `https://vault.example/#vault=1&id=${vaultId}&key=${rootKey}&cap=${capability}`;

describe("Vault telemetry redaction", () => {
  afterEach(() => {
    window.history.replaceState({}, "", "/");
    localStorage.clear();
  });

  it("deeply removes Vault secrets and decrypted content without mutating input", () => {
    const source = {
      request: { url: vaultUrl },
      message: `Failed to open ${vaultUrl}`,
      extra: {
        arguments: [
          {
            vaultId,
            rootKey,
            invitationCapability: capability,
            generation: 7,
            payload: {
              elements: [{ type: "text", text: sentinel }],
            },
            diagnostics: [sentinel],
            unknownField: sentinel,
          },
        ],
      },
      exception: {
        values: [{ value: `cap=${capability} ${sentinel}` }],
      },
    };
    const original = structuredClone(source);

    const sanitized = sanitizeSentryEventForTelemetry(source);
    const serialized = JSON.stringify(sanitized);

    expect(source).toEqual(original);
    expect(serialized).not.toContain(rootKey);
    expect(serialized).not.toContain(capability);
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain("#vault=1");
    expect(sanitized.request.url).toBe("https://vault.example/");
    expect(serialized).toContain(vaultId);
    expect(serialized).toContain("generation");
    expect(serialized).toContain("7");
  });

  it("sanitizes navigation and console breadcrumb payloads", () => {
    const breadcrumb = sanitizeSentryBreadcrumbForTelemetry({
      category: "navigation",
      data: { from: vaultUrl, to: vaultUrl },
      message: vaultUrl,
      extra: { vaultId, arguments: [{ plaintext: sentinel }] },
    });
    const serialized = JSON.stringify(breadcrumb);

    expect(serialized).not.toContain(rootKey);
    expect(serialized).not.toContain(capability);
    expect(serialized).not.toContain(sentinel);
  });

  it("preserves ordinary diagnostics that have no Vault context", () => {
    const ordinary = {
      message: "ordinary collaboration failed",
      extra: { payload: { status: 500 } },
    };
    expect(sanitizeVaultTelemetryValue(ordinary)).toEqual(ordinary);
  });

  it("forces redaction from the current Vault route without event indicators", () => {
    window.history.replaceState(
      {},
      "",
      `/#vault=1&id=${vaultId}&key=${rootKey}&cap=${capability}`,
    );
    const event = sanitizeSentryEventForTelemetry({
      message: sentinel,
      extra: { detail: sentinel },
    });
    const breadcrumb = sanitizeSentryBreadcrumbForTelemetry({
      category: "console",
      message: sentinel,
    });

    expect(JSON.stringify(event)).not.toContain(sentinel);
    expect(JSON.stringify(breadcrumb)).not.toContain(sentinel);
  });

  it("keeps indicator-free errors unchanged on an ordinary route", () => {
    window.history.replaceState({}, "", "/");
    const event = {
      message: sentinel,
      extra: { detail: sentinel },
    };

    expect(sanitizeSentryEventForTelemetry(event)).toEqual(event);
  });

  it("does not enumerate localStorage on a Vault route", () => {
    localStorage.setItem("secret", sentinel);
    const report = getErrorReportLocalStorage(localStorage, true);
    expect(report).not.toContain(sentinel);
    expect(report).toContain("REDACTED_VAULT_CONTENT");
  });

  it("keeps ordinary localStorage diagnostics unchanged", () => {
    localStorage.setItem("json", JSON.stringify({ status: "ordinary" }));
    localStorage.setItem("raw", "ordinary-value");

    expect(JSON.parse(getErrorReportLocalStorage(localStorage, false))).toEqual(
      {
        json: { status: "ordinary" },
        raw: "ordinary-value",
      },
    );
  });
});
