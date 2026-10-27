/**
 * React access to the page's account settings sync engine (ADR 0038).
 *
 * `useAccountSettingsSyncDriver` is mounted once by the app and feeds the
 * engine the signed-in user; panels read the state with
 * `useAccountSettingsSync`.
 */

import { useEffect, useSyncExternalStore } from "react";

import { useCloudAuth } from "../auth/useCloudAuth";
import { getCloudBackend } from "../data/cloud";

import { createAccountSyncEngine } from "./accountSyncEngine";

import type { AccountSyncEngine } from "./accountSyncEngine";

let engine: AccountSyncEngine | null = null;

export const getAccountSyncEngine = (): AccountSyncEngine => {
  if (!engine) {
    const backend = getCloudBackend();
    engine = createAccountSyncEngine({
      service: backend.capabilities.accountSettingsSync
        ? backend.accountSettings ?? null
        : null,
    });
  }
  return engine;
};

/** Test-only. */
export const __resetAccountSyncEngineForTests = () => {
  engine?.dispose();
  engine = null;
};

export const isAccountSettingsSyncAvailable = () =>
  !!getCloudBackend().capabilities.accountSettingsSync;

export const useAccountSettingsSync = () => {
  const current = getAccountSyncEngine();
  const view = useSyncExternalStore(current.subscribe, current.getView);
  return { engine: current, view };
};

export const useAccountSettingsSyncDriver = () => {
  const { status, user } = useCloudAuth();
  const userId = status === "signed-in" ? user?.id ?? null : null;
  useEffect(() => {
    if (status !== "loading") {
      getAccountSyncEngine().setUser(userId);
    }
  }, [status, userId]);
};
