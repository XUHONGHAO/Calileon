/**
 * SupabaseAuthProvider — frozen `AuthProvider` over Supabase Auth
 * (decision 0006 §4 / 0008 §4.1).
 *
 * First version implements **password sign-in only**. The frozen `SignInMethod`
 * union also carries `oauth` / `magic-link` shapes (reserved, 0006 §8); those
 * throw `not-configured` here until a later phase wires them.
 *
 * SDK is imported only inside this directory (decision 0001). Errors funnel
 * through `mapAuthError` into the frozen `BackendError` model.
 */

import { t } from "@excalidraw/excalidraw/i18n";

import { BackendError } from "../errors";

import { getSupabaseClient } from "./client";
import { mapAuthError } from "./errorMapping";

import type { AuthProvider, AuthUser, SignInMethod } from "../types";
import type { User } from "@supabase/supabase-js";

const toEpochMs = (value: string | null | undefined): number | null => {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/** Maps a Supabase `User` to the frozen `AuthUser` (decision 0006 §3). */
const toAuthUser = (user: User): AuthUser => {
  const metadata = (user.user_metadata ?? {}) as Record<string, unknown>;
  const displayName =
    (typeof metadata.full_name === "string" && metadata.full_name) ||
    (typeof metadata.name === "string" && metadata.name) ||
    (typeof metadata.display_name === "string" && metadata.display_name) ||
    null;
  const avatarUrl =
    (typeof metadata.avatar_url === "string" && metadata.avatar_url) || null;

  return {
    id: user.id,
    displayName,
    email: user.email ?? null,
    avatarUrl,
    createdAt: toEpochMs(user.created_at) ?? 0,
    lastSignInAt: toEpochMs(user.last_sign_in_at),
  };
};

export const createSupabaseAuthProvider = (): AuthProvider => {
  const getCurrentUser = async (): Promise<AuthUser | null> => {
    const client = getSupabaseClient();
    const { data, error } = await client.auth.getUser();
    if (error) {
      // No active session is not an error condition for "who am I" — report
      // signed-out rather than throwing (callers gate UI on null).
      if (error.status === 401 || error.status === 403) {
        return null;
      }
      throw mapAuthError(error);
    }
    return data.user ? toAuthUser(data.user) : null;
  };

  const signIn = async (method: SignInMethod): Promise<AuthUser> => {
    if (method.kind !== "password") {
      // oauth / magic-link signatures are frozen but not implemented yet.
      throw new BackendError(
        "not-configured",
        t("cloud.errors.authMethodUnavailable"),
        { recoverable: false },
      );
    }

    const client = getSupabaseClient();
    const { data, error } = await client.auth.signInWithPassword({
      email: method.email,
      password: method.password,
    });
    if (error) {
      throw mapAuthError(error);
    }
    if (!data.user) {
      throw mapAuthError(error);
    }
    return toAuthUser(data.user);
  };

  const signOut = async (): Promise<void> => {
    const client = getSupabaseClient();
    const { error } = await client.auth.signOut();
    if (error) {
      throw mapAuthError(error);
    }
  };

  const onAuthStateChange = (
    cb: (user: AuthUser | null) => void,
  ): (() => void) => {
    const client = getSupabaseClient();
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      cb(session?.user ? toAuthUser(session.user) : null);
    });
    return () => {
      data.subscription.unsubscribe();
    };
  };

  return { getCurrentUser, signIn, signOut, onAuthStateChange };
};
