import { beforeEach, describe, expect, it } from "vitest";

import {
  getCloudEmbedIframeCode,
  getCloudEmbedLink,
  getCloudEmbedTokenFromUrl,
} from "./cloudEmbedLinks";

describe("cloudEmbedLinks", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "http://localhost:3000/board?x=1");
  });

  it("parses #embed tokens", () => {
    expect(getCloudEmbedTokenFromUrl("http://localhost/#embed=token-1")).toBe(
      "token-1",
    );
    expect(getCloudEmbedTokenFromUrl("http://localhost/#cloud=token-1")).toBe(
      null,
    );
    expect(getCloudEmbedTokenFromUrl("http://localhost/#embed=bad/token")).toBe(
      null,
    );
  });

  it("generates embed links on the current origin/path", () => {
    expect(getCloudEmbedLink("token-1")).toBe(
      "http://localhost:3000/board#embed=token-1",
    );
  });

  it("generates iframe snippets", () => {
    expect(
      getCloudEmbedIframeCode({
        token: "token-1",
        title: "Roadmap",
      }),
    ).toContain('src="http://localhost:3000/board#embed=token-1"');
  });
});
