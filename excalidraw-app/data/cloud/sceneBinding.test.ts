import { beforeEach, describe, expect, it, vi } from "vitest";

import { STORAGE_KEYS } from "../../app_constants";

import {
  clearCloudSceneBinding,
  getCloudPayloadHash,
  loadCloudSceneBinding,
  saveCloudSceneBinding,
} from "./sceneBinding";

const binding = {
  id: "scene-1",
  ownerId: "user-1",
  title: "Roadmap",
  version: 3,
  createdAt: 1,
  updatedAt: 2,
  localPayloadHash: getCloudPayloadHash('{"elements":[]}'),
  savedPayloadHash: getCloudPayloadHash('{"elements":[]}'),
};

describe("cloud scene binding", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("stores and loads the binding for the matching owner and payload", () => {
    saveCloudSceneBinding(binding);

    expect(loadCloudSceneBinding("user-1", binding.localPayloadHash)).toEqual(
      binding,
    );
  });

  it("ignores bindings from another owner", () => {
    saveCloudSceneBinding(binding);

    expect(
      loadCloudSceneBinding("user-2", binding.localPayloadHash),
    ).toBeNull();
  });

  it("ignores bindings for a different local payload", () => {
    saveCloudSceneBinding(binding);

    expect(
      loadCloudSceneBinding("user-1", getCloudPayloadHash('{"elements":[1]}')),
    ).toBeNull();
  });

  it("restores a binding after local edits update the local payload hash", () => {
    const editedBinding = {
      ...binding,
      localPayloadHash: getCloudPayloadHash('{"elements":[1]}'),
      savedPayloadHash: binding.savedPayloadHash,
    };
    saveCloudSceneBinding(editedBinding);

    expect(
      loadCloudSceneBinding("user-1", editedBinding.localPayloadHash),
    ).toEqual(editedBinding);
  });

  it("clears stored binding", () => {
    saveCloudSceneBinding(binding);
    clearCloudSceneBinding();

    expect(
      localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_CLOUD_SCENE),
    ).toBeNull();
  });

  it("returns null for invalid stored data", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_CLOUD_SCENE, "{");

    expect(loadCloudSceneBinding("user-1")).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});
