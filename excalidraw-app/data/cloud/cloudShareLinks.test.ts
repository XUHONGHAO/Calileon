import { describe, expect, it } from "vitest";

import {
  getCloudShareAccessFromUrl,
  getCloudShareLink,
  getCloudShareTokenFromUrl,
} from "./cloudShareLinks";

describe("cloudShareLinks", () => {
  it("parses #cloud tokens", () => {
    expect(
      getCloudShareTokenFromUrl("https://app.example/#cloud=abc_123"),
    ).toBe("abc_123");
    expect(
      getCloudShareAccessFromUrl("https://app.example/#cloud=abc_123,key-1"),
    ).toEqual({ token: "abc_123", key: "key-1" });
  });

  it("does not match legacy json or collaboration links", () => {
    expect(
      getCloudShareTokenFromUrl("https://app.example/#json=a,b"),
    ).toBeNull();
    expect(
      getCloudShareTokenFromUrl("https://app.example/#room=a,b"),
    ).toBeNull();
  });

  it("generates cloud share links on the current origin/path", () => {
    window.history.replaceState({}, "", "/board?foo=1#room=a,b");

    expect(getCloudShareLink("token-1")).toBe(
      "http://localhost:3000/board#cloud=token-1",
    );
    expect(getCloudShareLink("token-1", "key-1")).toBe(
      "http://localhost:3000/board#cloud=token-1,key-1",
    );
  });
});
