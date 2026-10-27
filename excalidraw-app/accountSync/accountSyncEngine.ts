/**
 * Account AI settings sync engine (ADR 0038 §4).
 *
 * One engine per page, driven by the signed-in user. Per account the device
 * remembers the derived key, the account row's KDF parameters, the revision it
 * last synced and a hash of every section as of that sync (the merge base).
 *
 * A sync reads the account row, decrypts it and merges section by section:
 * a section only the account changed is applied here, one only this device
 * changed is uploaded, and when both changed this device wins (it holds the
 * newest edit the user made here). Uploads are optimistic on `revision`; a
 * concurrent write from another device makes the whole sync start over.
 *
 * The first unlock on a device is different: there is no merge base, so when
 * both sides hold different non-empty settings the user picks which to keep.
 */

import { STORAGE_KEYS } from "../app_constants";
import { BackendError } from "../data/cloud/errors";

import {
  AI_AGENT_CONFIG_UPDATED_EVENT,
  AI_IMAGE_CONFIG_UPDATED_EVENT,
  AI_PROMPT_TEMPLATES_UPDATED_EVENT,
  AI_PROXY_CONFIG_UPDATED_EVENT,
  AI_SETTINGS_SECTIONS,
  AI_SETTINGS_STORAGE_KEYS,
  hashSection,
  hashSections,
  isSectionEmpty,
  normalizeSection,
  readLocalSections,
  writeLocalSection,
} from "./aiSettingsBundle";
import {
  DEFAULT_KDF_ITERATIONS,
  MIN_PASSPHRASE_LENGTH,
  SettingsCryptoError,
  createKdf,
  decryptSettings,
  deriveSettingsKey,
  encryptSettings,
  isSameKdf,
} from "./settingsCrypto";

import type {
  AISettingsBundle,
  AISettingsSection,
  AISettingsSections,
  SectionHashes,
} from "./aiSettingsBundle";
import type {
  AccountSettingsKdf,
  AccountSettingsRecord,
  AccountSettingsService,
} from "../data/cloud/types";

// —— device store ——————————————————————————————————————————————————————————

export interface DeviceSyncEntry {
  /** base64 raw AES key derived from the passphrase */
  key: string;
  kdf: AccountSettingsKdf;
  revision: number;
  /** section hashes as of the last sync */
  base: SectionHashes;
  syncedAt: number;
}

interface DeviceSyncStore {
  version: 1;
  accounts: Record<string, DeviceSyncEntry>;
}

const STORE_KEY = STORAGE_KEYS.LOCAL_STORAGE_ACCOUNT_SETTINGS_SYNC;

const isEntry = (value: unknown): value is DeviceSyncEntry => {
  const entry = value as DeviceSyncEntry | null;
  return (
    !!entry &&
    typeof entry.key === "string" &&
    !!entry.kdf &&
    typeof entry.kdf.salt === "string" &&
    Number.isInteger(entry.revision) &&
    !!entry.base &&
    AI_SETTINGS_SECTIONS.every(
      (section) => typeof entry.base[section] === "string",
    ) &&
    typeof entry.syncedAt === "number"
  );
};

const readStore = (): DeviceSyncStore => {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (parsed?.version === 1 && parsed.accounts) {
      return parsed;
    }
  } catch {}
  return { version: 1, accounts: {} };
};

export const readDeviceSyncEntry = (userId: string): DeviceSyncEntry | null => {
  const entry = readStore().accounts[userId];
  return isEntry(entry) ? entry : null;
};

const writeEntry = (userId: string, entry: DeviceSyncEntry | null) => {
  const store = readStore();
  if (entry) {
    store.accounts[userId] = entry;
  } else {
    delete store.accounts[userId];
  }
  localStorage.setItem(STORE_KEY, JSON.stringify(store));
};

// —— public types ——————————————————————————————————————————————————————————

export type AccountSyncErrorCode =
  | SettingsCryptoError["code"]
  | "passphrase-too-short"
  | "unsupported-format"
  | "remote-missing"
  | "remote-exists"
  | "backend";

export interface AccountSyncFailure {
  code: AccountSyncErrorCode;
  /** already localised (BackendError messages) */
  message?: string;
}

export class AccountSyncError extends Error {
  constructor(public readonly code: AccountSyncErrorCode) {
    super(code);
    this.name = "AccountSyncError";
  }
}

export const toAccountSyncFailure = (error: unknown): AccountSyncFailure => {
  if (
    error instanceof AccountSyncError ||
    error instanceof SettingsCryptoError
  ) {
    return { code: error.code };
  }
  if (error instanceof BackendError) {
    return { code: "backend", message: error.message };
  }
  return { code: "backend" };
};

/** Why sync turned off by itself, shown once in the panel. */
export type AccountSyncNotice = "remote-removed" | "passphrase-changed";

export type AccountSyncView =
  | { status: "unavailable" }
  | { status: "loading" }
  | { status: "error"; error: AccountSyncFailure }
  | { status: "off"; remote: boolean; notice?: AccountSyncNotice }
  | { status: "conflict"; sections: AISettingsSection[] }
  | {
      status: "on";
      syncedAt: number;
      activity: "idle" | "syncing";
      error?: AccountSyncFailure;
    };

export type ConflictWinner = "account" | "device";

// —— engine ————————————————————————————————————————————————————————————————

interface RemoteView {
  record: AccountSettingsRecord;
  /** sections this device can use */
  sections: Partial<AISettingsSections>;
  /** every section as stored, usable or not, for re-upload */
  raw: Partial<Record<AISettingsSection, unknown>>;
  hashes: Partial<SectionHashes>;
}

type Pick = "local" | "remote";

const isConflict = (error: unknown) =>
  error instanceof BackendError && error.code === "conflict";

const MAX_ATTEMPTS = 3;
/** Focus / visibility re-checks at most this often. */
const RECHECK_INTERVAL_MS = 30_000;

export interface AccountSyncEngineOptions {
  service: AccountSettingsService | null;
  debounceMs?: number;
  kdfIterations?: number;
  now?: () => number;
}

export const createAccountSyncEngine = ({
  service,
  debounceMs = 1500,
  kdfIterations = DEFAULT_KDF_ITERATIONS,
  now = Date.now,
}: AccountSyncEngineOptions) => {
  let userId: string | null = null;
  let view: AccountSyncView = { status: "unavailable" };
  const listeners = new Set<() => void>();
  // bumps whenever the user changes; async work from before is dropped
  let generation = 0;
  // true while this engine writes settings, so its own events don't re-sync
  let applying = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let rerun = false;
  let lastRunAt = 0;
  let attached = false;
  let pending: {
    userId: string;
    key: string;
    kdf: AccountSettingsKdf;
  } | null = null;

  const setView = (next: AccountSyncView) => {
    view = next;
    listeners.forEach((listener) => listener());
  };

  const decodeRemote = async (
    record: AccountSettingsRecord,
    key: string,
    uid: string,
  ): Promise<RemoteView> => {
    const plaintext = (await decryptSettings(
      record,
      key,
      uid,
    )) as Partial<AISettingsBundle> | null;
    if (
      !plaintext ||
      plaintext.version !== 1 ||
      !plaintext.sections ||
      typeof plaintext.sections !== "object"
    ) {
      throw new AccountSyncError("unsupported-format");
    }
    const remote: RemoteView = { record, sections: {}, raw: {}, hashes: {} };
    for (const section of AI_SETTINGS_SECTIONS) {
      if (!(section in plaintext.sections)) {
        continue;
      }
      const value = plaintext.sections[section];
      remote.raw[section] = value;
      try {
        const normalized = normalizeSection(section, value);
        (remote.sections as any)[section] = normalized;
        remote.hashes[section] = await hashSection(normalized);
      } catch {
        // rejected here (e.g. a localhost proxy in a production build):
        // keep it for the account, keep this device's own value
      }
    }
    return remote;
  };

  /**
   * Builds the merged settings from per-section picks, uploads them when the
   * account copy differs, then applies the account's sections locally.
   * Returns the new merge base.
   */
  const commit = async ({
    uid,
    gen,
    key,
    kdf,
    local,
    localHashes,
    remote,
    choose,
  }: {
    uid: string;
    gen: number;
    key: string;
    kdf: AccountSettingsKdf;
    local: AISettingsSections;
    localHashes: SectionHashes;
    remote: RemoteView | null;
    choose: (section: AISettingsSection) => Pick;
  }): Promise<{ revision: number; base: SectionHashes } | null> => {
    const upload: Partial<Record<AISettingsSection, unknown>> = {};
    const base = { ...localHashes };
    const toApply: AISettingsSection[] = [];
    let needsUpload = !remote;

    for (const section of AI_SETTINGS_SECTIONS) {
      const pick = choose(section);
      const remoteValue = remote?.sections[section];
      if (pick === "remote" && remoteValue !== undefined) {
        upload[section] = remote!.raw[section];
        base[section] = remote!.hashes[section]!;
        if (base[section] !== localHashes[section]) {
          toApply.push(section);
        }
      } else if (pick === "remote" && remote?.raw[section] !== undefined) {
        // unusable here: preserve the account's copy, keep using ours
        upload[section] = remote.raw[section];
      } else {
        upload[section] = local[section];
        if (remote?.hashes[section] !== localHashes[section]) {
          needsUpload = true;
        }
      }
    }

    let revision = remote?.record.revision ?? 0;
    if (needsUpload) {
      const bundle: AISettingsBundle = { version: 1, sections: upload };
      const write = await encryptSettings(bundle, key, kdf, uid);
      if (gen !== generation) {
        return null;
      }
      const saved = await service!.put(write, remote?.record.revision ?? null);
      revision = saved.revision;
    }
    if (gen !== generation) {
      return null;
    }

    applying = true;
    try {
      for (const section of toApply) {
        writeLocalSection(section, remote!.sections[section] as never);
      }
    } finally {
      applying = false;
    }
    return { revision, base };
  };

  const finish = (
    uid: string,
    entry: Omit<DeviceSyncEntry, "syncedAt">,
  ): DeviceSyncEntry => {
    const saved = { ...entry, syncedAt: now() };
    writeEntry(uid, saved);
    return saved;
  };

  /** Turns sync off on this device because the account side changed. */
  const dropEntry = (
    uid: string,
    notice: AccountSyncNotice,
    remote: boolean,
  ) => {
    writeEntry(uid, null);
    setView({ status: "off", remote, notice });
  };

  const runSync = async (gen: number): Promise<number | null> => {
    const uid = userId;
    if (!service || !uid) {
      return null;
    }
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const entry = readDeviceSyncEntry(uid);
      if (!entry) {
        return null;
      }
      const record = await service.get();
      if (gen !== generation) {
        return null;
      }
      if (!record) {
        dropEntry(uid, "remote-removed", false);
        return null;
      }
      if (!isSameKdf(record.kdf, entry.kdf)) {
        dropEntry(uid, "passphrase-changed", true);
        return null;
      }

      const local = readLocalSections();
      const localHashes = await hashSections(local);
      const localChanged = (section: AISettingsSection) =>
        localHashes[section] !== entry.base[section];
      if (
        record.revision === entry.revision &&
        !AI_SETTINGS_SECTIONS.some(localChanged)
      ) {
        // nothing new on either side; don't touch the store (other tabs
        // would see a storage event for every no-op)
        return entry.syncedAt;
      }

      const remote = await decodeRemote(record, entry.key, uid);
      try {
        const result = await commit({
          uid,
          gen,
          key: entry.key,
          kdf: entry.kdf,
          local,
          localHashes,
          remote,
          choose: (section) => {
            if (remote.raw[section] === undefined) {
              return "local";
            }
            if (remote.hashes[section] === undefined) {
              return localChanged(section) ? "local" : "remote";
            }
            const remoteChanged =
              remote.hashes[section] !== entry.base[section];
            return remoteChanged && !localChanged(section) ? "remote" : "local";
          },
        });
        if (!result) {
          return null;
        }
        return finish(uid, { ...entry, ...result }).syncedAt;
      } catch (error) {
        if (!isConflict(error) || attempt === MAX_ATTEMPTS - 1) {
          throw error;
        }
      }
    }
    return null;
  };

  const run = (): Promise<void> => {
    if (running) {
      rerun = true;
      return running;
    }
    const gen = generation;
    running = (async () => {
      do {
        rerun = false;
        lastRunAt = now();
        if (view.status === "on") {
          setView({ ...view, activity: "syncing" });
        }
        try {
          const syncedAt = await runSync(gen);
          if (gen === generation && view.status === "on") {
            setView({
              status: "on",
              syncedAt: syncedAt ?? view.syncedAt,
              activity: "idle",
            });
          }
        } catch (error) {
          if (gen === generation && view.status === "on") {
            setView({
              ...view,
              activity: "idle",
              error: toAccountSyncFailure(error),
            });
          }
        }
      } while (rerun && gen === generation);
    })().finally(() => {
      running = null;
    });
    return running;
  };

  const schedule = (delay = debounceMs) => {
    if (view.status !== "on") {
      return;
    }
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delay);
  };

  const recheck = () => {
    if (
      view.status === "on" &&
      document.visibilityState !== "hidden" &&
      now() - lastRunAt >= RECHECK_INTERVAL_MS
    ) {
      schedule(0);
    }
  };

  const onLocalChange = () => {
    if (!applying) {
      schedule();
    }
  };

  const onStorage = (event: StorageEvent) => {
    if (event.key === STORE_KEY) {
      // another tab turned sync on or off for this account
      const hasEntry = !!(userId && readDeviceSyncEntry(userId));
      if (hasEntry !== (view.status === "on")) {
        void refresh();
      }
    } else if (event.key && AI_SETTINGS_STORAGE_KEYS.includes(event.key)) {
      onLocalChange();
    }
  };

  const LOCAL_EVENTS = [
    AI_IMAGE_CONFIG_UPDATED_EVENT,
    AI_AGENT_CONFIG_UPDATED_EVENT,
    AI_PROMPT_TEMPLATES_UPDATED_EVENT,
    AI_PROXY_CONFIG_UPDATED_EVENT,
  ];

  const attach = () => {
    if (attached) {
      return;
    }
    attached = true;
    LOCAL_EVENTS.forEach((name) =>
      window.addEventListener(name, onLocalChange),
    );
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", recheck);
    window.addEventListener("online", recheck);
    document.addEventListener("visibilitychange", recheck);
  };

  const detach = () => {
    if (!attached) {
      return;
    }
    attached = false;
    LOCAL_EVENTS.forEach((name) =>
      window.removeEventListener(name, onLocalChange),
    );
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("focus", recheck);
    window.removeEventListener("online", recheck);
    document.removeEventListener("visibilitychange", recheck);
  };

  const requireReady = () => {
    if (!service || !userId) {
      throw new AccountSyncError("remote-missing");
    }
    return { uid: userId, gen: generation };
  };

  const goOn = (entry: DeviceSyncEntry) => {
    pending = null;
    setView({ status: "on", syncedAt: entry.syncedAt, activity: "idle" });
  };

  /** Re-reads the account row and settles the view. */
  const refresh = async (): Promise<void> => {
    if (!service || !userId) {
      setView({ status: "unavailable" });
      return;
    }
    const { uid, gen } = { uid: userId, gen: generation };
    // only the first check shows "loading"; re-checks keep what's on screen
    if (view.status === "unavailable") {
      setView({ status: "loading" });
    }
    try {
      const record = await service.get();
      if (gen !== generation) {
        return;
      }
      const entry = readDeviceSyncEntry(uid);
      if (!entry) {
        setView({ status: "off", remote: !!record });
        return;
      }
      if (!record) {
        dropEntry(uid, "remote-removed", false);
        return;
      }
      if (!isSameKdf(record.kdf, entry.kdf)) {
        dropEntry(uid, "passphrase-changed", true);
        return;
      }
      goOn(entry);
      void run();
    } catch (error) {
      if (gen !== generation) {
        return;
      }
      // while on, a failed check is a sync error, not a reason to hide it
      setView(
        view.status === "on"
          ? { ...view, activity: "idle", error: toAccountSyncFailure(error) }
          : { status: "error", error: toAccountSyncFailure(error) },
      );
    }
  };

  /** Creates the account copy from this device's settings. */
  const enable = async (passphrase: string): Promise<void> => {
    const { uid, gen } = requireReady();
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      throw new AccountSyncError("passphrase-too-short");
    }
    if (await service!.get()) {
      setView({ status: "off", remote: true });
      throw new AccountSyncError("remote-exists");
    }
    const kdf = createKdf(kdfIterations);
    const key = await deriveSettingsKey(passphrase, kdf);
    const local = readLocalSections();
    const localHashes = await hashSections(local);
    let result;
    try {
      result = await commit({
        uid,
        gen,
        key,
        kdf,
        local,
        localHashes,
        remote: null,
        choose: () => "local",
      });
    } catch (error) {
      if (isConflict(error)) {
        // another device created it in the meantime
        setView({ status: "off", remote: true });
        throw new AccountSyncError("remote-exists");
      }
      throw error;
    }
    if (result) {
      goOn(finish(uid, { key, kdf, ...result }));
    }
  };

  /**
   * Merges the account copy into this device. Sections only one side has are
   * taken as they are; returns "conflict" when both sides differ and the
   * user has to pick (then call `resolveConflict`).
   */
  const finishUnlock = async (
    uid: string,
    gen: number,
    key: string,
    winner: ConflictWinner | null,
  ): Promise<"done" | "conflict"> => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const record = await service!.get();
      if (gen !== generation) {
        return "done";
      }
      if (!record) {
        setView({ status: "off", remote: false });
        throw new AccountSyncError("remote-missing");
      }
      const remote = await decodeRemote(record, key, uid);
      const local = readLocalSections();
      const localHashes = await hashSections(local);
      const conflicts = AI_SETTINGS_SECTIONS.filter((section) => {
        const remoteValue = remote.sections[section];
        return (
          remoteValue !== undefined &&
          remote.hashes[section] !== localHashes[section] &&
          !isSectionEmpty(section, local[section]) &&
          !isSectionEmpty(section, remoteValue)
        );
      });
      if (conflicts.length && !winner) {
        pending = { userId: uid, key, kdf: record.kdf };
        setView({ status: "conflict", sections: conflicts });
        return "conflict";
      }
      try {
        const result = await commit({
          uid,
          gen,
          key,
          kdf: record.kdf,
          local,
          localHashes,
          remote,
          choose: (section) => {
            const remoteValue = remote.sections[section];
            if (remote.raw[section] === undefined) {
              return "local";
            }
            if (remoteValue === undefined) {
              return "remote";
            }
            if (isSectionEmpty(section, local[section])) {
              return "remote";
            }
            if (isSectionEmpty(section, remoteValue)) {
              return "local";
            }
            return conflicts.includes(section) && winner === "device"
              ? "local"
              : "remote";
          },
        });
        if (result) {
          goOn(finish(uid, { key, kdf: record.kdf, ...result }));
        }
        return "done";
      } catch (error) {
        if (!isConflict(error) || attempt === MAX_ATTEMPTS - 1) {
          throw error;
        }
      }
    }
    return "done";
  };

  const unlock = async (passphrase: string): Promise<"done" | "conflict"> => {
    const { uid, gen } = requireReady();
    const record = await service!.get();
    if (!record) {
      setView({ status: "off", remote: false });
      throw new AccountSyncError("remote-missing");
    }
    const key = await deriveSettingsKey(passphrase, record.kdf);
    // fails with wrong-passphrase before anything is written
    await decryptSettings(record, key, uid);
    if (gen !== generation) {
      return "done";
    }
    return finishUnlock(uid, gen, key, null);
  };

  const resolveConflict = async (winner: ConflictWinner): Promise<void> => {
    if (!pending || pending.userId !== userId) {
      throw new AccountSyncError("remote-missing");
    }
    await finishUnlock(pending.userId, generation, pending.key, winner);
  };

  const cancelConflict = () => {
    pending = null;
    setView({ status: "off", remote: true });
  };

  /** Drops queued and in-flight sync work (it must not write afterwards). */
  const cancelWork = () => {
    generation++;
    pending = null;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  /** Stops syncing on this device; the account copy stays for other devices. */
  const turnOff = () => {
    if (!userId) {
      return;
    }
    cancelWork();
    writeEntry(userId, null);
    setView({ status: "off", remote: true });
  };

  /** Deletes the account copy (also how a forgotten passphrase starts over). */
  const deleteRemote = async (): Promise<void> => {
    const { uid } = requireReady();
    cancelWork();
    const gen = generation;
    // let an upload already on the wire land first, so the delete is last
    await running?.catch(() => {});
    await service!.remove();
    if (gen !== generation) {
      return;
    }
    writeEntry(uid, null);
    setView({ status: "off", remote: false });
  };

  const syncNow = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    return view.status === "on" ? run() : refresh();
  };

  const setUser = (next: string | null) => {
    if (next === userId) {
      return;
    }
    cancelWork();
    userId = next;
    if (!next || !service) {
      detach();
      setView({ status: "unavailable" });
      return;
    }
    attach();
    // never show the previous account's state while the new one loads
    setView({ status: "loading" });
    void refresh();
  };

  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getView: () => view,
    setUser,
    refresh,
    enable,
    unlock,
    resolveConflict,
    cancelConflict,
    turnOff,
    deleteRemote,
    syncNow,
    /** settles pending work (tests) */
    flush: async () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
        await run();
      }
      await running;
    },
    dispose: () => {
      generation++;
      detach();
      if (timer) {
        clearTimeout(timer);
      }
      listeners.clear();
    },
  };
};

export type AccountSyncEngine = ReturnType<typeof createAccountSyncEngine>;
