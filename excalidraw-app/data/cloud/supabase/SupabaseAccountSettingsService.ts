/**
 * SupabaseAccountSettingsService - the account's encrypted AI settings row
 * (ADR 0038, schema_account_settings.sql).
 *
 * Moves ciphertext only: encryption and the passphrase live in
 * `excalidraw-app/accountSync`. Writes are optimistic: an update matches
 * `revision = expected` and a first insert relies on the primary key, so a
 * second device that wrote in between surfaces as `conflict`.
 */

import { t } from "@excalidraw/excalidraw/i18n";

import { BackendError } from "../errors";

import { getSupabaseClient } from "./client";
import { mapDataError } from "./errorMapping";

import type {
  AccountSettingsKdf,
  AccountSettingsRecord,
  AccountSettingsService,
  AccountSettingsWrite,
} from "../types";

const TABLE = "account_ai_settings";
const COLUMNS = "format_version,kdf,iv,ciphertext,revision,updated_at";
const PG_UNIQUE_VIOLATION = "23505";

export interface AccountSettingsRow {
  format_version: number;
  kdf: unknown;
  iv: string;
  ciphertext: string;
  revision: number | string;
  updated_at: string;
}

const isKdf = (value: unknown): value is AccountSettingsKdf =>
  !!value &&
  typeof value === "object" &&
  (value as AccountSettingsKdf).name === "PBKDF2" &&
  (value as AccountSettingsKdf).hash === "SHA-256" &&
  Number.isInteger((value as AccountSettingsKdf).iterations) &&
  typeof (value as AccountSettingsKdf).salt === "string";

export const rowToAccountSettingsRecord = (
  row: AccountSettingsRow,
): AccountSettingsRecord => {
  const revision = Number(row.revision);
  if (
    row.format_version !== 1 ||
    !isKdf(row.kdf) ||
    typeof row.iv !== "string" ||
    typeof row.ciphertext !== "string" ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    throw new BackendError(
      "conflict",
      t("accountSync.errors.unsupportedFormat"),
      { recoverable: false },
    );
  }
  return {
    formatVersion: 1,
    kdf: {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: row.kdf.iterations,
      salt: row.kdf.salt,
    },
    iv: row.iv,
    ciphertext: row.ciphertext,
    revision,
    updatedAt: Date.parse(row.updated_at) || 0,
  };
};

const conflict = () =>
  new BackendError("conflict", t("accountSync.errors.conflict"), {
    recoverable: true,
  });

const requireOwnerId = async (): Promise<string> => {
  const { data, error } = await getSupabaseClient().auth.getUser();
  if (error || !data.user) {
    throw new BackendError("unauthorized", t("cloud.errors.signInRequired"), {
      recoverable: true,
      nextAction: t("cloud.errors.nextActionSignIn"),
    });
  }
  return data.user.id;
};

export const createSupabaseAccountSettingsService =
  (): AccountSettingsService => {
    const get = async (): Promise<AccountSettingsRecord | null> => {
      const { data, error } = await getSupabaseClient()
        .from(TABLE)
        .select(COLUMNS)
        .maybeSingle();
      if (error) {
        throw mapDataError(error);
      }
      return data
        ? rowToAccountSettingsRecord(data as AccountSettingsRow)
        : null;
    };

    const put = async (
      record: AccountSettingsWrite,
      expectedRevision: number | null,
    ): Promise<AccountSettingsRecord> => {
      const ownerId = await requireOwnerId();
      const values = {
        format_version: record.formatVersion,
        kdf: record.kdf,
        iv: record.iv,
        ciphertext: record.ciphertext,
      };
      const client = getSupabaseClient();

      if (expectedRevision === null) {
        const { data, error } = await client
          .from(TABLE)
          .insert({ ...values, owner_id: ownerId, revision: 1 })
          .select(COLUMNS)
          .single();
        if (error?.code === PG_UNIQUE_VIOLATION) {
          throw conflict();
        }
        if (error || !data) {
          throw mapDataError(error);
        }
        return rowToAccountSettingsRecord(data as AccountSettingsRow);
      }

      const { data, error } = await client
        .from(TABLE)
        .update({ ...values, revision: expectedRevision + 1 })
        .eq("owner_id", ownerId)
        .eq("revision", expectedRevision)
        .select(COLUMNS)
        .maybeSingle();
      if (error) {
        throw mapDataError(error);
      }
      // no row: the revision moved on, or the row was deleted elsewhere
      if (!data) {
        throw conflict();
      }
      return rowToAccountSettingsRecord(data as AccountSettingsRow);
    };

    const remove = async (): Promise<void> => {
      const ownerId = await requireOwnerId();
      const { error } = await getSupabaseClient()
        .from(TABLE)
        .delete()
        .eq("owner_id", ownerId);
      if (error) {
        throw mapDataError(error);
      }
    };

    return { get, put, remove };
  };
