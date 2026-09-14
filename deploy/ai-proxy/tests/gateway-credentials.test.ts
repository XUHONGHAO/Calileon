import { GatewayCredentialVault } from "../src/gateway/credentials.js";
import { EnvelopeCipher, LocalKekProvider } from "../src/gateway/crypto.js";
import { MemoryGatewayStore } from "../src/gateway/store.js";

describe("managed gateway credential vault", () => {
  it("encrypts credentials, caches short-lived plaintext, and rotates versions", async () => {
    const store = new MemoryGatewayStore();
    const cipher = new EnvelopeCipher(
      new LocalKekProvider(Buffer.alloc(32, 1).toString("base64")),
    );
    const vault = new GatewayCredentialVault(store, cipher, 60_000);
    await expect(
      vault.put("provider", Buffer.from("first-secret")),
    ).resolves.toBe(1);
    const first = await vault.get("provider");
    expect(first.toString()).toBe("first-secret");
    first.fill(0);
    await vault.put("provider", Buffer.from("second-secret"));
    const second = await vault.get("provider");
    expect(second.toString()).toBe("second-secret");
    second.fill(0);
    expect(
      store.credentials.get("provider")?.envelope.ciphertext,
    ).not.toContain("second-secret");
    await vault.remove("provider");
    await expect(vault.get("provider")).rejects.toMatchObject({
      code: "AI_GATEWAY_CREDENTIAL_UNAVAILABLE",
    });
  });
});
