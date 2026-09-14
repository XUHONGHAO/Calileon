export type GatewayErrorCode =
  | "AI_GATEWAY_DISABLED"
  | "AI_GATEWAY_NOT_READY"
  | "AI_GATEWAY_UNAUTHORIZED"
  | "AI_GATEWAY_FORBIDDEN"
  | "AI_GATEWAY_RATE_LIMITED"
  | "AI_GATEWAY_QUOTA_EXCEEDED"
  | "AI_GATEWAY_CONCURRENCY_EXCEEDED"
  | "AI_GATEWAY_ROUTE_NOT_FOUND"
  | "AI_GATEWAY_OPERATION_NOT_ALLOWED"
  | "AI_GATEWAY_INVALID_REQUEST"
  | "AI_GATEWAY_REQUEST_TOO_LARGE"
  | "AI_GATEWAY_CREDENTIAL_UNAVAILABLE"
  | "AI_GATEWAY_UPSTREAM_UNAVAILABLE"
  | "AI_GATEWAY_AUDIT_DISABLED"
  | "AI_GATEWAY_DEVICE_PENDING"
  | "AI_GATEWAY_DEVICE_EXPIRED"
  | "AI_GATEWAY_RESERVATION_EXPIRED"
  | "AI_GATEWAY_INTERNAL_ERROR";

const DEFAULT_MESSAGES: Record<GatewayErrorCode, string> = {
  AI_GATEWAY_DISABLED: "The managed AI gateway is disabled.",
  AI_GATEWAY_NOT_READY: "The managed AI gateway is not ready.",
  AI_GATEWAY_UNAUTHORIZED: "Authentication is required.",
  AI_GATEWAY_FORBIDDEN: "The request is not allowed.",
  AI_GATEWAY_RATE_LIMITED: "Too many requests.",
  AI_GATEWAY_QUOTA_EXCEEDED: "The AI quota has been exhausted.",
  AI_GATEWAY_CONCURRENCY_EXCEEDED: "Too many AI requests are active.",
  AI_GATEWAY_ROUTE_NOT_FOUND: "The managed model route was not found.",
  AI_GATEWAY_OPERATION_NOT_ALLOWED: "The model operation is not allowed.",
  AI_GATEWAY_INVALID_REQUEST: "The gateway request is invalid.",
  AI_GATEWAY_REQUEST_TOO_LARGE: "The gateway request body is too large.",
  AI_GATEWAY_CREDENTIAL_UNAVAILABLE: "The provider credential is unavailable.",
  AI_GATEWAY_UPSTREAM_UNAVAILABLE: "The managed provider is unavailable.",
  AI_GATEWAY_AUDIT_DISABLED: "Content audit is not enabled for this account.",
  AI_GATEWAY_DEVICE_PENDING: "Device authorization is pending.",
  AI_GATEWAY_DEVICE_EXPIRED: "Device authorization has expired.",
  AI_GATEWAY_RESERVATION_EXPIRED:
    "The AI request reservation expired before dispatch.",
  AI_GATEWAY_INTERNAL_ERROR:
    "The managed AI gateway encountered an internal error.",
};

export class GatewayError extends Error {
  constructor(
    public readonly code: GatewayErrorCode,
    public readonly status: number,
    options: { message?: string; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(options.message || DEFAULT_MESSAGES[code], { cause: options.cause });
    this.name = "GatewayError";
    this.retryable = options.retryable ?? status >= 500;
  }

  public readonly retryable: boolean;
}

export const toGatewayError = (error: unknown) =>
  error instanceof GatewayError
    ? error
    : new GatewayError("AI_GATEWAY_INTERNAL_ERROR", 500, { cause: error });

export const createGatewayErrorBody = (
  error: GatewayError,
  requestId: string,
) => ({
  error: {
    code: error.code,
    message: error.message,
    requestId,
    retryable: error.retryable,
  },
});
