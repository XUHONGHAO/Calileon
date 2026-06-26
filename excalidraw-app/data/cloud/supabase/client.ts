/**
 * Supabase client singleton (decision 0008 §4).
 *
 * The platform SDK (`@supabase/supabase-js`) is imported ONLY inside this
 * `data/cloud/supabase/` directory (decision 0001 / 0006 §8). Upper layers
 * reach Supabase exclusively through the frozen `CloudBackend` contract.
 *
 * Config comes from the deployer at build/runtime via env vars (decision 0003);
 * no developer credentials are baked in. The `anon` key is designed to be
 * public (protected by RLS, decision 0004) — it is safe in the browser bundle.
 */

import { createClient } from "@supabase/supabase-js";

import type { SupabaseClient } from "@supabase/supabase-js";

const hasEnv = (value: string | undefined): boolean =>
  typeof value === "string" && value.trim().length > 0;

/**
 * True when both Supabase env vars are present. Capability detection and the
 * backend assembly switch both key off this (decision 0008 §1.3).
 */
export const hasSupabaseConfig = (): boolean =>
  hasEnv(import.meta.env.VITE_APP_SUPABASE_URL) &&
  hasEnv(import.meta.env.VITE_APP_SUPABASE_ANON_KEY);

let _client: SupabaseClient | null = null;

/**
 * Returns the lazily-created Supabase client singleton.
 *
 * Throws if called without Supabase configured — callers must gate on
 * `hasSupabaseConfig()` (or the derived `capabilities.sceneStorage`/`.auth`)
 * first. The frozen contract never routes to Supabase adapters when unconfigured
 * (decision 0008 §1.3: unconfigured stays pure-local), so this throw is a guard
 * against a wiring bug, not a user-facing path.
 */
export const getSupabaseClient = (): SupabaseClient => {
  if (!_client) {
    const url = import.meta.env.VITE_APP_SUPABASE_URL;
    const anonKey = import.meta.env.VITE_APP_SUPABASE_ANON_KEY;
    if (!hasEnv(url) || !hasEnv(anonKey)) {
      throw new Error(
        "getSupabaseClient() called without VITE_APP_SUPABASE_URL / " +
          "VITE_APP_SUPABASE_ANON_KEY configured",
      );
    }
    _client = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  }
  return _client;
};

/** Test-only: reset the singleton between tests. */
export const __resetSupabaseClientForTests = (): void => {
  _client = null;
};
