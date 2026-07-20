import React from "react";

import { Button } from "@excalidraw/excalidraw/components/Button";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { t } from "@excalidraw/excalidraw/i18n";

import {
  createVaultShareInvitation,
  readVaultSessionSecrets,
  revokeVaultShareInvitation,
  VaultError,
} from "../data/vault";

import "./VaultShareDialog.scss";

import type {
  VaultClientSession,
  VaultErrorCode,
  VaultOwnerService,
  VaultRole,
  VaultShareInvitationMetadata,
} from "../data/vault";

type VaultShareExpiry = "never" | "day" | "week";
type ManagedInvitation = VaultShareInvitationMetadata & {
  state: "active" | "revoking" | "revoked";
};
type VaultShareFeedback =
  | { kind: "idle" }
  | { kind: "success"; message: string }
  | { kind: "error"; code: VaultErrorCode };

export interface VaultShareTarget {
  readonly session: VaultClientSession;
  readonly owner: VaultOwnerService;
}

const getStableShareError = (error: unknown): VaultErrorCode =>
  error instanceof VaultError ? error.code : "VAULT_INTERNAL";

const getShareErrorMessage = (code: VaultErrorCode): string => {
  switch (code) {
    case "VAULT_CAPABILITY_FORBIDDEN":
      return t("vault.share.errors.ownerRequired");
    case "VAULT_CAPABILITY_EXPIRED":
      return t("vault.share.errors.expired");
    case "VAULT_CAPABILITY_REVOKED":
      return t("vault.share.errors.revoked");
    case "VAULT_PERSISTENCE_UNAVAILABLE":
      return t("vault.share.errors.unavailable");
    default:
      return t("vault.share.errors.internal");
  }
};

const getExpiresAt = (expiry: VaultShareExpiry): number | null => {
  switch (expiry) {
    case "never":
      return null;
    case "day":
      return Date.now() + 24 * 60 * 60 * 1000;
    case "week":
      return Date.now() + 7 * 24 * 60 * 60 * 1000;
  }
};

const copyBearerLink = async (link: string) => {
  if (!navigator.clipboard?.writeText) {
    throw new VaultError(
      "VAULT_INTERNAL",
      "Vault invitation clipboard is unavailable.",
      { recoverable: true },
    );
  }
  await navigator.clipboard.writeText(link);
};

export const VaultShareDialog = ({
  open,
  onClose,
  activeVault,
}: {
  open: boolean;
  onClose: () => void;
  activeVault: VaultShareTarget;
}) => {
  const [role, setRole] = React.useState<VaultRole>("viewer");
  const [expiry, setExpiry] = React.useState<VaultShareExpiry>("never");
  const [isCreating, setIsCreating] = React.useState(false);
  const [feedback, setFeedback] = React.useState<VaultShareFeedback>({
    kind: "idle",
  });
  const [invitations, setInvitations] = React.useState<ManagedInvitation[]>([]);
  const bearerLinksRef = React.useRef(new Map<string, string>());

  React.useEffect(() => {
    bearerLinksRef.current.clear();
    setInvitations([]);
    setFeedback({ kind: "idle" });
    setIsCreating(false);
  }, [activeVault.session]);

  const copyInvitation = React.useCallback(async (invitationId: string) => {
    const link = bearerLinksRef.current.get(invitationId);
    if (!link) {
      setFeedback({ kind: "error", code: "VAULT_CAPABILITY_INVALID" });
      return;
    }
    try {
      await copyBearerLink(link);
      setFeedback({
        kind: "success",
        message: t("vault.share.copied"),
      });
    } catch (error) {
      setFeedback({ kind: "error", code: getStableShareError(error) });
    }
  }, []);

  const createInvitation = React.useCallback(async () => {
    if (isCreating || activeVault.session.role !== "editor") {
      return;
    }
    setIsCreating(true);
    setFeedback({ kind: "idle" });
    try {
      const { rootKey } = readVaultSessionSecrets(activeVault.session);
      const result = await createVaultShareInvitation({
        owner: activeVault.owner,
        vaultId: activeVault.session.vaultId,
        rootKey,
        role,
        expiresAt: getExpiresAt(expiry),
        baseUrl: window.location.href,
      });
      bearerLinksRef.current.set(result.metadata.invitationId, result.link);
      setInvitations((current) => [
        ...current,
        { ...result.metadata, state: "active" },
      ]);
      await copyBearerLink(result.link);
      setFeedback({
        kind: "success",
        message: t("vault.share.createdAndCopied"),
      });
    } catch (error) {
      setFeedback({ kind: "error", code: getStableShareError(error) });
    } finally {
      setIsCreating(false);
    }
  }, [activeVault, expiry, isCreating, role]);

  const revokeInvitation = React.useCallback(
    async (invitationId: string) => {
      setFeedback({ kind: "idle" });
      setInvitations((current) =>
        current.map((invitation) =>
          invitation.invitationId === invitationId
            ? { ...invitation, state: "revoking" }
            : invitation,
        ),
      );
      try {
        await revokeVaultShareInvitation({
          owner: activeVault.owner,
          vaultId: activeVault.session.vaultId,
          invitationId,
        });
        bearerLinksRef.current.delete(invitationId);
        setInvitations((current) =>
          current.map((invitation) =>
            invitation.invitationId === invitationId
              ? { ...invitation, state: "revoked" }
              : invitation,
          ),
        );
        setFeedback({
          kind: "success",
          message: t("vault.share.revoked"),
        });
      } catch (error) {
        setInvitations((current) =>
          current.map((invitation) =>
            invitation.invitationId === invitationId
              ? { ...invitation, state: "active" }
              : invitation,
          ),
        );
        setFeedback({ kind: "error", code: getStableShareError(error) });
      }
    },
    [activeVault],
  );

  if (!open) {
    return null;
  }

  return (
    <Dialog
      title={t("vault.share.title")}
      onCloseRequest={onClose}
      size="small"
      closeOnClickOutside={false}
    >
      <div className="VaultShareDialog">
        <p>{t("vault.share.description")}</p>
        <div className="VaultShareDialog__warning" role="note">
          {t("vault.share.bearerWarning")}
        </div>

        <div className="VaultShareDialog__form">
          <label>
            <span>{t("vault.share.role")}</span>
            <select
              aria-label={t("vault.share.role")}
              value={role}
              onChange={(event) => setRole(event.target.value as VaultRole)}
            >
              <option value="viewer">{t("vault.share.viewer")}</option>
              <option value="editor">{t("vault.share.editor")}</option>
            </select>
          </label>
          <label>
            <span>{t("vault.share.expiry")}</span>
            <select
              aria-label={t("vault.share.expiry")}
              value={expiry}
              onChange={(event) =>
                setExpiry(event.target.value as VaultShareExpiry)
              }
            >
              <option value="never">{t("vault.share.expiryNever")}</option>
              <option value="day">{t("vault.share.expiryDay")}</option>
              <option value="week">{t("vault.share.expiryWeek")}</option>
            </select>
          </label>
        </div>

        <div className="VaultShareDialog__actions">
          <Button
            onSelect={() => void createInvitation()}
            disabled={isCreating}
          >
            {isCreating
              ? t("vault.share.creating")
              : t("vault.share.createAndCopy")}
          </Button>
          <Button onSelect={onClose}>{t("buttons.close")}</Button>
        </div>

        {feedback.kind === "success" && (
          <div
            className="VaultShareDialog__feedback VaultShareDialog__feedback--success"
            role="status"
          >
            {feedback.message}
          </div>
        )}
        {feedback.kind === "error" && (
          <div
            className="VaultShareDialog__feedback VaultShareDialog__feedback--error"
            role="alert"
          >
            <span>{getShareErrorMessage(feedback.code)}</span>
            <code>{feedback.code}</code>
          </div>
        )}

        <div className="VaultShareDialog__invitations">
          <h3>{t("vault.share.createdInvitations")}</h3>
          {invitations.length === 0 ? (
            <p className="VaultShareDialog__empty">
              {t("vault.share.noInvitations")}
            </p>
          ) : (
            <ul>
              {invitations.map((invitation) => (
                <li key={invitation.invitationId}>
                  <div>
                    <strong>
                      {invitation.role === "viewer"
                        ? t("vault.share.viewer")
                        : t("vault.share.editor")}
                    </strong>
                    <span>
                      {invitation.expiresAt === null
                        ? t("vault.share.expiryNever")
                        : t("vault.share.expiresAt", {
                            date: new Date(
                              invitation.expiresAt,
                            ).toLocaleString(),
                          })}
                    </span>
                    {invitation.state === "revoked" && (
                      <span className="VaultShareDialog__revoked">
                        {t("vault.share.revoked")}
                      </span>
                    )}
                  </div>
                  <div className="VaultShareDialog__itemActions">
                    <Button
                      onSelect={() =>
                        void copyInvitation(invitation.invitationId)
                      }
                      disabled={invitation.state !== "active"}
                    >
                      {t("vault.share.copy")}
                    </Button>
                    <Button
                      onSelect={() =>
                        void revokeInvitation(invitation.invitationId)
                      }
                      disabled={invitation.state !== "active"}
                    >
                      {invitation.state === "revoking"
                        ? t("vault.share.revoking")
                        : t("vault.share.revoke")}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  );
};
