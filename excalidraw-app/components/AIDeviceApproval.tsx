import React, { useMemo, useState } from "react";

import { t } from "@excalidraw/excalidraw/i18n";

import { useCloudAuth } from "../auth/useCloudAuth";
import { getCloudBackend } from "../data/cloud";

import "./AIDeviceApproval.scss";

/**
 * Reads the short code from the verification URL without retaining any
 * device token. Keeping this helper pure also makes the URL contract easy to
 * test without mounting the full application shell.
 */
export const getAIDeviceApprovalCode = (search: string): string => {
  try {
    return (new URLSearchParams(search).get("code") || "").trim().toUpperCase();
  } catch {
    return "";
  }
};

export const AIDeviceApproval = () => {
  const { isAuthAvailable, status, user, signIn } = useCloudAuth();
  const backend = getCloudBackend();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState(() =>
    getAIDeviceApprovalCode(
      typeof window === "undefined" ? "" : window.location.search,
    ),
  );
  const [busy, setBusy] = useState(false);
  const [signInError, setSignInError] = useState("");
  const [approvalError, setApprovalError] = useState("");
  const [approved, setApproved] = useState(false);

  const unavailable = !isAuthAvailable || !backend.ai.isEnabled();
  const normalizedCode = useMemo(() => code.trim().toUpperCase(), [code]);

  const submitSignIn = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email.trim() || !password) {
      return;
    }
    setBusy(true);
    setSignInError("");
    try {
      await signIn(email.trim(), password);
      setPassword("");
    } catch (error) {
      setSignInError(
        error instanceof Error
          ? error.message
          : t("ai.proxy.devicePage.signInFailed"),
      );
    } finally {
      setBusy(false);
    }
  };

  const approve = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!normalizedCode || busy || approved) {
      return;
    }
    setBusy(true);
    setApprovalError("");
    try {
      await backend.ai.approveDeviceAuthorization(normalizedCode);
      setApproved(true);
    } catch {
      // Keep provider/auth details out of this public verification page.
      setApprovalError(t("ai.proxy.errors.deviceApproval"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="AIDeviceApproval">
      <section
        className="AIDeviceApproval__card"
        aria-labelledby="ai-device-title"
      >
        <h1 id="ai-device-title">{t("ai.proxy.devicePage.title")}</h1>
        <p>{t("ai.proxy.devicePage.intro")}</p>

        {unavailable && (
          <p className="AIDeviceApproval__message" role="alert">
            {t("ai.proxy.devicePage.unavailable")}
          </p>
        )}

        {!unavailable && status === "loading" && (
          <p className="AIDeviceApproval__message" role="status">
            {t("ai.proxy.devicePage.loading")}
          </p>
        )}

        {!unavailable && status !== "loading" && !user && (
          <form className="AIDeviceApproval__form" onSubmit={submitSignIn}>
            <h2>{t("ai.proxy.devicePage.signInTitle")}</h2>
            <label>
              <span>{t("cloud.auth.email")}</span>
              <input
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
            <label>
              <span>{t("cloud.auth.password")}</span>
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            {signInError && (
              <p className="AIDeviceApproval__error" role="alert">
                {signInError}
              </p>
            )}
            <button type="submit" disabled={busy}>
              {busy
                ? t("ai.proxy.devicePage.signingIn")
                : t("cloud.auth.signIn")}
            </button>
          </form>
        )}

        {!unavailable && status !== "loading" && user && !approved && (
          <form className="AIDeviceApproval__form" onSubmit={approve}>
            <p className="AIDeviceApproval__signedIn">
              {t("ai.proxy.devicePage.signedInAs", {
                email: user.email || user.id,
              })}
            </p>
            <label>
              <span>{t("ai.proxy.devicePage.codeLabel")}</span>
              <input
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                aria-describedby="ai-device-code-hint"
                required
              />
            </label>
            <small id="ai-device-code-hint">
              {t("ai.proxy.devicePage.codeHint")}
            </small>
            {approvalError && (
              <p className="AIDeviceApproval__error" role="alert">
                {approvalError}
              </p>
            )}
            <button type="submit" disabled={busy || !normalizedCode}>
              {busy
                ? t("ai.proxy.devicePage.approving")
                : t("ai.proxy.approveDevice")}
            </button>
          </form>
        )}

        {!unavailable && approved && (
          <p className="AIDeviceApproval__success" role="status">
            {t("ai.proxy.devicePage.approved")}
          </p>
        )}
      </section>
    </main>
  );
};

export default AIDeviceApproval;
