import { useEffect, useMemo, useState } from "react";

import {
  AI_GENERATION_LOGS_UPDATED_EVENT,
  clearAIGenerationLogs,
  loadAIGenerationLogs,
} from "../ai/generationLog";

import "./AIGenerationLogPanel.scss";

import type { AIGenerationLogEntry } from "../ai/types";

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

export const AIGenerationLogPanel = () => {
  const [logs, setLogs] =
    useState<AIGenerationLogEntry[]>(loadAIGenerationLogs);
  const [expandedLogId, setExpandedLogId] = useState("");

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

  const clearLogs = () => {
    clearAIGenerationLogs();
    setExpandedLogId("");
  };

  return (
    <div className="AIGenerationLogPanel">
      <div className="AIGenerationLogPanel__header">
        <h3>Generation logs</h3>
        <button type="button" onClick={clearLogs} disabled={!logs.length}>
          Clear logs
        </button>
      </div>

      {!logs.length && (
        <div className="AIGenerationLogPanel__emptyState">
          No generation logs.
        </div>
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
                onClick={() => setExpandedLogId(isExpanded ? "" : log.id)}
              >
                <span className="AIGenerationLogPanel__cardDate">
                  {formatDate(log.submittedAt)}
                </span>
                <span className="AIGenerationLogPanel__cardModel">
                  {log.model.name} / {log.model.siteName}
                </span>
                <span
                  className={`AIGenerationLogPanel__status is-${log.status}`}
                >
                  {getStatusLabel(log.status)}
                </span>
              </button>

              {isExpanded && (
                <div className="AIGenerationLogPanel__details">
                  <dl>
                    <div>
                      <dt>Type</dt>
                      <dd>{log.mediaType}</dd>
                    </div>
                    <div>
                      <dt>Mode</dt>
                      <dd>{log.mode}</dd>
                    </div>
                    <div>
                      <dt>Completed</dt>
                      <dd>{formatDate(log.completedAt)}</dd>
                    </div>
                    <div>
                      <dt>Summary</dt>
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

const formatDate = (value: string) => {
  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? value : DATE_FORMAT.format(date);
};

const getStatusLabel = (status: AIGenerationLogEntry["status"]) => {
  if (status === "success") {
    return "Success";
  }

  if (status === "canceled") {
    return "Canceled";
  }

  return "Failed";
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
