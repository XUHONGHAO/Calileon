/**
 * useCloudAuth — single source of truth for cloud auth state (Phase 1).
 *
 * Layout-agnostic on purpose: any UI (a menu item, a toolbar button, a
 * standalone panel) reads this hook; none of them own the auth state. State
 * lives in a jotai atom on `appJotaiStore` so every consumer stays in sync and
 * the subscription to the backend is established once.
 *
 * The hook talks only to the frozen `CloudBackend` contract via
 * `getCloudBackend()` — never to Supabase directly. In pure-local mode
 * (`capabilities.auth === false`) it reports `isAuthAvailable: false` and the
 * UI hides every entry point (decision 0008 §5 degrade).
 */

import { useCallback, useEffect } from "react";

import { atom, useAtom, useAtomValue, appJotaiStore } from "../app-jotai";
import { getCloudBackend } from "../data/cloud";

import type { AuthUser, BackendError } from "../data/cloud";

export type CloudAuthStatus = "loading" | "signed-in" | "signed-out";

interface CloudAuthState {
  status: CloudAuthStatus;
  user: AuthUser | null;
}

const cloudAuthAtom = atom<CloudAuthState>({
  status: "loading",
  user: null,
});

// Module-level guard so the backend subscription is wired exactly once,
// regardless of how many components mount the hook.
let _subscribed = false;

const initCloudAuthSubscription = () => {
  if (_subscribed) {
    return;
  }
  _subscribed = true;

  const backend = getCloudBackend();

  if (!backend.capabilities.auth) {
    // Pure-local: settle immediately as signed-out, no backend calls.
    appJotaiStore.set(cloudAuthAtom, { status: "signed-out", user: null });
    return;
  }

  // Hydrate from any persisted session, then keep in sync via the listener.
  backend.auth
    .getCurrentUser()
    .then((user) => {
      appJotaiStore.set(cloudAuthAtom, {
        status: user ? "signed-in" : "signed-out",
        user,
      });
    })
    .catch(() => {
      appJotaiStore.set(cloudAuthAtom, { status: "signed-out", user: null });
    });

  backend.auth.onAuthStateChange((user) => {
    appJotaiStore.set(cloudAuthAtom, {
      status: user ? "signed-in" : "signed-out",
      user,
    });
  });
};

export const useCloudAuth = () => {
  const [state] = useAtom(cloudAuthAtom);

  useEffect(() => {
    initCloudAuthSubscription();
  }, []);

  const backend = getCloudBackend();
  const isAuthAvailable = backend.capabilities.auth;

  const signIn = useCallback(
    async (email: string, password: string): Promise<void> => {
      // Throws BackendError on failure — callers surface `.message` (sanitized).
      const user = await backend.auth.signIn({
        kind: "password",
        email,
        password,
      });
      appJotaiStore.set(cloudAuthAtom, { status: "signed-in", user });
    },
    [backend],
  );

  const signOut = useCallback(async (): Promise<void> => {
    await backend.auth.signOut();
    appJotaiStore.set(cloudAuthAtom, { status: "signed-out", user: null });
  }, [backend]);

  return {
    isAuthAvailable,
    status: state.status,
    user: state.user,
    isSignedIn: state.status === "signed-in",
    signIn,
    signOut,
  };
};

/** Read current auth state without subscribing (e.g. outside React). */
export const getCloudAuthSnapshot = (): CloudAuthState =>
  appJotaiStore.get(cloudAuthAtom);

/** Test-only: reset the module subscription guard + atom. */
export const __resetCloudAuthForTests = () => {
  _subscribed = false;
  appJotaiStore.set(cloudAuthAtom, { status: "loading", user: null });
};

// Re-export for consumers that want the read-only atom value hook.
export { useAtomValue };
export type { BackendError };
