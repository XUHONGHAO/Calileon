/**
 * Unified backend error model (decision 0006 §6).
 *
 * Every adapter throws `BackendError` rather than leaking SDK-specific error
 * objects. `message` must already be sanitized (NFR-SEC) so it can be shown
 * directly to the user.
 */

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
export const notConfigured = (capability: string): never => {
  throw new BackendError(
    "not-configured",
    `${capability} 未配置后端（当前为本地模式）`,
    { recoverable: true, nextAction: "切换本地保存" },
  );
};
