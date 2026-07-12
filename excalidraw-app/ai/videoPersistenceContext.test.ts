import {
  assertAIVideoPersistenceContext,
  resolveAIVideoPersistenceContextToken,
} from "./videoPersistenceContext";

describe("AI video persistence context", () => {
  it("distinguishes owner and local document contexts", () => {
    expect(
      resolveAIVideoPersistenceContextToken({
        activeCloudSceneId: "scene-1",
        hasActiveSharedScene: false,
        hasActiveEmbeddedScene: false,
        isCollaborating: false,
        localScopeId: "local-document-1",
      }),
    ).toBe("owner:scene-1");
    expect(
      resolveAIVideoPersistenceContextToken({
        activeCloudSceneId: null,
        hasActiveSharedScene: false,
        hasActiveEmbeddedScene: false,
        isCollaborating: false,
        localScopeId: "local-document-1",
      }),
    ).toBe("local:local-document-1");
  });

  it.each([
    {
      hasActiveSharedScene: true,
      hasActiveEmbeddedScene: false,
      isCollaborating: false,
    },
    {
      hasActiveSharedScene: false,
      hasActiveEmbeddedScene: true,
      isCollaborating: false,
    },
    {
      hasActiveSharedScene: false,
      hasActiveEmbeddedScene: false,
      isCollaborating: true,
    },
  ])("fails closed for non-owner access contexts", (access) => {
    expect(
      resolveAIVideoPersistenceContextToken({
        activeCloudSceneId: "scene-1",
        localScopeId: "local-document-1",
        ...access,
      }),
    ).toBeNull();
  });

  it("aborts when the context changes or the caller aborts", () => {
    expect(() =>
      assertAIVideoPersistenceContext("owner:scene-1", "owner:scene-2"),
    ).toThrowError(expect.objectContaining({ name: "AbortError" }));

    const controller = new AbortController();
    controller.abort();
    expect(() =>
      assertAIVideoPersistenceContext(
        "local:document-1",
        "local:document-1",
        controller.signal,
      ),
    ).toThrowError(expect.objectContaining({ name: "AbortError" }));
  });
});
