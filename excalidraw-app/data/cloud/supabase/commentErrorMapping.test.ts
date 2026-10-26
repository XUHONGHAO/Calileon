import { describe, expect, it } from "vitest";

import { BackendError } from "../errors";

import { COMMENT_ERROR_CODES, mapCommentError } from "./errorMapping";

describe("mapCommentError", () => {
  it("has its own wording for every comments-* code", () => {
    const messages = new Set<string>();
    for (const code of COMMENT_ERROR_CODES) {
      const error = mapCommentError({ message: code, code: "P0001" });
      expect(error).toBeInstanceOf(BackendError);
      expect(error.message.trim()).not.toBe("");
      expect(error.message).not.toContain("comments.errors");
      messages.add(error.message);
    }
    // two codes sharing one sentence would hide which rule was hit
    expect(messages.size).toBe(COMMENT_ERROR_CODES.length);
  });

  it("covers every code schema_comments.sql raises", () => {
    expect([...COMMENT_ERROR_CODES].sort()).toEqual(
      [
        "comments-empty",
        "comments-forbidden",
        "comments-invalid",
        "comments-not-found",
        "comments-quoted-missing",
        "comments-rate-limited",
        "comments-scene-full",
        "comments-too-long",
        "comments-unauthorized",
        "comments-unsupported",
      ].sort(),
    );
  });

  it("maps codes to the backend error kinds the controller acts on", () => {
    const code = (message: string) => mapCommentError({ message }).code;
    expect(code("comments-forbidden")).toBe("forbidden");
    expect(code("comments-unauthorized")).toBe("unauthorized");
    expect(code("comments-unsupported")).toBe("not-configured");
    expect(code("comments-not-found")).toBe("conflict");
    expect(code("comments-too-long")).toBe("payload-too-large");
    expect(code("comments-rate-limited")).toBe("quota-exceeded");
  });

  it("finds the code inside a longer Postgres message", () => {
    expect(
      mapCommentError({ message: "ERROR: comments-scene-full (P0001)" }).code,
    ).toBe("quota-exceeded");
  });

  it("uses the comment wording for network failures", () => {
    const error = mapCommentError(new TypeError("Failed to fetch"));
    expect(error.code).toBe("network");
    expect(error.message).toBe("Could not reach the comment server.");
  });
});
