export type AIProxyErrorCode =
  | "AI_PROXY_TARGET_MISSING"
  | "AI_PROXY_TARGET_INVALID"
  | "AI_PROXY_ORIGIN_DENIED"
  | "AI_PROXY_TOKEN_REQUIRED"
  | "AI_PROXY_TOKEN_INVALID"
  | "AI_PROXY_TARGET_BLOCKED"
  | "AI_PROXY_METHOD_NOT_ALLOWED"
  | "AI_PROXY_REQUEST_TOO_LARGE"
  | "AI_PROXY_DNS_FAILED"
  | "AI_PROXY_UPSTREAM_UNREACHABLE"
  | "AI_PROXY_UPSTREAM_PROTOCOL_ERROR"
  | "AI_PROXY_REDIRECT_REQUIRES_FINAL_URL"
  | "AI_PROXY_REDIRECT_LIMIT"
  | "AI_PROXY_TIMEOUT"
  | "AI_PROXY_INTERNAL_ERROR";

const DEFAULT_MESSAGES: Record<AIProxyErrorCode, string> = {
  AI_PROXY_TARGET_MISSING: "The proxy target is missing.",
  AI_PROXY_TARGET_INVALID: "The proxy target is invalid.",
  AI_PROXY_ORIGIN_DENIED: "The request origin is not allowed.",
  AI_PROXY_TOKEN_REQUIRED: "The proxy access token is required.",
  AI_PROXY_TOKEN_INVALID: "The proxy access token is invalid.",
  AI_PROXY_TARGET_BLOCKED: "The proxy rejected the target.",
  AI_PROXY_METHOD_NOT_ALLOWED: "The request method is not allowed.",
  AI_PROXY_REQUEST_TOO_LARGE: "The request body is too large.",
  AI_PROXY_DNS_FAILED: "The target hostname could not be resolved.",
  AI_PROXY_UPSTREAM_UNREACHABLE: "The provider could not be reached.",
  AI_PROXY_UPSTREAM_PROTOCOL_ERROR: "The provider connection failed.",
  AI_PROXY_REDIRECT_REQUIRES_FINAL_URL:
    "The provider redirected a request body. Configure the final provider URL.",
  AI_PROXY_REDIRECT_LIMIT: "The provider redirected too many times.",
  AI_PROXY_TIMEOUT: "The provider request timed out.",
  AI_PROXY_INTERNAL_ERROR: "The proxy encountered an internal error.",
};

export class AIProxyError extends Error {
  public readonly code: AIProxyErrorCode;
  public readonly status: number;
  public readonly retryable: boolean;

  constructor(
    code: AIProxyErrorCode,
    status: number,
    options: { message?: string; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(options.message || DEFAULT_MESSAGES[code], { cause: options.cause });
    this.name = "AIProxyError";
    this.code = code;
    this.status = status;
    this.retryable = options.retryable ?? status >= 500;
  }
}

export const toAIProxyError = (error: unknown): AIProxyError => {
  if (error instanceof AIProxyError) {
    return error;
  }

  return new AIProxyError("AI_PROXY_INTERNAL_ERROR", 500, { cause: error });
};

export const createAIProxyErrorBody = (
  error: AIProxyError,
  requestId: string,
) => ({
  error: {
    code: error.code,
    message: error.message,
    requestId,
    retryable: error.retryable,
  },
});
