/**
 * Supabase → BackendError mapping (decision 0006 §6 / 0008 §4.1–4.2).
 *
 * Adapters never leak SDK error objects upward. Everything funnels through
 * here into the frozen `BackendError` model, with a sanitized, user-facing
 * `message` (NFR-SEC) and a stable `code` the UI can branch on.
 */

import { isAuthError } from "@supabase/supabase-js";
import { t } from "@excalidraw/excalidraw/i18n";

import { BackendError } from "../errors";

import type { BackendErrorCode } from "../errors";
import type { PostgrestError } from "@supabase/supabase-js";

/** Postgres "insufficient_privilege" — what an RLS denial surfaces as. */
const PG_INSUFFICIENT_PRIVILEGE = "42501";

const looksLikeNetworkError = (error: unknown): boolean => {
  // supabase-js wraps fetch failures in a TypeError ("Failed to fetch") or an
  // AuthRetryableFetchError with no HTTP status.
  if (error instanceof TypeError) {
    return true;
  }
  const name = (error as { name?: string } | null)?.name;
  return name === "AuthRetryableFetchError" || name === "FetchError";
};

/**
 * Maps a Supabase **auth** failure to a `BackendError`.
 * - bad credentials / unauthorized → `unauthorized`
 * - network/fetch failure → `network`
 * - anything else → `unauthorized` (auth context) with a generic message
 */
export const mapAuthError = (error: unknown): BackendError => {
  if (looksLikeNetworkError(error)) {
    return new BackendError("network", t("cloud.errors.network"), {
      recoverable: true,
      nextAction: t("cloud.errors.nextActionRetry"),
    });
  }

  if (isAuthError(error)) {
    const status = error.status;
    // 400 invalid_credentials / 401 / 403 → user-correctable auth failure.
    if (status === 400 || status === 401 || status === 403) {
      return new BackendError(
        "unauthorized",
        t("cloud.errors.invalidCredentials"),
        {
          recoverable: true,
          nextAction: t("cloud.errors.nextActionSignIn"),
        },
      );
    }
    if (status === 429) {
      return new BackendError("quota-exceeded", t("cloud.errors.rateLimited"), {
        recoverable: true,
        nextAction: t("cloud.errors.nextActionRetry"),
      });
    }
    return new BackendError("unauthorized", t("cloud.errors.signInFailed"), {
      recoverable: true,
      nextAction: t("cloud.errors.nextActionSignIn"),
    });
  }

  return new BackendError("unauthorized", t("cloud.errors.signInFailed"), {
    recoverable: true,
    nextAction: t("cloud.errors.nextActionSignIn"),
  });
};

/**
 * Maps a Supabase **data** (PostgREST) error to a `BackendError`.
 * - RLS denial (42501) → `forbidden`
 * - network/fetch failure → `network`
 * - anything else → `network` (treated as recoverable transient failure so the
 *   cloud-save degrade path keeps local data intact, decision 0008 §6)
 */
export const mapDataError = (error: unknown): BackendError => {
  if (looksLikeNetworkError(error)) {
    return new BackendError(
      "network",
      t("cloud.errors.cloudConnectionFailed"),
      {
        recoverable: true,
        nextAction: t("cloud.errors.nextActionLocal"),
      },
    );
  }

  const pgError = error as Partial<PostgrestError> | null;
  const code = pgError?.code;

  if (code === PG_INSUFFICIENT_PRIVILEGE) {
    return new BackendError("forbidden", t("cloud.errors.forbiddenScene"), {
      recoverable: false,
      nextAction: t("cloud.errors.nextActionSignIn"),
    });
  }

  let mapped: BackendErrorCode = "network";
  let message = t("cloud.errors.cloudOperationFailed");
  let nextAction = t("cloud.errors.nextActionLocal");
  // PostgREST signals auth problems via the HTTP layer; surface as unauthorized
  // so the UI can prompt a re-login rather than a silent local fallback.
  if (code === "401" || code === "PGRST301") {
    mapped = "unauthorized";
    message = t("cloud.errors.sessionExpired");
    nextAction = t("cloud.errors.nextActionSignIn");
  }

  return new BackendError(mapped, message, {
    recoverable: true,
    nextAction,
  });
};

/**
 * `comments-<code>` exceptions raised by the comment RPCs
 * (schema_comments.sql) → BackendError with the comment's own wording.
 */
const COMMENT_ERRORS: Record<
  string,
  {
    code: BackendErrorCode;
    key: Parameters<typeof t>[0];
    recoverable: boolean;
  }
> = {
  "comments-unauthorized": {
    code: "unauthorized",
    key: "comments.errors.unauthorized",
    recoverable: true,
  },
  "comments-forbidden": {
    code: "forbidden",
    key: "comments.errors.forbidden",
    recoverable: false,
  },
  "comments-unsupported": {
    code: "not-configured",
    key: "comments.errors.unsupported",
    recoverable: false,
  },
  "comments-not-found": {
    code: "conflict",
    key: "comments.errors.notFound",
    recoverable: true,
  },
  "comments-quoted-missing": {
    code: "conflict",
    key: "comments.errors.quotedMissing",
    recoverable: true,
  },
  "comments-empty": {
    code: "conflict",
    key: "comments.errors.empty",
    recoverable: true,
  },
  "comments-invalid": {
    code: "conflict",
    key: "comments.errors.invalid",
    recoverable: true,
  },
  "comments-too-long": {
    code: "payload-too-large",
    key: "comments.errors.tooLong",
    recoverable: true,
  },
  "comments-rate-limited": {
    code: "quota-exceeded",
    key: "comments.errors.rateLimited",
    recoverable: true,
  },
  "comments-scene-full": {
    code: "quota-exceeded",
    key: "comments.errors.sceneFull",
    recoverable: false,
  },
};

export const COMMENT_ERROR_CODES = Object.keys(COMMENT_ERRORS);

export const mapCommentError = (error: unknown): BackendError => {
  const message = (error as { message?: unknown } | null)?.message;
  const match =
    typeof message === "string" ? /comments-[a-z-]+/.exec(message) : null;
  const known = match ? COMMENT_ERRORS[match[0]] : undefined;
  if (known) {
    return new BackendError(known.code, t(known.key), {
      recoverable: known.recoverable,
      nextAction:
        known.code === "unauthorized"
          ? t("cloud.errors.nextActionSignIn")
          : undefined,
    });
  }
  const mapped = mapDataError(error);
  if (mapped.code === "network") {
    // the cloud-save wording ("switch to local saving") does not fit here
    return new BackendError("network", t("comments.errors.network"), {
      recoverable: true,
      nextAction: t("cloud.errors.nextActionRetry"),
    });
  }
  return mapped;
};

export const mapStorageError = (error: unknown): BackendError => {
  if (looksLikeNetworkError(error)) {
    return new BackendError(
      "network",
      t("cloud.errors.assetConnectionFailed"),
      {
        recoverable: true,
        nextAction: t("cloud.errors.nextActionLocal"),
      },
    );
  }

  const storageError = error as {
    statusCode?: string | number;
    status?: string | number;
  } | null;
  const status = Number(storageError?.statusCode ?? storageError?.status);

  if (status === 401) {
    return new BackendError("unauthorized", t("cloud.errors.sessionExpired"), {
      recoverable: true,
      nextAction: t("cloud.errors.nextActionSignIn"),
    });
  }

  if (status === 403) {
    return new BackendError("forbidden", t("cloud.errors.forbiddenAsset"), {
      recoverable: false,
      nextAction: t("cloud.errors.nextActionSignIn"),
    });
  }

  if (status === 413) {
    return new BackendError(
      "payload-too-large",
      t("cloud.errors.assetTooLarge"),
      {
        recoverable: true,
        nextAction: t("cloud.errors.nextActionLocal"),
      },
    );
  }

  if (status === 429) {
    return new BackendError("quota-exceeded", t("cloud.errors.rateLimited"), {
      recoverable: true,
      nextAction: t("cloud.errors.nextActionRetry"),
    });
  }

  return new BackendError("network", t("cloud.errors.assetOperationFailed"), {
    recoverable: true,
    nextAction: t("cloud.errors.nextActionLocal"),
  });
};
