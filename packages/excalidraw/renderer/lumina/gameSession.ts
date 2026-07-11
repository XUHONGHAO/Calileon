import type { LuminaGameMode } from "@excalidraw/element/lumina";

export interface LuminaGameSessionSnapshot {
  discoveredIds: readonly string[];
  revealedIds: readonly string[];
  requiredIds: readonly string[];
  solved: boolean;
  revision: number;
}

interface MutableDarkRoomSession {
  persistentDiscoveredIds: Set<string>;
  snapshot: LuminaGameSessionSnapshot;
}

const EMPTY_SESSION: LuminaGameSessionSnapshot = Object.freeze({
  discoveredIds: Object.freeze([] as string[]),
  revealedIds: Object.freeze([] as string[]),
  requiredIds: Object.freeze([] as string[]),
  solved: false,
  revision: 0,
});

const sessions = new WeakMap<LuminaGameMode, MutableDarkRoomSession>();
const listeners = new Set<() => void>();

const sortedUnique = (ids: Iterable<string>): string[] =>
  Array.from(new Set(ids)).sort();

const arraysEqual = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length &&
  left.every((value, index) => value === right[index]);

const emit = () => {
  for (const listener of listeners) {
    listener();
  }
};

export const subscribeLuminaGameSession = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getLuminaGameSessionSnapshot = (
  mode: LuminaGameMode | null | undefined,
): LuminaGameSessionSnapshot => {
  if (mode?.style !== "dark-room" || mode.phase !== "play") {
    return EMPTY_SESSION;
  }
  return sessions.get(mode)?.snapshot ?? EMPTY_SESSION;
};

export const updateDarkRoomSession = (
  mode: LuminaGameMode,
  revealedIds: readonly string[],
  requiredIds: readonly string[],
  stickyRevealedIds: readonly string[] = revealedIds,
): LuminaGameSessionSnapshot => {
  if (mode.style !== "dark-room" || mode.phase !== "play") {
    return EMPTY_SESSION;
  }

  let session = sessions.get(mode);
  if (!session) {
    session = {
      persistentDiscoveredIds: new Set(),
      snapshot: EMPTY_SESSION,
    };
    sessions.set(mode, session);
  }
  for (const id of stickyRevealedIds) {
    session.persistentDiscoveredIds.add(id);
  }

  const normalizedRevealedIds = sortedUnique(revealedIds);
  const normalizedRequiredIds = sortedUnique(requiredIds);
  const discoveredIds = sortedUnique([
    ...session.persistentDiscoveredIds,
    ...normalizedRevealedIds,
  ]);
  const discoveredSet = new Set(discoveredIds);
  const solved =
    normalizedRequiredIds.length > 0 &&
    normalizedRequiredIds.every((id) => discoveredSet.has(id));
  const previous = session.snapshot;

  if (
    arraysEqual(previous.discoveredIds, discoveredIds) &&
    arraysEqual(previous.revealedIds, normalizedRevealedIds) &&
    arraysEqual(previous.requiredIds, normalizedRequiredIds) &&
    previous.solved === solved
  ) {
    return previous;
  }

  session.snapshot = {
    discoveredIds,
    revealedIds: normalizedRevealedIds,
    requiredIds: normalizedRequiredIds,
    solved,
    revision: previous.revision + 1,
  };
  emit();
  return session.snapshot;
};

export const clearLuminaGameSession = (
  mode: LuminaGameMode | null | undefined,
) => {
  if (mode && sessions.delete(mode)) {
    emit();
  }
};

export const EMPTY_LUMINA_GAME_SESSION = EMPTY_SESSION;
