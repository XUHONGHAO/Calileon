import { useEffect, useMemo, useState } from "react";
import { copyTextToSystemClipboard } from "@excalidraw/excalidraw/clipboard";
import { t } from "@excalidraw/excalidraw/i18n";

import {
  AI_GENERATION_LOGS_UPDATED_EVENT,
  clearAIGenerationLogs,
  loadAIGenerationLogs,
} from "../ai/generationLog";

import { Badge, Callout, confirmAction, UiButton } from "./ui";

import "./AIGenerationLogPanel.scss";

import type { AIGenerationLogEntry } from "../ai/types";
import type { UiTone } from "./ui";

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

type AIGenerationLogPanelProps = {
  onReuseLog?: (log: AIGenerationLogEntry) => void;
};

type I18nT = typeof t;

export const AIGenerationLogPanel = ({
  onReuseLog,
}: AIGenerationLogPanelProps) => {
  const [logs, setLogs] =
    useState<AIGenerationLogEntry[]>(loadAIGenerationLogs);
  const [expandedLogId, setExpandedLogId] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [statusIsError, setStatusIsError] = useState(false);

  useEffect(() => {
    const reloadLogs = () => {
      setLogs(loadAIGenerationLogs());
    };

    window.addEventListener(AI_GENERATION_LOGS_UPDATED_EVENT, reloadLogs);
    window.addEventListener("storage", reloadLogs);

    return () => {
      window.removeEventListener(AI_GENERATION_LOGS_UPDATED_EVENT, reloadLogs);
      window.removeEventListener("storage", reloadLogs);
    };
  }, []);

  const expandedLog = useMemo(
    () => logs.find((log) => log.id === expandedLogId),
    [expandedLogId, logs],
  );

  const clearLogs = async () => {
    const confirmed = await confirmAction(t("ai.generationLog.clearConfirm"), {
      title: t("ai.generationLog.clear"),
      confirmLabel: t("ai.common.clear"),
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    clearAIGenerationLogs();
    setExpandedLogId("");
    setStatusMessage("");
  };

  const reuseLog = (log: AIGenerationLogEntry) => {
    onReuseLog?.(log);
    setStatusIsError(false);
    setStatusMessage(t("ai.generationLog.settingsSent"));
  };

  const copyPrompt = async (log: AIGenerationLogEntry) => {
    try {
      await copyTextToSystemClipboard(log.prompt);
      setStatusIsError(false);
      setStatusMessage(t("ai.generationLog.promptCopied"));
    } catch {
      setStatusIsError(true);
      setStatusMessage(t("alerts.couldNotCopyToClipboard"));
    }
  };

  return (
    <div className="AIGenerationLogPanel">
      {logs.length > 0 && (
        <div className="AIGenerationLogPanel__header">
          <UiButton variant="danger" size="sm" onClick={() => void clearLogs()}>
            {t("ai.generationLog.clear")}
          </UiButton>
        </div>
      )}

      {!logs.length && (
        <div className="AIGenerationLogPanel__emptyState">
          {t("ai.generationLog.empty")}
        </div>
      )}

      {statusMessage && (
        <Callout
          tone={statusIsError ? "danger" : "success"}
          className="AIGenerationLogPanel__message"
        >
          {statusMessage}
        </Callout>
      )}

      <div className="AIGenerationLogPanel__list">
        {logs.map((log) => {
          const isExpanded = expandedLog?.id === log.id;

          return (
            <div
              key={log.id}
              className={
                isExpanded
                  ? "AIGenerationLogPanel__card is-expanded"
                  : "AIGenerationLogPanel__card"
              }
            >
              <button
                type="button"
                className="AIGenerationLogPanel__cardButton"
                aria-expanded={isExpanded}
                onClick={() => setExpandedLogId(isExpanded ? "" : log.id)}
              >
                <span className="AIGenerationLogPanel__cardDate">
                  {formatDate(log.submittedAt)}
                </span>
                <span className="AIGenerationLogPanel__cardModel">
                  {log.model.name} / {log.model.siteName}
                </span>
                <Badge
                  tone={STATUS_TONE[log.status] ?? "danger"}
                  className={`AIGenerationLogPanel__status is-${log.status}`}
                >
                  {getStatusLabel(log.status, t)}
                </Badge>
              </button>

              {isExpanded && (
                <div className="AIGenerationLogPanel__details">
                  <div className="AIGenerationLogPanel__actions">
                    <UiButton
                      variant="primary"
                      size="sm"
                      onClick={() => reuseLog(log)}
                    >
                      {t("ai.generationLog.reuseSettings")}
                    </UiButton>
                    <UiButton size="sm" onClick={() => copyPrompt(log)}>
                      {t("ai.generationLog.copyPrompt")}
                    </UiButton>
                  </div>
                  <dl>
                    <div>
                      <dt>{t("ai.generationLog.fields.type")}</dt>
                      <dd>{log.mediaType}</dd>
                    </div>
                    <div>
                      <dt>{t("ai.generationLog.fields.mode")}</dt>
                      <dd>{log.mode}</dd>
                    </div>
                    <div>
                      <dt>{t("ai.generationLog.fields.completed")}</dt>
                      <dd>{formatDate(log.completedAt)}</dd>
                    </div>
                    <div>
                      <dt>{t("ai.generationLog.fields.summary")}</dt>
                      <dd>{log.response.summary}</dd>
                    </div>
                  </dl>
                  <pre>{stringifyLogDetails(log)}</pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

const STATUS_TONE: Partial<Record<AIGenerationLogEntry["status"], UiTone>> = {
  success: "success",
  canceled: "neutral",
  failed: "danger",
};

const formatDate = (value: string) => {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? value : DATE_FORMAT.format(date);
};

const getStatusLabel = (status: AIGenerationLogEntry["status"], t: I18nT) => {
  if (status === "success") {
    return t("ai.generationLog.status.success");
  }

  if (status === "canceled") {
    return t("ai.generationLog.status.canceled");
  }

  return t("ai.generationLog.status.failed");
};

const stringifyLogDetails = (log: AIGenerationLogEntry) => {
  return JSON.stringify(
    {
      request: log.request,
      prompt: log.prompt,
      negativePrompt: log.negativePrompt,
      params: log.params,
      response: log.response.details,
    },
    null,
    2,
  );
};
