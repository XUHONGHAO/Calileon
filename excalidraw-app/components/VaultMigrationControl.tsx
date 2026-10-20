import React from "react";

import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import Spinner from "@excalidraw/excalidraw/components/Spinner";
import { t } from "@excalidraw/excalidraw/i18n";

import { VaultError } from "../data/vault/errors";

import { Callout, DialogActions, UiButton } from "./ui";

import "./VaultMigrationControl.scss";

import type { VaultRole } from "../data/vault/types";

/**
 * P4c W4 entry in an open v1 Vault (only rendered with the v2 flag on).
 *
 * - Not migrated: editors get "Move to Vault v2"; the v1 Vault is never
 *   written, so the old link keeps working as the way back.
 * - Migrated on this device: the old Vault is shown read-only with a link to
 *   the new one. This is a prompt, not enforcement — the server does not mark
 *   v1 Vaults, and other holders of the old link can still edit it.
 */
export type VaultMigrationApi = {
  /** the committed new link on this device, or null */
  readMigratedLink: () => Promise<string | null>;
  migrate: () => Promise<string>;
  /** the old Vault became a pointer: switch it to read-only */
  onMigrated: () => void;
};

const migrationErrorMessage = (error: unknown) => {
  switch (error instanceof VaultError ? error.code : null) {
    case "VAULT_PROTOCOL_UNSUPPORTED":
      return t("vault.migration.errors.unsupported");
    case "VAULT_PAYLOAD_TOO_LARGE":
      return t("vault.migration.errors.tooLarge");
    case "VAULT_SNAPSHOT_CONFLICT":
      return t("vault.migration.errors.conflict");
    case "VAULT_CAPABILITY_FORBIDDEN":
      return t("vault.migration.errors.forbidden");
    case "VAULT_NOT_FOUND":
      return t("vault.migration.errors.imagesMissing");
    case "VAULT_ASSET_CONFLICT":
      return t("vault.migration.errors.assetConflict");
    default:
      return t("vault.migration.errors.failed");
  }
};

type State =
  | { kind: "checking" }
  | { kind: "idle" }
  | { kind: "confirm" }
  | { kind: "running" }
  | { kind: "error"; message: string }
  | { kind: "migrated"; link: string; justNow: boolean };

export const VaultMigrationControl = ({
  role,
  api,
}: {
  role: VaultRole;
  api: VaultMigrationApi;
}) => {
  const [state, setState] = React.useState<State>({ kind: "checking" });
  const apiRef = React.useRef(api);
  apiRef.current = api;

  React.useEffect(() => {
    let cancelled = false;
    apiRef.current
      .readMigratedLink()
      .then((link) => {
        if (cancelled) {
          return;
        }
        if (link) {
          setState({ kind: "migrated", link, justNow: false });
          apiRef.current.onMigrated();
        } else {
          setState({ kind: "idle" });
        }
      })
      .catch(() => {
        // no local journal (or unreadable): behave as not migrated
        if (!cancelled) {
          setState({ kind: "idle" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const migrate = async () => {
    setState({ kind: "running" });
    try {
      const link = await apiRef.current.migrate();
      setState({ kind: "migrated", link, justNow: true });
      apiRef.current.onMigrated();
    } catch (error) {
      setState({ kind: "error", message: migrationErrorMessage(error) });
    }
  };

  if (state.kind === "checking") {
    return null;
  }

  if (state.kind === "migrated") {
    return (
      <>
        <div
          className="VaultMigrationControl__banner UiStatusPill UiStatusPill--info"
          role="status"
          title={t("vault.migration.migratedNotice")}
          data-testid="vault-migration-banner"
        >
          <span className="UiStatusPill__mark" aria-hidden="true">
            <span className="UiStatusPill__dot" />
          </span>
          <span className="VaultMigrationControl__notice">
            {t("vault.migration.migratedNotice")}
          </span>
          <a href={state.link}>{t("vault.migration.openNew")}</a>
        </div>
        {state.justNow && (
          <Dialog
            title={t("vault.migration.doneTitle")}
            onCloseRequest={() => setState({ ...state, justNow: false })}
            size="small"
            closeOnClickOutside={false}
          >
            <div
              className="VaultMigrationControl"
              data-testid="vault-migration-done"
            >
              <Callout tone="success" live={false}>
                {t("vault.migration.doneDescription")}
              </Callout>
              <DialogActions>
                <UiButton
                  onClick={() => setState({ ...state, justNow: false })}
                >
                  {t("vault.migration.stay")}
                </UiButton>
                <UiButton
                  variant="primary"
                  onClick={() => window.location.assign(state.link)}
                >
                  {t("vault.migration.openNew")}
                </UiButton>
              </DialogActions>
            </div>
          </Dialog>
        )}
      </>
    );
  }

  if (role !== "editor") {
    return null;
  }

  const close = () => setState({ kind: "idle" });

  return (
    <>
      <UiButton
        className="VaultMigrationControl__trigger"
        onClick={() => setState({ kind: "confirm" })}
      >
        {t("vault.migration.start")}
      </UiButton>
      {state.kind !== "idle" && (
        <Dialog
          title={t("vault.migration.title")}
          onCloseRequest={state.kind === "running" ? () => {} : close}
          size="small"
          closeOnClickOutside={false}
        >
          <div className="VaultMigrationControl" data-testid="vault-migration">
            <p className="VaultMigrationControl__description">
              {t("vault.migration.description")}
            </p>
            <ul className="VaultMigrationControl__notes">
              <li>{t("vault.migration.noteOldKept")}</li>
              <li>{t("vault.migration.noteOthers")}</li>
              <li>{t("vault.migration.noteImages")}</li>
            </ul>
            {state.kind === "running" && (
              <div className="VaultMigrationControl__running" role="status">
                <Spinner />
                <span>{t("vault.migration.running")}</span>
              </div>
            )}
            {state.kind === "error" && (
              <Callout tone="danger">
                <span data-testid="vault-migration-error">{state.message}</span>
              </Callout>
            )}
            <DialogActions>
              <UiButton onClick={close} disabled={state.kind === "running"}>
                {t("vault.migration.cancel")}
              </UiButton>
              <UiButton
                variant="primary"
                onClick={migrate}
                loading={state.kind === "running"}
              >
                {state.kind === "error"
                  ? t("vault.migration.retry")
                  : t("vault.migration.confirm")}
              </UiButton>
            </DialogActions>
          </div>
        </Dialog>
      )}
    </>
  );
};
