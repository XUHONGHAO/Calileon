import { Button } from "@excalidraw/excalidraw/components/Button";
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
    if (!window.confirm(t("cloud.embed.revokeConfirm"))) {
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

  return (
    <Dialog
      className="EmbedListDialogModal"
      size="regular"
      closeOnClickOutside={false}
      onCloseRequest={handleClose}
      title={t("cloud.embed.title")}
    >
      <div className="EmbedListDialog">
        <button
          className="EmbedListDialog__close"
          type="button"
          aria-label={t("buttons.close")}
          title={t("buttons.close")}
          onClick={handleClose}
          disabled={loading || !!busyId}
        >
          {CloseIcon}
        </button>

        <div className="EmbedListDialog__toolbar">
          <p>{t("cloud.embed.description", { title: scene.title })}</p>
          <div className="EmbedListDialog__toolbarActions">
            {onBack && (
              <Button onSelect={onBack} disabled={loading || !!busyId}>
                {t("cloud.scenes.back")}
              </Button>
            )}
            <Button
              onSelect={() => void loadEmbeds()}
              disabled={loading || !!busyId}
            >
              {t("cloud.scenes.refresh")}
            </Button>
          </div>
        </div>

        {error && (
          <p className="EmbedListDialog__error" role="alert">
            {error}
          </p>
        )}

        <div className="EmbedListDialog__create">
          <label>
            <span>{t("cloud.embed.allowedOrigins")}</span>
            <textarea
              value={originText}
              onChange={(event) => setOriginText(event.currentTarget.value)}
              onKeyDown={stopShortcutPropagation}
              disabled={loading || !!busyId}
              rows={3}
            />
          </label>
          <div className="EmbedListDialog__options">
            <label>
              <span>{t("cloud.embed.mode")}</span>
              <select
                value={mode}
                disabled={loading || !!busyId}
                onChange={(event) => setMode(event.target.value as EmbedMode)}
              >
                <option value="read">{t("cloud.embed.modeRead")}</option>
                <option value="write">{t("cloud.embed.modeWrite")}</option>
              </select>
            </label>
            <label>
              <span>{t("cloud.embed.theme")}</span>
              <select
                value={theme}
                disabled={loading || !!busyId}
                onChange={(event) => setTheme(event.target.value as EmbedTheme)}
              >
                <option value="system">{t("cloud.embed.themeSystem")}</option>
                <option value="light">{t("cloud.embed.themeLight")}</option>
                <option value="dark">{t("cloud.embed.themeDark")}</option>
              </select>
            </label>
            <label>
              <span>{t("cloud.embed.size")}</span>
              <select
                value={size}
                disabled={loading || !!busyId}
                onChange={(event) => setSize(event.target.value as EmbedSize)}
              >
                <option value="responsive">
                  {t("cloud.embed.sizeResponsive")}
                </option>
                <option value="wide">{t("cloud.embed.sizeWide")}</option>
                <option value="compact">{t("cloud.embed.sizeCompact")}</option>
              </select>
            </label>
          </div>
          <Button
            onSelect={() => void handleCreate()}
            disabled={loading || !!busyId || !originText.trim()}
          >
            {busyId === "create"
              ? t("cloud.embed.creating")
              : t("cloud.embed.create")}
          </Button>
        </div>

        {loading ? (
          <div className="EmbedListDialog__status">
            {t("cloud.embed.loading")}
          </div>
        ) : embeds.length === 0 ? (
          <div className="EmbedListDialog__status">
            {t("cloud.embed.empty")}
          </div>
        ) : (
          <ul className="EmbedListDialog__list">
            {embeds.map((embed) => (
              <li className="EmbedListDialog__item" key={embed.id}>
                <div className="EmbedListDialog__details">
                  <strong>
                    {embed.revoked
                      ? t("cloud.embed.revoked")
                      : getModeLabel(embed.mode)}
                  </strong>
                  <span>
                    {t("cloud.embed.meta", {
                      theme: getThemeLabel(embed.theme),
                      size: getSizeLabel(embed.size),
                    })}
                  </span>
                  <small title={embed.allowedOrigins.join(", ")}>
                    {embed.allowedOrigins.join(", ")}
                  </small>
                </div>
                <div className="EmbedListDialog__actions">
                  <Button
                    onSelect={() => void handleCopyIframe(embed)}
                    disabled={!!busyId || embed.revoked}
                  >
                    {t("cloud.embed.copyIframe")}
                  </Button>
                  <Button
                    onSelect={() => void handleCopySnippet(embed)}
                    disabled={!!busyId || embed.revoked}
                  >
                    {t("cloud.embed.copySnippet")}
                  </Button>
                  <Button
                    onSelect={() => void handleRevoke(embed)}
                    disabled={!!busyId || embed.revoked}
                  >
                    {t("cloud.embed.revoke")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
};
