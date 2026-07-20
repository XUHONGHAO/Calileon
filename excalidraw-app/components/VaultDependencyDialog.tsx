import React from "react";

import { Button } from "@excalidraw/excalidraw/components/Button";
import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
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
}: {
  open: boolean;
  onClose: () => void;
  canCreate: boolean;
  onSignIn?: () => void;
  onCreated?: (editorLink: string) => void;
}) => {
  const [status, setStatus] = React.useState<VaultDependencyStatus>({
    kind: "idle",
  });
  const [creationError, setCreationError] =
    React.useState<VaultErrorCode | null>(null);
  const [isCreating, setIsCreating] = React.useState(false);
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
    setIsCreating(true);
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
        <p>{t("vault.dependency.description")}</p>

        {status.kind === "checking" && (
          <div className="VaultDependencyDialog__status" role="status">
            {t("vault.dependency.checking")}
          </div>
        )}

        {status.kind === "ready" && (
          <>
            <div
              className="VaultDependencyDialog__status VaultDependencyDialog__status--ready"
              role="status"
            >
              {t("vault.dependency.ready")}
            </div>
            <div className="VaultDependencyDialog__notice">
              {t("vault.creation.emptyNotice")}
            </div>
            {!canCreate && (
              <div
                className="VaultDependencyDialog__status VaultDependencyDialog__status--warning"
                role="status"
              >
                {t("vault.creation.signInRequired")}
              </div>
            )}
          </>
        )}

        {status.kind === "error" && (
          <div
            className="VaultDependencyDialog__status VaultDependencyDialog__status--error"
            role="alert"
          >
            <span>{getDependencyErrorMessage(status.code)}</span>
            <code>{status.code}</code>
          </div>
        )}

        {creationError && (
          <div
            className="VaultDependencyDialog__status VaultDependencyDialog__status--error"
            role="alert"
          >
            <span>{t("vault.creation.error")}</span>
            <code>{creationError}</code>
          </div>
        )}

        <div className="VaultDependencyDialog__actions">
          {status.kind === "error" && (
            <Button onSelect={() => void checkDependencies()}>
              {t("vault.dependency.retry")}
            </Button>
          )}
          {status.kind === "ready" && !canCreate && onSignIn && (
            <Button onSelect={onSignIn}>{t("vault.creation.signIn")}</Button>
          )}
          {status.kind === "ready" && canCreate && (
            <Button
              onSelect={() => void createEmptyVault()}
              disabled={isCreating}
            >
              {isCreating
                ? t("vault.creation.creating")
                : t("vault.creation.create")}
            </Button>
          )}
          <Button onSelect={onClose}>{t("buttons.close")}</Button>
        </div>
      </div>
    </Dialog>
  );
};
