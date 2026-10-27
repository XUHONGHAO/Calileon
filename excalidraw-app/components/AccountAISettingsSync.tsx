/**
 * "Save AI settings to my account" row in the account panel (ADR 0038).
 *
 * A switch plus a status line; turning it on opens an inline form: a new
 * passphrase when the account has no copy yet, the existing one otherwise.
 * The engine (accountSync/) owns all state, so closing the dialog mid-way is
 * harmless.
 */

import { brainIcon } from "@excalidraw/excalidraw/components/icons";
import { t } from "@excalidraw/excalidraw/i18n";
import clsx from "clsx";
import React, { useEffect, useId, useRef, useState } from "react";

import { toAccountSyncFailure } from "../accountSync/accountSyncEngine";
import { MIN_PASSPHRASE_LENGTH } from "../accountSync/settingsCrypto";
import {
  isAccountSettingsSyncAvailable,
  useAccountSettingsSync,
} from "../accountSync/useAccountSettingsSync";

import {
  ActionMenu,
  Callout,
  Field,
  TextInput,
  UiButton,
  confirmAction,
} from "./ui";

import type {
  AccountSyncFailure,
  AccountSyncView,
} from "../accountSync/accountSyncEngine";
import type { AISettingsSection } from "../accountSync/aiSettingsBundle";

const SECTION_LABEL_KEYS = {
  models: "accountSync.sectionModels",
  agents: "accountSync.sectionAgents",
  templates: "accountSync.sectionTemplates",
  network: "accountSync.sectionNetwork",
} as const;

export const getAccountSyncErrorMessage = (failure: AccountSyncFailure) => {
  switch (failure.code) {
    case "wrong-passphrase":
      return t("accountSync.errors.wrongPassphrase");
    case "passphrase-too-short":
      return t("accountSync.errors.passphraseTooShort");
    case "unsupported-format":
      return t("accountSync.errors.unsupportedFormat");
    case "unsupported-kdf":
      return t("accountSync.errors.unsupportedKdf");
    case "too-large":
      return t("accountSync.errors.tooLarge");
    case "insecure-context":
      return t("accountSync.errors.insecureContext");
    case "remote-missing":
      return t("accountSync.errors.remoteMissing");
    case "remote-exists":
      return t("accountSync.errors.remoteExists");
    default:
      return failure.message || t("accountSync.errors.generic");
  }
};

export const formatSyncedAt = (syncedAt: number, now = Date.now()) => {
  const diff = Math.max(0, now - syncedAt);
  if (diff < 60_000) {
    return t("accountSync.justNow");
  }
  if (diff < 3_600_000) {
    return t("accountSync.minutesAgo", { count: Math.floor(diff / 60_000) });
  }
  if (diff < 86_400_000) {
    return t("accountSync.hoursAgo", { count: Math.floor(diff / 3_600_000) });
  }
  return new Date(syncedAt).toLocaleDateString();
};

const formatSections = (sections: readonly AISettingsSection[]) =>
  sections
    .map((section) => t(SECTION_LABEL_KEYS[section]))
    .join(t("accountSync.sectionSeparator"));

const getStatusLine = (view: AccountSyncView, available: boolean) => {
  if (!available) {
    return t("accountSync.unavailable");
  }
  switch (view.status) {
    case "loading":
    case "unavailable":
      return t("accountSync.loading");
    case "error":
      return t("accountSync.checkFailed", {
        message: getAccountSyncErrorMessage(view.error),
      });
    case "off":
      return view.remote
        ? t("accountSync.offRemote")
        : t("accountSync.offEmpty");
    case "conflict":
      return t("accountSync.offRemote");
    case "on":
      if (view.activity === "syncing") {
        return t("accountSync.syncing");
      }
      if (view.error) {
        return t("accountSync.syncFailed", {
          message: getAccountSyncErrorMessage(view.error),
        });
      }
      return t("accountSync.syncedAt", { time: formatSyncedAt(view.syncedAt) });
  }
};

/** Accessible on/off switch; no app primitive exists yet. */
const Switch = ({
  checked,
  disabled,
  onChange,
  labelledBy,
  describedBy,
  buttonRef,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  labelledBy: string;
  describedBy?: string;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) => (
  <button
    ref={buttonRef}
    type="button"
    role="switch"
    aria-checked={checked}
    aria-labelledby={labelledBy}
    aria-describedby={describedBy}
    disabled={disabled}
    className={clsx("AccountSwitch", { "AccountSwitch--on": checked })}
    onClick={() => onChange(!checked)}
  >
    <span className="AccountSwitch__thumb" aria-hidden="true" />
  </button>
);

export const AccountAISettingsSync = () => {
  const available = isAccountSettingsSyncAvailable();
  const { engine, view } = useAccountSettingsSync();
  const [formOpen, setFormOpen] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const switchRef = useRef<HTMLButtonElement>(null);
  const refocusRef = useRef(false);
  const titleId = useId();
  const statusId = useId();
  const formId = useId();

  // a copy may have appeared or gone on another device since the page loaded
  useEffect(() => {
    if (available && (view.status === "off" || view.status === "error")) {
      void engine.refresh();
    }
    // only when the panel mounts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keeps "Synced 3 min ago" current while the panel is open
  useEffect(() => {
    if (view.status !== "on") {
      return;
    }
    const interval = window.setInterval(
      () => setTick((tick) => tick + 1),
      30_000,
    );
    return () => window.clearInterval(interval);
  }, [view.status]);

  // the form only makes sense while off; another tab may have finished it
  useEffect(() => {
    if (view.status !== "off") {
      setFormOpen(false);
    }
  }, [view.status]);

  const isSetup = view.status === "off" && !view.remote;
  const checked =
    view.status === "on" || view.status === "conflict" || formOpen;
  const switchDisabled =
    !available ||
    busy ||
    view.status === "loading" ||
    view.status === "unavailable" ||
    view.status === "error";

  const resetForm = () => {
    setPassphrase("");
    setConfirmation("");
    setFormError(null);
  };

  // The form and the conflict choice unmount the control that had focus;
  // put it back on the switch so the dialog keeps Escape and Tab. Done after
  // the render that re-enables the switch (a disabled button can't focus).
  const focusSwitch = () => {
    refocusRef.current = true;
  };
  useEffect(() => {
    const target = switchRef.current;
    if (refocusRef.current && target && !target.disabled) {
      refocusRef.current = false;
      target.focus();
    }
  });

  const onSwitch = (next: boolean) => {
    setActionError(null);
    if (next) {
      resetForm();
      setFormOpen(true);
      return;
    }
    if (formOpen) {
      setFormOpen(false);
      resetForm();
    } else if (view.status === "conflict") {
      engine.cancelConflict();
    } else if (view.status === "on") {
      engine.turnOff();
    }
    focusSwitch();
  };

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) {
      return;
    }
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      setFormError(t("accountSync.errors.passphraseTooShort"));
      return;
    }
    if (isSetup && passphrase !== confirmation) {
      setFormError(t("accountSync.mismatch"));
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      if (isSetup) {
        await engine.enable(passphrase);
      } else {
        await engine.unlock(passphrase);
      }
      setFormOpen(false);
      resetForm();
      focusSwitch();
    } catch (error) {
      setFormError(getAccountSyncErrorMessage(toAccountSyncFailure(error)));
      setConfirmation("");
    } finally {
      setBusy(false);
    }
  };

  const runAction = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      focusSwitch();
    } catch (error) {
      setActionError(getAccountSyncErrorMessage(toAccountSyncFailure(error)));
    } finally {
      setBusy(false);
    }
  };

  const onForgot = async () => {
    if (
      await confirmAction(t("accountSync.forgotConfirm"), {
        title: t("accountSync.forgotConfirmTitle"),
        confirmLabel: t("accountSync.deleteRemote"),
        danger: true,
      })
    ) {
      await runAction(async () => {
        await engine.deleteRemote();
        resetForm();
        setFormOpen(true);
      });
    }
  };

  const onDeleteRemote = async () => {
    if (
      await confirmAction(t("accountSync.deleteRemoteConfirm"), {
        title: t("accountSync.deleteRemoteConfirmTitle"),
        confirmLabel: t("accountSync.deleteRemote"),
        danger: true,
      })
    ) {
      await runAction(() => engine.deleteRemote());
    }
  };

  const statusError =
    (view.status === "on" && !!view.error && view.activity === "idle") ||
    view.status === "error";

  return (
    <div className="AccountSettingRow AccountAISettingsSync">
      <div className="AccountSettingRow__main">
        <span
          className="AccountSettingRow__leading AccountSettingRow__icon"
          aria-hidden="true"
        >
          {brainIcon}
        </span>
        <div className="AccountSettingRow__text">
          <span className="AccountSettingRow__title" id={titleId}>
            {t("accountSync.title")}
          </span>
          <span
            className={clsx("AccountSettingRow__meta", {
              "AccountSettingRow__meta--error": statusError,
            })}
            id={statusId}
            role="status"
          >
            {getStatusLine(view, available)}
          </span>
        </div>
        {view.status === "on" && (
          <>
            {view.error && view.activity === "idle" && (
              <UiButton
                size="sm"
                variant="ghost"
                onClick={() => void engine.syncNow()}
              >
                {t("accountSync.retry")}
              </UiButton>
            )}
            <ActionMenu
              label={t("accountSync.moreActions")}
              items={[
                {
                  label: t("accountSync.syncNow"),
                  onSelect: () => void engine.syncNow(),
                  disabled: busy || view.activity === "syncing",
                },
                {
                  label: t("accountSync.deleteRemote"),
                  onSelect: () => void onDeleteRemote(),
                  danger: true,
                  disabled: busy,
                },
              ]}
            />
          </>
        )}
        {view.status === "error" && (
          <UiButton
            size="sm"
            variant="ghost"
            onClick={() => void engine.refresh()}
          >
            {t("accountSync.retry")}
          </UiButton>
        )}
        <Switch
          buttonRef={switchRef}
          checked={checked}
          disabled={switchDisabled}
          onChange={onSwitch}
          labelledBy={titleId}
          describedBy={statusId}
        />
      </div>

      {view.status === "off" && view.notice && !formOpen && (
        <Callout
          tone={view.notice === "passphrase-changed" ? "warning" : "info"}
          live={false}
        >
          {view.notice === "passphrase-changed"
            ? t("accountSync.noticePassphraseChanged")
            : t("accountSync.noticeRemoteRemoved")}
        </Callout>
      )}

      {formOpen && view.status === "off" && (
        <form
          className="AccountSettingRow__detail"
          id={formId}
          onSubmit={onSubmit}
          noValidate
        >
          <p className="AccountSettingRow__intro">
            {isSetup
              ? t("accountSync.setupIntro")
              : t("accountSync.unlockIntro")}
          </p>
          <Field
            label={t("accountSync.passphrase")}
            hint={isSetup ? t("accountSync.passphraseHint") : undefined}
            error={!isSetup ? formError ?? undefined : undefined}
          >
            <TextInput
              type="password"
              autoComplete={isSetup ? "new-password" : "off"}
              autoFocus
              value={passphrase}
              disabled={busy}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </Field>
          {isSetup && (
            <Field
              label={t("accountSync.confirmPassphrase")}
              error={formError ?? undefined}
            >
              <TextInput
                type="password"
                autoComplete="new-password"
                value={confirmation}
                disabled={busy}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </Field>
          )}
          <div className="AccountSettingRow__actions">
            {!isSetup && (
              <UiButton
                size="sm"
                variant="ghost"
                className="AccountSettingRow__actionStart"
                onClick={() => void onForgot()}
                disabled={busy}
              >
                {t("accountSync.forgot")}
              </UiButton>
            )}
            <UiButton size="sm" onClick={() => onSwitch(false)} disabled={busy}>
              {t("accountSync.cancel")}
            </UiButton>
            <UiButton
              size="sm"
              variant="primary"
              type="submit"
              loading={busy}
              disabled={!passphrase || (isSetup && !confirmation)}
            >
              {busy
                ? isSetup
                  ? t("accountSync.encrypting")
                  : t("accountSync.unlocking")
                : isSetup
                ? t("accountSync.setupSubmit")
                : t("accountSync.unlockSubmit")}
            </UiButton>
          </div>
        </form>
      )}

      {view.status === "conflict" && (
        <div className="AccountSettingRow__detail">
          <p className="AccountSettingRow__intro">
            {t("accountSync.conflictIntro", {
              sections: formatSections(view.sections),
            })}
          </p>
          <p className="AccountSettingRow__hint">
            {t("accountSync.conflictHint")}
          </p>
          <div className="AccountSettingRow__actions">
            <UiButton
              size="sm"
              onClick={() => engine.cancelConflict()}
              disabled={busy}
              className="AccountSettingRow__actionStart"
              variant="ghost"
            >
              {t("accountSync.cancel")}
            </UiButton>
            <UiButton
              size="sm"
              onClick={() =>
                void runAction(() => engine.resolveConflict("device"))
              }
              disabled={busy}
            >
              {t("accountSync.keepDevice")}
            </UiButton>
            <UiButton
              size="sm"
              variant="primary"
              onClick={() =>
                void runAction(() => engine.resolveConflict("account"))
              }
              loading={busy}
            >
              {t("accountSync.keepAccount")}
            </UiButton>
          </div>
        </div>
      )}

      {actionError && (
        <Callout tone="danger" live={false}>
          {actionError}
        </Callout>
      )}
    </div>
  );
};
