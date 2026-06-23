/**
 * Unified backend error model (decision 0006 §6).
 *
 * Every adapter throws `BackendError` rather than leaking SDK-specific error
 * objects. `message` must already be sanitized (NFR-SEC) so it can be shown
 * directly to the user.
 */

import { t } from "@excalidraw/excalidraw/i18n";

export type BackendErrorCode =
  | "not-configured"
  | "unauthorized"
  | "forbidden"
  | "network"
  | "cors-or-proxy"
  | "quota-exceeded"
  | "payload-too-large"
  | "ai-auth-failed"
  | "ai-incompatible-response"
  | "realtime-unreachable";

export class BackendError extends Error {
  code: BackendErrorCode;
  recoverable: boolean;
  /** e.g. "切换本地保存" / "检查 Base URL" / "重新登录" */
  nextAction?: string;

  constructor(
    code: BackendErrorCode,
    message: string,
    opts?: { recoverable?: boolean; nextAction?: string },
  ) {
    super(message);
    this.name = "BackendError";
    this.code = code;
    this.recoverable = opts?.recoverable ?? true;
    this.nextAction = opts?.nextAction;
  }
}

/** Helper for Phase 0 cloud-only methods that have no local implementation. */
export const notConfigured = (): never => {
  throw new BackendError("not-configured", t("cloud.errors.notConfigured"), {
    recoverable: true,
    nextAction: t("cloud.errors.nextActionLocal"),
  });
};
