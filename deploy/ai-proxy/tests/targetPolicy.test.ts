import { createPinnedLookup } from "../src/dnsPin.js";
import { isBlockedIPAddress, resolveTarget } from "../src/targetPolicy.js";

const productionPolicy = {
  production: true,
  allowHttpLocalhost: false,
};

describe("AI proxy target policy", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.2.1",
    "192.168.0.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:10.0.0.1",
  ])("blocks non-public address %s", (address) => {
    expect(isBlockedIPAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"])(
    "allows global unicast address %s",
    (address) => {
      expect(isBlockedIPAddress(address)).toBe(false);
    },
  );

  it("rejects mixed public and private DNS answers", async () => {
    await expect(
      resolveTarget("https://provider.example/v1", {
        ...productionPolicy,
        lookupAll: async () => [
          { address: "8.8.8.8", family: 4 },
          { address: "10.0.0.1", family: 4 },
        ],
      }),
    ).rejects.toMatchObject({ code: "AI_PROXY_TARGET_BLOCKED" });
  });

  it("returns the validated address that must be used for the connection", async () => {
    await expect(
      resolveTarget("https://provider.example/v1", {
        ...productionPolicy,
        lookupAll: async () => [
          { address: "2001:4860:4860::8888", family: 6 },
          { address: "8.8.8.8", family: 4 },
        ],
      }),
    ).resolves.toMatchObject({
      hostname: "provider.example",
      address: "2001:4860:4860::8888",
      family: 6,
    });
  });

  it("only permits plaintext loopback targets in explicit development mode", async () => {
    await expect(
      resolveTarget("http://127.0.0.1:3017/provider", {
        production: false,
        allowHttpLocalhost: true,
      }),
    ).resolves.toMatchObject({ address: "127.0.0.1", family: 4 });

    await expect(
      resolveTarget("http://127.0.0.1:3017/provider", productionPolicy),
    ).rejects.toMatchObject({ code: "AI_PROXY_TARGET_BLOCKED" });

    await expect(
      resolveTarget("http://10.0.0.1/provider", {
        production: false,
        allowHttpLocalhost: true,
      }),
    ).rejects.toMatchObject({ code: "AI_PROXY_TARGET_BLOCKED" });
  });

  it("rejects credentials, fragments, and non-HTTP protocols", async () => {
    await expect(
      resolveTarget("https://user:pass@provider.example/v1", {
        ...productionPolicy,
        lookupAll: async () => [{ address: "8.8.8.8", family: 4 }],
      }),
    ).rejects.toMatchObject({ code: "AI_PROXY_TARGET_INVALID" });
    await expect(
      resolveTarget("https://provider.example/v1#secret", {
        ...productionPolicy,
        lookupAll: async () => [{ address: "8.8.8.8", family: 4 }],
      }),
    ).rejects.toMatchObject({ code: "AI_PROXY_TARGET_INVALID" });
    await expect(
      resolveTarget("file:///etc/passwd", productionPolicy),
    ).rejects.toMatchObject({ code: "AI_PROXY_TARGET_INVALID" });
  });

  it("pins lookup calls to the already validated address", async () => {
    const lookup = createPinnedLookup("8.8.8.8", 4);

    await expect(
      new Promise((resolve, reject) => {
        lookup("provider.example", { all: false }, (error, address, family) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ address, family });
        });
      }),
    ).resolves.toEqual({ address: "8.8.8.8", family: 4 });
  });
});
