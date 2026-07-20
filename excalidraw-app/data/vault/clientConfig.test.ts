import { afterEach, describe, expect, it, vi } from "vitest";

const loadConfig = async () => {
  vi.resetModules();
  return await import("./clientConfig");
};

describe("Vault client configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps the product entry disabled by default", async () => {
    const { readVaultClientConfig } = await loadConfig();
    expect(readVaultClientConfig()).toEqual({
      enabled: false,
      persistenceCapabilitiesUrl: null,
      roomCapabilitiesUrl: null,
      roomProvisionUrl: null,
    });
  });

  it("requires every dedicated Vault endpoint", async () => {
    vi.stubEnv("VITE_APP_VAULT_ENABLED", "true");
    vi.stubEnv(
      "VITE_APP_VAULT_PERSISTENCE_CAPABILITIES_URL",
      "https://vault.example/.well-known/vault-capabilities",
    );
    const { assertVaultClientConfig, readVaultClientConfig } =
      await loadConfig();
    expect(() => assertVaultClientConfig(readVaultClientConfig())).toThrowError(
      expect.objectContaining({
        code: "VAULT_PERSISTENCE_UNAVAILABLE",
      }),
    );
  });

  it("accepts only an explicitly enabled complete Vault deployment", async () => {
    vi.stubEnv("VITE_APP_VAULT_ENABLED", "true");
    vi.stubEnv(
      "VITE_APP_VAULT_PERSISTENCE_CAPABILITIES_URL",
      "https://vault.example/.well-known/vault-capabilities",
    );
    vi.stubEnv(
      "VITE_APP_VAULT_ROOM_CAPABILITIES_URL",
      "https://room.example/.well-known/vault-capabilities",
    );
    vi.stubEnv(
      "VITE_APP_VAULT_ROOM_PROVISION_URL",
      "https://room.example/vault/rooms",
    );
    const { assertVaultClientConfig, readVaultClientConfig } =
      await loadConfig();
    const config = readVaultClientConfig();
    expect(() => assertVaultClientConfig(config)).not.toThrow();
  });

  it.each([
    "http://vault.example/capabilities",
    "https://user:pass@vault.example/capabilities",
    "https://vault.example/capabilities#fragment",
  ])("rejects unsafe Vault endpoints: %s", async (unsafeUrl) => {
    vi.stubEnv("VITE_APP_VAULT_ENABLED", "true");
    vi.stubEnv(
      "VITE_APP_VAULT_PERSISTENCE_CAPABILITIES_URL",
      "https://vault.example/.well-known/vault-capabilities",
    );
    vi.stubEnv(
      "VITE_APP_VAULT_ROOM_CAPABILITIES_URL",
      "https://room.example/.well-known/vault-capabilities",
    );
    vi.stubEnv("VITE_APP_VAULT_ROOM_PROVISION_URL", unsafeUrl);
    const { assertVaultClientConfig, readVaultClientConfig } =
      await loadConfig();
    expect(() => assertVaultClientConfig(readVaultClientConfig())).toThrowError(
      expect.objectContaining({ code: "VAULT_PERSISTENCE_UNAVAILABLE" }),
    );
  });
});
