import { describe, expect, it, vi } from "vitest";

import { STORAGE_KEYS } from "../app_constants";

import {
  createLegacyAIWorkbenchScope,
  getAIWorkbenchMaskManifestKey,
  getAIWorkbenchReferenceManifestKey,
  getLegacyAIWorkbenchMaskKey,
  getLegacyAIWorkbenchReferenceKey,
  getOrCreateLocalDocumentId,
  rotateLocalDocumentId,
  shouldRotateLocalDocumentId,
  resolveAIWorkbenchPersistenceScope,
} from "./workbenchPersistenceScope";

const createStorage = () => {
  const values = new Map<string, string>();

  return {
    values,
    storage: {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        values.set(key, value);
      }),
    },
  };
};

describe("AI Workbench persistence scope", () => {
  it("creates and reuses a stable local document id", () => {
    const { storage, values } = createStorage();
    const createId = vi.fn(() => "local-document-1");

    expect(getOrCreateLocalDocumentId({ storage, createId })).toBe(
      "local-document-1",
    );
    expect(getOrCreateLocalDocumentId({ storage, createId })).toBe(
      "local-document-1",
    );
    expect(createId).toHaveBeenCalledTimes(1);
    expect(
      values.get(STORAGE_KEYS.LOCAL_STORAGE_AI_WORKBENCH_LOCAL_DOCUMENT_ID),
    ).toBe("local-document-1");
  });

  it("keeps a session-stable local id when localStorage cannot write", () => {
    const createId = vi.fn(() => "fallback-document");
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }),
    };

    expect(getOrCreateLocalDocumentId({ storage, createId })).toBe(
      "fallback-document",
    );
    expect(getOrCreateLocalDocumentId({ storage, createId })).toBe(
      "fallback-document",
    );
    expect(createId).toHaveBeenCalledTimes(1);
  });

  it("rotates the current local document id and persists it for refresh", () => {
    const { storage, values } = createStorage();

    expect(
      rotateLocalDocumentId({
        storage,
        createId: () => "local-document-2",
      }),
    ).toBe("local-document-2");
    expect(
      values.get(STORAGE_KEYS.LOCAL_STORAGE_AI_WORKBENCH_LOCAL_DOCUMENT_ID),
    ).toBe("local-document-2");
    expect(
      getOrCreateLocalDocumentId({
        storage,
        createId: () => "should-not-be-created",
      }),
    ).toBe("local-document-2");
  });

  it("uses the rotated id for the session when localStorage cannot write", () => {
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      }),
    };

    expect(
      rotateLocalDocumentId({
        storage,
        createId: () => "rotated-fallback-document",
      }),
    ).toBe("rotated-fallback-document");
    expect(
      getOrCreateLocalDocumentId({
        storage,
        createId: () => "should-not-be-created",
      }),
    ).toBe("rotated-fallback-document");
  });

  it("rotates only for local scene replacements", () => {
    const localContext = {
      hasActiveEmbeddedScene: false,
      hasActiveSharedScene: false,
      hasActiveCloudScene: false,
      isCollaborating: false,
    };

    expect(shouldRotateLocalDocumentId(localContext)).toBe(true);
    expect(
      shouldRotateLocalDocumentId({
        ...localContext,
        hasActiveEmbeddedScene: true,
      }),
    ).toBe(false);
    expect(
      shouldRotateLocalDocumentId({
        ...localContext,
        hasActiveSharedScene: true,
      }),
    ).toBe(false);
    expect(
      shouldRotateLocalDocumentId({
        ...localContext,
        hasActiveCloudScene: true,
      }),
    ).toBe(false);
    expect(
      shouldRotateLocalDocumentId({
        ...localContext,
        isCollaborating: true,
      }),
    ).toBe(false);
  });

  it("resolves scope in embed, share, cloud, collaboration, local order", () => {
    const context = {
      activeEmbeddedScene: { id: "embed-scene" },
      activeSharedScene: { id: "shared-scene" },
      activeCloudScene: { id: "cloud-scene" },
      activeCollaboration: { roomId: "room-1" },
      localDocumentId: "local-1",
    };

    expect(resolveAIWorkbenchPersistenceScope(context)).toBe(
      "embed:embed-scene",
    );
    expect(
      resolveAIWorkbenchPersistenceScope({
        ...context,
        activeEmbeddedScene: null,
      }),
    ).toBe("share:shared-scene");
    expect(
      resolveAIWorkbenchPersistenceScope({
        ...context,
        activeEmbeddedScene: null,
        activeSharedScene: null,
      }),
    ).toBe("cloud:cloud-scene");
    expect(
      resolveAIWorkbenchPersistenceScope({
        ...context,
        activeEmbeddedScene: null,
        activeSharedScene: null,
        activeCloudScene: null,
      }),
    ).toBe("collab:room-1");
    expect(
      resolveAIWorkbenchPersistenceScope({
        activeCollaboration: null,
        localDocumentId: "local-1",
      }),
    ).toBe("local:local-1");
  });

  it("does not fall back to lower-priority or secret identities for an active remote context with no id", () => {
    expect(
      resolveAIWorkbenchPersistenceScope({
        activeEmbeddedScene: { id: "" },
        activeSharedScene: { id: "shared-scene" },
        activeCloudScene: { id: "cloud-scene" },
        activeCollaboration: { roomId: "room-1" },
        localDocumentId: "local-1",
      }),
    ).toBeNull();
    expect(
      resolveAIWorkbenchPersistenceScope({
        activeCollaboration: { roomId: "  " },
        localDocumentId: "local-1",
      }),
    ).toBeNull();
  });

  it("builds new manifest keys from the stable scope only", () => {
    const scope = resolveAIWorkbenchPersistenceScope({
      activeSharedScene: { id: "scene-123" },
      localDocumentId: "local-1",
    });

    expect(scope).toBe("share:scene-123");
    const referenceKey = getAIWorkbenchReferenceManifestKey(scope!);
    const maskKey = getAIWorkbenchMaskManifestKey(scope!);

    expect(referenceKey).toBe(
      "ai-workbench-reference-manifest:share%3Ascene-123",
    );
    expect(maskKey).toBe("ai-workbench-mask-manifest:share%3Ascene-123");
    expect(`${referenceKey}${maskKey}`).not.toContain("secret-token");
    expect(`${referenceKey}${maskKey}`).not.toContain("?share=");
  });

  it("keeps pathname, search, and scene name isolated to legacy helpers", () => {
    const legacyInput = {
      pathname: "/board",
      search: "?share=secret-token",
      sceneName: "Renamable board",
    };

    expect(createLegacyAIWorkbenchScope(legacyInput)).toBe(
      "/board?share=secret-token:Renamable board",
    );
    expect(getLegacyAIWorkbenchReferenceKey(legacyInput)).toBe(
      "ai-reference-images-%2Fboard%3Fshare%3Dsecret-token%3ARenamable%20board",
    );
    expect(getLegacyAIWorkbenchMaskKey(legacyInput)).toBe(
      "ai-inpaint-masks-%2Fboard%3Fshare%3Dsecret-token%3ARenamable%20board",
    );
    expect(
      createLegacyAIWorkbenchScope({
        pathname: "/",
        search: "",
        sceneName: " ",
      }),
    ).toBe("/:default");
  });
});
