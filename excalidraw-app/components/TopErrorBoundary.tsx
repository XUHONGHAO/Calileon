import { t } from "@excalidraw/excalidraw/i18n";
import * as Sentry from "@sentry/browser";
import React from "react";

import { getErrorReportLocalStorage, hasVaultUrlMarker } from "../data/vault";

interface TopErrorBoundaryState {
  hasError: boolean;
  sentryEventId: string;
  localStorage: string;
}

const renderMessageWithButton = (
  message: string,
  onClick: () => void,
): React.ReactNode => {
  const match = message.match(/^(.*)<button>(.*)<\/button>(.*)$/s);
  if (!match) {
    return message;
  }
  return (
    <>
      {match[1]}
      <button onClick={onClick}>{match[2]}</button>
      {match[3]}
    </>
  );
};

export class TopErrorBoundary extends React.Component<
  any,
  TopErrorBoundaryState
> {
  state: TopErrorBoundaryState = {
    hasError: false,
    sentryEventId: "",
    localStorage: "",
  };

  render() {
    return this.state.hasError ? this.errorSplash() : this.props.children;
  }

  componentDidCatch(error: Error, errorInfo: any) {
    const localStorageReport = getErrorReportLocalStorage(
      localStorage,
      hasVaultUrlMarker(window.location.href),
    );

    Sentry.withScope((scope) => {
      scope.setExtras(errorInfo);
      const eventId = Sentry.captureException(error);

      this.setState((state) => ({
        hasError: true,
        sentryEventId: eventId,
        localStorage: localStorageReport,
      }));
    });
  }

  private selectTextArea(event: React.MouseEvent<HTMLTextAreaElement>) {
    if (event.target !== document.activeElement) {
      event.preventDefault();
      (event.target as HTMLTextAreaElement).select();
    }
  }

  private async createGithubIssue() {
    let body = "";
    try {
      const templateStrFn = (
        await import(
          /* webpackChunkName: "bug-issue-template" */ "../bug-issue-template"
        )
      ).default;
      body = encodeURIComponent(templateStrFn(this.state.sentryEventId));
    } catch (error: any) {
      console.error(error);
    }

    window.open(
      `https://github.com/excalidraw/excalidraw/issues/new?body=${body}`,
      "_blank",
      "noopener noreferrer",
    );
  }

  private errorSplash() {
    return (
      <div className="ErrorSplash excalidraw">
        <div className="ErrorSplash-messageContainer">
          <div className="ErrorSplash-paragraph bigger align-center">
            {renderMessageWithButton(t("errorSplash.headingMain"), () =>
              window.location.reload(),
            )}
          </div>
          <div className="ErrorSplash-paragraph align-center">
            {renderMessageWithButton(
              t("errorSplash.clearCanvasMessage"),
              () => {
                try {
                  localStorage.clear();
                  window.location.reload();
                } catch (error: any) {
                  console.error(error);
                }
              },
            )}
            <br />
            <div className="smaller">
              <span role="img" aria-label="warning">
                ⚠️
              </span>
              {t("errorSplash.clearCanvasCaveat")}
              <span role="img" aria-hidden="true">
                ⚠️
              </span>
            </div>
          </div>
          <div>
            <div className="ErrorSplash-paragraph">
              {t("errorSplash.trackedToSentry", {
                eventId: this.state.sentryEventId,
              })}
            </div>
            <div className="ErrorSplash-paragraph">
              {renderMessageWithButton(
                t("errorSplash.openIssueMessage"),
                () => void this.createGithubIssue(),
              )}
            </div>
            <div className="ErrorSplash-paragraph">
              <div className="ErrorSplash-details">
                <label>{t("errorSplash.sceneContent")}</label>
                <textarea
                  rows={5}
                  onPointerDown={this.selectTextArea}
                  readOnly={true}
                  value={this.state.localStorage}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
