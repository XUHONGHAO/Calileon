import React from "react";

import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import Spinner from "@excalidraw/excalidraw/components/Spinner";
import { t } from "@excalidraw/excalidraw/i18n";

import {
  assertVaultClientConfig,
  createHttpVaultRoomProvisionTransport,
  createVault,
  createHttpVaultDeploymentDiscoveryTransport,
  discoverVaultDeployment,
  readVaultClientConfig,
  VaultError,
} from "../data/vault";
import { createSupabaseVaultBackend } from "../data/cloud";

import { Callout, DialogActions, UiButton } from "./ui";

import "./VaultDependencyDialog.scss";

import type {
  VaultClientConfig,
  VaultDeploymentReady,
  VaultErrorCode,
} from "../data/vault";

type VaultDependencyStatus =
  | { kind: "idle" | "checking" }
  | {
      kind: "ready";
      config: VaultClientConfig & {
        enabled: true;
        persistenceCapabilitiesUrl: string;
        roomCapabilitiesUrl: string;
        roomProvisionUrl: string;
      };
      deployment: VaultDeploymentReady;
    }
  | { kind: "error"; code: VaultErrorCode };

const getStableDependencyError = (error: unknown): VaultErrorCode =>
  error instanceof VaultError ? error.code : "VAULT_INTERNAL";

const getDependencyErrorMessage = (code: VaultErrorCode): string => {
  switch (code) {
    case "VAULT_SECURE_CONTEXT_REQUIRED":
      return t("vault.dependency.errors.secureContext");
    case "VAULT_CRYPTO_UNAVAILABLE":
      return t("vault.dependency.errors.cryptoUnavailable");
    case "VAULT_ROOM_PROTOCOL_UNSUPPORTED":
      return t("vault.dependency.errors.roomUnavailable");
    case "VAULT_PROTOCOL_UNSUPPORTED":
      return t("vault.dependency.errors.protocolUnsupported");
    case "VAULT_PERSISTENCE_UNAVAILABLE":
      return t("vault.dependency.errors.persistenceUnavailable");
    default:
      return t("vault.dependency.errors.internal");
  }
};

export const VaultDependencyDialog = ({
  open,
  onClose,
  canCreate,
  onSignIn,
  onCreated,
  onCreateV2,
}: {
  open: boolean;
  onClose: () => void;
  canCreate: boolean;
  onSignIn?: () => void;
  onCreated?: (editorLink: string) => void;
  /** P4c W6: only passed when Vault v2 is enabled; resolves to the editor link */
  onCreateV2?: () => Promise<string>;
}) => {
  const [status, setStatus] = React.useState<VaultDependencyStatus>({
    kind: "idle",
  });
  const [creationError, setCreationError] =
    React.useState<VaultErrorCode | null>(null);
  // which create action is running ("v1" | "v2"); false when idle
  const [isCreating, setIsCreating] = React.useState<false | "v1" | "v2">(
    false,
  );
  const attemptRef = React.useRef(0);

  const checkDependencies = React.useCallback(async () => {
    const attempt = ++attemptRef.current;
    setStatus({ kind: "checking" });
    setCreationError(null);

    try {
      const config = readVaultClientConfig();
      assertVaultClientConfig(config);
      const transport = createHttpVaultDeploymentDiscoveryTransport({
        persistenceCapabilitiesUrl: config.persistenceCapabilitiesUrl,
        roomCapabilitiesUrl: config.roomCapabilitiesUrl,
      });
      const { ready } = await discoverVaultDeployment(transport);
      if (attempt === attemptRef.current) {
        setStatus({ kind: "ready", config, deployment: ready });
      }
    } catch (error) {
      if (attempt === attemptRef.current) {
        setStatus({ kind: "error", code: getStableDependencyError(error) });
      }
    }
  }, []);

  React.useEffect(() => {
    if (!open) {
      attemptRef.current += 1;
      setStatus({ kind: "idle" });
      setCreationError(null);
      setIsCreating(false);
      return;
    }
    void checkDependencies();
  }, [checkDependencies, open]);

  const createEmptyVault = React.useCallback(async () => {
    if (status.kind !== "ready" || !canCreate || isCreating) {
      return;
    }
    setCreationError(null);
    setIsCreating("v1");
    try {
      const backend = createSupabaseVaultBackend(status.deployment);
      const rooms = createHttpVaultRoomProvisionTransport({
        provisionUrl: status.config.roomProvisionUrl,
      });
      const created = await createVault({
        deployment: status.deployment,
        owner: backend.owner,
        rooms,
        baseUrl: window.location.href,
      });
      onClose();
      if (onCreated) {
        onCreated(created.editorLink);
      } else {
        window.location.assign(created.editorLink);
      }
    } catch (error) {
      setCreationError(getStableDependencyError(error));
      setIsCreating(false);
    }
  }, [canCreate, isCreating, onClose, onCreated, status]);

  const createEmptyVaultV2 = React.useCallback(async () => {
    if (status.kind !== "ready" || !canCreate || isCreating || !onCreateV2) {
      return;
    }
    setCreationError(null);
    setIsCreating("v2");
    try {
      const editorLink = await onCreateV2();
      onClose();
      if (onCreated) {
        onCreated(editorLink);
      } else {
        window.location.assign(editorLink);
      }
    } catch (error) {
      setCreationError(getStableDependencyError(error));
      setIsCreating(false);
    }
  }, [canCreate, isCreating, onClose, onCreateV2, onCreated, status]);

  if (!open) {
    return null;
  }

  return (
    <Dialog
      title={t("vault.dependency.title")}
      onCloseRequest={onClose}
      size="small"
      closeOnClickOutside={false}
    >
      <div className="VaultDependencyDialog">
        <p className="VaultDependencyDialog__description">
          {t("vault.dependency.description")}
        </p>

        {status.kind === "checking" && (
          <div className="VaultDependencyDialog__checking" role="status">
            <Spinner />
            <span>{t("vault.dependency.checking")}</span>
          </div>
        )}

        {status.kind === "ready" && (
          <>
            <Callout tone="success">{t("vault.dependency.ready")}</Callout>
            <p className="VaultDependencyDialog__notice">
              {t("vault.creation.emptyNotice")}
            </p>
            {canCreate && onCreateV2 && (
              <p className="VaultDependencyDialog__notice">
                {t("vault.v2.createHint")}
              </p>
            )}
            {!canCreate && (
              <Callout tone="warning">
                {t("vault.creation.signInRequired")}
              </Callout>
            )}
          </>
        )}

        {status.kind === "error" && (
          <Callout tone="danger" details={status.code}>
            {getDependencyErrorMessage(status.code)}
          </Callout>
        )}

        {creationError && (
          <Callout tone="danger" details={creationError}>
            {t("vault.creation.error")}
          </Callout>
        )}

        <DialogActions>
          <UiButton onClick={onClose}>{t("buttons.close")}</UiButton>
          {status.kind === "error" && (
            <UiButton
              variant="primary"
              onClick={() => void checkDependencies()}
            >
              {t("vault.dependency.retry")}
            </UiButton>
          )}
          {status.kind === "ready" && !canCreate && onSignIn && (
            <UiButton variant="primary" onClick={onSignIn}>
              {t("vault.creation.signIn")}
            </UiButton>
          )}
          {status.kind === "ready" && canCreate && (
            <UiButton
              variant={onCreateV2 ? "secondary" : "primary"}
              onClick={() => void createEmptyVault()}
              disabled={isCreating !== false}
              loading={isCreating === "v1"}
            >
              {isCreating === "v1"
                ? t("vault.creation.creating")
                : t("vault.creation.create")}
            </UiButton>
          )}
          {status.kind === "ready" && canCreate && onCreateV2 && (
            <UiButton
              variant="primary"
              onClick={() => void createEmptyVaultV2()}
              disabled={isCreating !== false}
              loading={isCreating === "v2"}
            >
              {isCreating === "v2"
                ? t("vault.creation.creating")
                : t("vault.v2.create")}
            </UiButton>
          )}
        </DialogActions>
      </div>
    </Dialog>
  );
};
