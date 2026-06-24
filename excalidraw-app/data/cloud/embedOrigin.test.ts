import { describe, expect, it } from "vitest";

import {
  getEmbedParentOrigin,
  isEmbedOriginAllowed,
  normalizeEmbedOrigin,
  normalizeEmbedOrigins,
} from "./embedOrigin";

describe("embedOrigin", () => {
  it("normalizes exact HTTP origins", () => {
    expect(normalizeEmbedOrigin("http://127.0.0.1:4313/page")).toBe(
      "http://127.0.0.1:4313",
    );
    expect(normalizeEmbedOrigin("https://example.com/a?b=1")).toBe(
      "https://example.com",
    );
  });

  it("rejects non-http origins and wildcards", () => {
    expect(normalizeEmbedOrigin("*")).toBe(null);
    expect(normalizeEmbedOrigin("file:///tmp/host.html")).toBe(null);
    expect(normalizeEmbedOrigin("ftp://example.com/file")).toBe(null);
  });

  it("deduplicates normalized origins", () => {
    expect(
      normalizeEmbedOrigins([
        "http://127.0.0.1:4313/a",
        "http://127.0.0.1:4313/b",
        "https://example.com",
      ]),
    ).toEqual(["http://127.0.0.1:4313", "https://example.com"]);
  });

  it("checks allowed origins exactly", () => {
    expect(
      isEmbedOriginAllowed(
        ["http://127.0.0.1:4313"],
        "http://127.0.0.1:4313/host.html",
      ),
    ).toBe(true);
    expect(
      isEmbedOriginAllowed(["http://127.0.0.1:4313"], "http://127.0.0.1:4314"),
    ).toBe(false);
  });

  it("prefers referrer origin for iframe parent origin", () => {
    expect(
      getEmbedParentOrigin({
        referrer: "http://127.0.0.1:4313/host.html",
        fallbackOrigin: "http://localhost:3000",
      }),
    ).toBe("http://127.0.0.1:4313");
  });
});
