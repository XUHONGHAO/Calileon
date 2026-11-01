import { describe, expect, it } from "vitest";

import {
  hasVideoSignature,
  parseAllowedVideoHosts,
  readVideoBodyWithLimit,
  validateVideoSourceURL,
} from "./videoSecurity";

describe("video ingest URL validation", () => {
  const allowedHosts = parseAllowedVideoHosts(
    "cdn.provider.example,*.trusted-video.example",
  );

  it("accepts exact and wildcard HTTPS provider hosts", () => {
    expect(
      validateVideoSourceURL(
        "https://cdn.provider.example/output?signature=keep",
        allowedHosts,
      ).hostname,
    ).toBe("cdn.provider.example");
    expect(
      validateVideoSourceURL(
        "https://a.trusted-video.example/output",
        allowedHosts,
      ).hostname,
    ).toBe("a.trusted-video.example");
  });

  it("rejects wildcard apex, HTTP, credentials, ports, IPs, and unlisted hosts", () => {
    for (const url of [
      "https://trusted-video.example/output",
      "http://cdn.provider.example/output",
      "https://user:pass@cdn.provider.example/output",
      "https://cdn.provider.example:8443/output",
      "https://127.0.0.1/output",
      "https://169.254.169.254/latest/meta-data",
      "https://untrusted.example/output",
    ]) {
      expect(() => validateVideoSourceURL(url, allowedHosts)).toThrow(
        "video-source-not-allowed",
      );
    }
  });
});

describe("video upload signature check", () => {
  const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69]);
  const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f]);

  it("accepts bytes that match the declared type", () => {
    expect(hasVideoSignature(mp4, "video/mp4")).toBe(true);
    expect(hasVideoSignature(webm, "video/webm")).toBe(true);
  });

  it("rejects mismatched, truncated and other content", () => {
    expect(hasVideoSignature(webm, "video/mp4")).toBe(false);
    expect(hasVideoSignature(mp4, "video/webm")).toBe(false);
    expect(hasVideoSignature(mp4.slice(0, 7), "video/mp4")).toBe(false);
    expect(
      hasVideoSignature(new TextEncoder().encode("<html>"), "video/mp4"),
    ).toBe(false);
    expect(hasVideoSignature(mp4, "text/html")).toBe(false);
  });
});

describe("video body limit", () => {
  it("reads a request body and rejects one over the limit", async () => {
    const request = new Request("https://fn.example/ingest", {
      method: "POST",
      body: new Uint8Array([1, 2, 3, 4]),
    });
    await expect(readVideoBodyWithLimit(request, 4)).resolves.toHaveLength(4);
    await expect(
      readVideoBodyWithLimit(
        new Request("https://fn.example/ingest", {
          method: "POST",
          body: new Uint8Array([1, 2, 3, 4, 5]),
        }),
        4,
      ),
    ).rejects.toThrow("video-too-large");
  });
});
