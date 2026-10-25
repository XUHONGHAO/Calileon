import { beforeEach, describe, expect, it } from "vitest";

import {
  BUILTIN_MANY_MINDS_PERSPECTIVES,
  createCustomManyMindsPerspective,
  deleteCustomManyMindsPerspective,
  loadCustomManyMindsPerspectives,
  getBuiltInManyMindsPerspectiveNameKey,
  getDefaultManyMindsPerspectiveIds,
  saveCustomManyMindsPerspectives,
} from "./manyMindsPerspectives";
import { MANY_MINDS_MAX_TASKS } from "./manyMindsTypes";

describe("Many Minds perspectives", () => {
  beforeEach(() => localStorage.clear());

  it("provides enough safe built-in perspectives for the largest grid", () => {
    expect(BUILTIN_MANY_MINDS_PERSPECTIVES).toHaveLength(MANY_MINDS_MAX_TASKS);
    expect(
      new Set(BUILTIN_MANY_MINDS_PERSPECTIVES.map((item) => item.id)).size,
    ).toBe(MANY_MINDS_MAX_TASKS);
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

  it("fills every default slot with a distinct built-in perspective", () => {
    const ids = getDefaultManyMindsPerspectiveIds(MANY_MINDS_MAX_TASKS);
    expect(ids).toHaveLength(MANY_MINDS_MAX_TASKS);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(MANY_MINDS_MAX_TASKS);
    // Never leaves an empty slot, even past the built-in count.
    expect(getDefaultManyMindsPerspectiveIds(12).every(Boolean)).toBe(true);
  });

  it("maps only built-in ids to translated names", () => {
    expect(getBuiltInManyMindsPerspectiveNameKey("clarify")).toBe(
      "ai.manyMinds.perspectiveNames.clarify",
    );
    const custom = createCustomManyMindsPerspective({
      name: "A",
      prompt: "A",
    })!;
    expect(getBuiltInManyMindsPerspectiveNameKey(custom.id)).toBeNull();
  });
});
