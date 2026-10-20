import { Dialog } from "@excalidraw/excalidraw/components/Dialog";
import { CloseIcon } from "@excalidraw/excalidraw/components/icons";
import { t } from "@excalidraw/excalidraw/i18n";
import React, { useCallback, useEffect, useState } from "react";

import { getCloudBackend } from "../data/cloud";
import {
  getCloudEmbedHostSnippet,
  getCloudEmbedIframeCode,
} from "../data/cloud/cloudEmbedLinks";
import { normalizeEmbedOrigins } from "../data/cloud/embedOrigin";

import "./EmbedListDialog.scss";

import {
  Badge,
  Callout,
  DialogActions,
  Field,
  ListRow,
  Select,
  TextArea,
  UiButton,
  confirmAction,
} from "./ui";

import type {
  EmbedMode,
  EmbedRecord,
  EmbedSize,
  EmbedTheme,
  SceneSummary,
} from "../data/cloud";

export interface EmbedListDialogProps {
  open: boolean;
  scene: SceneSummary | null;
  onClose: () => void;
  onBack?: () => void;
}

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : t("cloud.embed.genericError");

const getModeLabel = (mode: EmbedMode) => {
  if (mode === "write") {
    return t("cloud.embed.modeWrite");
  }
  if (mode === "collab") {
    return t("cloud.embed.modeCollab");
  }
  return t("cloud.embed.modeRead");
};

const getThemeLabel = (theme: EmbedTheme) => {
  if (theme === "light") {
    return t("cloud.embed.themeLight");
  }
  if (theme === "dark") {
    return t("cloud.embed.themeDark");
  }
  return t("cloud.embed.themeSystem");
};

const getSizeLabel = (size: EmbedSize) => {
  if (size === "wide") {
    return t("cloud.embed.sizeWide");
  }
  if (size === "compact") {
    return t("cloud.embed.sizeCompact");
  }
  return t("cloud.embed.sizeResponsive");
};

export const EmbedListDialog: React.FC<EmbedListDialogProps> = ({
  open,
  scene,
  onClose,
  onBack,
}) => {
  const [embeds, setEmbeds] = useState<EmbedRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<EmbedMode>("read");
  const [theme, setTheme] = useState<EmbedTheme>("system");
  const [size, setSize] = useState<EmbedSize>("responsive");
  const [originText, setOriginText] = useState("");

  const backend = getCloudBackend();

  const loadEmbeds = useCallback(async () => {
    if (!scene) {
      return;
    }
    if (!backend.capabilities.embed) {
      setEmbeds([]);
      setError(t("cloud.embed.unavailable"));
      return;
    }

    setLoading(true);
    setError(null);
    try {
      setEmbeds(await backend.embed.listByScene(scene.id, { limit: 50 }));
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [backend, scene]);

  useEffect(() => {
    if (!open || !scene) {
      setEmbeds([]);
      setLoading(false);
      setBusyId(null);
      setError(null);
      setMode("read");
      setTheme("system");
      setSize("responsive");
      setOriginText("");
      return;
    }

    setOriginText(window.location.origin);
    void loadEmbeds();
  }, [loadEmbeds, open, scene]);

  if (!open || !scene) {
    return null;
  }

  const handleClose = () => {
    if (loading || busyId) {
      return;
    }
    onClose();
  };

  const handleCreate = async () => {
    const allowedOrigins = normalizeEmbedOrigins(
      originText
        .split(/[\n,]/)
        .map((origin) => origin.trim())
        .filter(Boolean),
    );
    if (allowedOrigins.length === 0) {
      setError(t("cloud.embed.originRequired"));
      return;
    }

    setBusyId("create");
    setError(null);
    try {
      await backend.embed.create({
        sceneId: scene.id,
        mode,
        allowedOrigins,
        theme,
        size,
      });
      await loadEmbeds();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleCopyIframe = async (embed: EmbedRecord) => {
    setBusyId(embed.id);
    setError(null);
    try {
      await navigator.clipboard.writeText(
        getCloudEmbedIframeCode({
          token: embed.token,
          key: backend.encryption?.getKey?.(embed.sceneId)?.key,
          title: scene.title,
          height: embed.size === "compact" ? "420" : "600",
        }),
      );
    } catch {
      setError(t("cloud.embed.copyFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const handleCopySnippet = async (embed: EmbedRecord) => {
    setBusyId(embed.id);
    setError(null);
    try {
      await navigator.clipboard.writeText(
        getCloudEmbedHostSnippet({ iframeId: `excalidraw-embed-${embed.id}` }),
      );
    } catch {
      setError(t("cloud.embed.copyFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const handleRevoke = async (embed: EmbedRecord) => {
    if (!(await confirmAction(t("cloud.embed.revokeConfirm")))) {
      return;
    }

    setBusyId(embed.id);
    setError(null);
    try {
      await backend.embed.revoke(embed.id);
      await loadEmbeds();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const stopShortcutPropagation = (event: React.KeyboardEvent) => {
    event.stopPropagation();
  };

  const formDisabled = loading || !!busyId;

  const renderStatus = (message: string) => (
    <p className="EmbedListDialog__status" role="status">
      {message}
    </p>
  );

  return (
    <Dialog
      className="EmbedListDialogModal"
      size="regular"
      closeOnClickOutside={false}
      onCloseRequest={handleClose}
      title={t("cloud.embed.title")}
    >
      <div className="EmbedListDialog">
        <UiButton
          className="EmbedListDialog__close"
          variant="ghost"
          size="sm"
          iconOnly
          icon={CloseIcon}
          aria-label={t("buttons.close")}
          title={t("buttons.close")}
          onClick={handleClose}
          disabled={formDisabled}
        />

        <p className="EmbedListDialog__description">
          {t("cloud.embed.description", { title: scene.title })}
        </p>

        {error && <Callout tone="danger">{error}</Callout>}

        <div className="EmbedListDialog__create">
          <Field label={t("cloud.embed.allowedOrigins")}>
            <TextArea
              value={originText}
              onChange={(event) => setOriginText(event.currentTarget.value)}
              onKeyDown={stopShortcutPropagation}
              disabled={formDisabled}
              rows={3}
            />
          </Field>
          <div className="EmbedListDialog__options">
            <Field label={t("cloud.embed.mode")}>
              <Select
                value={mode}
                disabled={formDisabled}
                onChange={(event) => setMode(event.target.value as EmbedMode)}
              >
                <option value="read">{t("cloud.embed.modeRead")}</option>
                <option value="write">{t("cloud.embed.modeWrite")}</option>
              </Select>
            </Field>
            <Field label={t("cloud.embed.theme")}>
              <Select
                value={theme}
                disabled={formDisabled}
                onChange={(event) => setTheme(event.target.value as EmbedTheme)}
              >
                <option value="system">{t("cloud.embed.themeSystem")}</option>
                <option value="light">{t("cloud.embed.themeLight")}</option>
                <option value="dark">{t("cloud.embed.themeDark")}</option>
              </Select>
            </Field>
            <Field label={t("cloud.embed.size")}>
              <Select
                value={size}
                disabled={formDisabled}
                onChange={(event) => setSize(event.target.value as EmbedSize)}
              >
                <option value="responsive">
                  {t("cloud.embed.sizeResponsive")}
                </option>
                <option value="wide">{t("cloud.embed.sizeWide")}</option>
                <option value="compact">{t("cloud.embed.sizeCompact")}</option>
              </Select>
            </Field>
          </div>
          <div className="EmbedListDialog__createActions">
            <UiButton
              variant="primary"
              loading={busyId === "create"}
              disabled={loading || !!busyId || !originText.trim()}
              onClick={() => void handleCreate()}
            >
              {busyId === "create"
                ? t("cloud.embed.creating")
                : t("cloud.embed.create")}
            </UiButton>
          </div>
        </div>

        {loading ? (
          renderStatus(t("cloud.embed.loading"))
        ) : embeds.length === 0 ? (
          renderStatus(t("cloud.embed.empty"))
        ) : (
          <ul className="EmbedListDialog__list">
            {embeds.map((embed) => {
              const origins = embed.allowedOrigins.join(", ");
              return (
                <ListRow
                  key={embed.id}
                  className={
                    embed.revoked ? "EmbedListDialog__row--revoked" : undefined
                  }
                  title={getModeLabel(embed.mode)}
                  badges={
                    embed.revoked && <Badge>{t("cloud.embed.revoked")}</Badge>
                  }
                  meta={
                    <>
                      <span className="EmbedListDialog__metaLine">
                        {t("cloud.embed.meta", {
                          theme: getThemeLabel(embed.theme),
                          size: getSizeLabel(embed.size),
                        })}
                      </span>
                      <span
                        className="EmbedListDialog__metaLine"
                        title={origins}
                      >
                        {origins}
                      </span>
                    </>
                  }
                  actions={
                    !embed.revoked && (
                      <UiButton
                        size="sm"
                        loading={busyId === embed.id}
                        disabled={!!busyId}
                        onClick={() => void handleCopyIframe(embed)}
                      >
                        {t("cloud.embed.copyIframe")}
                      </UiButton>
                    )
                  }
                  menu={
                    embed.revoked
                      ? undefined
                      : [
                          {
                            label: t("cloud.embed.copySnippet"),
                            onSelect: () => void handleCopySnippet(embed),
                            disabled: !!busyId,
                          },
                          {
                            label: t("cloud.embed.revoke"),
                            onSelect: () => void handleRevoke(embed),
                            danger: true,
                            disabled: !!busyId,
                          },
                        ]
                  }
                />
              );
            })}
          </ul>
        )}

        <DialogActions
          leading={
            onBack && (
              <UiButton
                variant="ghost"
                onClick={onBack}
                disabled={formDisabled}
              >
                {t("cloud.scenes.back")}
              </UiButton>
            )
          }
        >
          <UiButton onClick={() => void loadEmbeds()} disabled={formDisabled}>
            {t("cloud.scenes.refresh")}
          </UiButton>
        </DialogActions>
      </div>
    </Dialog>
  );
};
