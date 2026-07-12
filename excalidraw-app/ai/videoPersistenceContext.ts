export type AIVideoPersistenceContextInput = {
  activeCloudSceneId: string | null;
  hasActiveSharedScene: boolean;
  hasActiveEmbeddedScene: boolean;
  isCollaborating: boolean;
  localScopeId: string | null;
};

export const resolveAIVideoPersistenceContextToken = ({
  activeCloudSceneId,
  hasActiveSharedScene,
  hasActiveEmbeddedScene,
  isCollaborating,
  localScopeId,
}: AIVideoPersistenceContextInput): string | null => {
  if (hasActiveSharedScene || hasActiveEmbeddedScene || isCollaborating) {
    return null;
  }

  if (activeCloudSceneId) {
    return `owner:${activeCloudSceneId}`;
  }

  return localScopeId ? `local:${localScopeId}` : null;
};

export const assertAIVideoPersistenceContext = (
  expectedToken: string,
  currentToken: string | null,
  signal?: AbortSignal,
) => {
  if (signal?.aborted || currentToken !== expectedToken) {
    throw new DOMException(
      "AI video persistence context changed.",
      "AbortError",
    );
  }
};
