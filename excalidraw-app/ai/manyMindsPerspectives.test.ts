import { beforeEach, describe, expect, it } from "vitest";

import {
  BUILTIN_MANY_MINDS_PERSPECTIVES,
  createCustomManyMindsPerspective,
  deleteCustomManyMindsPerspective,
  loadCustomManyMindsPerspectives,
  saveCustomManyMindsPerspectives,
} from "./manyMindsPerspectives";

describe("Many Minds perspectives", () => {
  beforeEach(() => localStorage.clear());

  it("provides eight safe built-in perspectives", () => {
    expect(BUILTIN_MANY_MINDS_PERSPECTIVES).toHaveLength(8);
    expect(
      BUILTIN_MANY_MINDS_PERSPECTIVES.every((item) => item.isBuiltIn),
    ).toBe(true);
    expect(JSON.stringify(BUILTIN_MANY_MINDS_PERSPECTIVES)).not.toMatch(
      /living artist|api[_ -]?key|authorization/i,
    );
  });

  it("sanitizes secrets in local custom perspectives", () => {
    const perspective = createCustomManyMindsPerspective({
      name: "Bearer secret-token",
      prompt:
        "api_key=sk-abcdefghijklmnop use https://cdn.test/x?X-Amz-Signature=secret",
      recommendedModelId: "model Authorization: super-secret",
    });
    expect(perspective).not.toBeNull();
    saveCustomManyMindsPerspectives([perspective!]);

    const serialized = localStorage.getItem(
      "excalidraw-many-minds-perspectives-v1",
    );
    expect(serialized).not.toContain("secret-token");
    expect(serialized).not.toContain("sk-abcdefghijklmnop");
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("Signature=secret");
    expect(loadCustomManyMindsPerspectives()).toHaveLength(1);
  });

  it("deletes only the requested local perspective", () => {
    const first = createCustomManyMindsPerspective({ name: "A", prompt: "A" })!;
    const second = createCustomManyMindsPerspective({
      name: "B",
      prompt: "B",
    })!;
    saveCustomManyMindsPerspectives([first, second]);
    expect(deleteCustomManyMindsPerspective(first.id)).toEqual([second]);
  });
});
