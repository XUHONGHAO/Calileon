import { describe, expect, it } from "vitest";

import {
  parseAllowedVideoHosts,
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
