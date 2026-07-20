const REDACTED = "[REDACTED]";
const REDACTED_CONTENT = "[REDACTED_VAULT_CONTENT]";

const VAULT_FRAGMENT_RE = /#vault=[^\s"'<>)]*/gi;
const ENCODED_VAULT_FRAGMENT_RE = /%23vault%3D[^\s"'<>)]*/gi;
const VAULT_SECRET_ASSIGNMENT_RE =
  /\b(rootKey|roomKey|invitationCapability|capability|encryptionKey|decryptionKey|cap|key)=([A-Za-z0-9_-]+)/gi;
const VAULT_SECRET_TOKEN_RE = /\b[A-Za-z0-9_-]{43}\b/g;

const STRONG_SECRET_KEYS = new Set([
  "rootkey",
  "roomkey",
  "invitationcapability",
  "authorization",
  "cookie",
  "set-cookie",
  "encryptionkey",
  "decryptionkey",
  "fragment",
]);

const VAULT_CONTEXT_SECRET_KEYS = new Set(["key", "cap", "capability"]);
const VAULT_CONTENT_KEYS = new Set([
  "payload",
  "elements",
  "files",
  "appstate",
  "scene",
  "plaintext",
  "dataurl",
  "body",
  "requestbody",
  "responsebody",
  "ciphertext",
  "encrypteddata",
  "message",
  "value",
  "stack",
]);

const VAULT_METADATA_KEYS = new Set([
  "vaultid",
  "version",
  "protocolversion",
  "messagetype",
  "messageid",
  "sendersessionid",
  "sequence",
  "generation",
  "ciphertextbytes",
  "operation",
  "code",
  "recoverable",
  "status",
  "state",
  "reason",
]);

const sanitizeVaultMetadataValue = (key: string, value: unknown): unknown => {
  if (typeof value !== "string") {
    return value;
  }
  if (
    (key === "vaultid" || key === "messageid" || key === "sendersessionid") &&
    !/^[0-9a-f-]{36}$/i.test(value)
  ) {
    return REDACTED_CONTENT;
  }
  if (key === "code" && !/^VAULT_[A-Z0-9_]+$/.test(value)) {
    return REDACTED_CONTENT;
  }
  if (
    (key === "operation" ||
      key === "status" ||
      key === "state" ||
      key === "reason" ||
      key === "messagetype") &&
    !/^[a-z0-9_.:-]{1,96}$/.test(value)
  ) {
    return REDACTED_CONTENT;
  }
  return redactVaultString(value, true);
};

export const stripUrlFragment = (value: string): string =>
  value.replace(/#.*$/, "");

export const redactVaultString = (
  value: string,
  vaultContext = false,
): string => {
  let redacted = value
    .replace(VAULT_FRAGMENT_RE, "#vault=[REDACTED]")
    .replace(ENCODED_VAULT_FRAGMENT_RE, "%23vault%3D%5BREDACTED%5D")
    .replace(
      VAULT_SECRET_ASSIGNMENT_RE,
      (_match, field: string) => `${field}=${REDACTED}`,
    );
  if (vaultContext) {
    redacted = redacted.replace(VAULT_SECRET_TOKEN_RE, REDACTED);
  }
  return redacted;
};

const containsVaultIndicator = (
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): boolean => {
  if (depth > 6 || value == null) {
    return false;
  }
  if (typeof value === "string") {
    return /#vault=|%23vault%3D|\bvaultId\b/i.test(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (value instanceof Error) {
    return containsVaultIndicator(value.message, depth + 1, seen);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsVaultIndicator(item, depth + 1, seen));
  }
  return Object.entries(value).some(
    ([key, item]) =>
      key.toLowerCase() === "vaultid" ||
      containsVaultIndicator(item, depth + 1, seen),
  );
};

const redactValue = (
  value: unknown,
  vaultContext: boolean,
  depth: number,
  seen: WeakMap<object, unknown>,
): unknown => {
  if (depth > 12 || value == null) {
    return value;
  }
  if (typeof value === "string") {
    return vaultContext ? REDACTED_CONTENT : redactVaultString(value);
  }
  if (typeof value !== "object") {
    return value;
  }
  const existing = seen.get(value);
  if (existing) {
    return existing;
  }

  const nextVaultContext = vaultContext || containsVaultIndicator(value);
  if (value instanceof Error) {
    const sanitizedError: Record<string, unknown> = {
      name: value.name,
      message: nextVaultContext
        ? REDACTED_CONTENT
        : redactVaultString(value.message),
    };
    seen.set(value, sanitizedError);
    if (value.stack) {
      sanitizedError.stack = nextVaultContext
        ? REDACTED_CONTENT
        : redactVaultString(value.stack);
    }
    return sanitizedError;
  }
  if (Array.isArray(value)) {
    const sanitizedArray: unknown[] = [];
    seen.set(value, sanitizedArray);
    for (const item of value) {
      sanitizedArray.push(redactValue(item, nextVaultContext, depth + 1, seen));
    }
    return sanitizedArray;
  }

  const sanitizedObject: Record<string, unknown> = {};
  seen.set(value, sanitizedObject);
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (
      STRONG_SECRET_KEYS.has(normalizedKey) ||
      (nextVaultContext && VAULT_CONTEXT_SECRET_KEYS.has(normalizedKey))
    ) {
      sanitizedObject[key] = REDACTED;
      continue;
    }
    if (
      nextVaultContext &&
      VAULT_CONTENT_KEYS.has(normalizedKey) &&
      !VAULT_METADATA_KEYS.has(normalizedKey)
    ) {
      sanitizedObject[key] = REDACTED_CONTENT;
      continue;
    }
    if (
      nextVaultContext &&
      typeof item === "string" &&
      (normalizedKey === "url" ||
        normalizedKey === "from" ||
        normalizedKey === "to")
    ) {
      sanitizedObject[key] = stripUrlFragment(redactVaultString(item, true));
      continue;
    }
    if (nextVaultContext && VAULT_METADATA_KEYS.has(normalizedKey)) {
      sanitizedObject[key] = sanitizeVaultMetadataValue(normalizedKey, item);
      continue;
    }
    sanitizedObject[key] = redactValue(item, nextVaultContext, depth + 1, seen);
  }
  return sanitizedObject;
};

const isCurrentVaultRoute = (): boolean => {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return new URLSearchParams(window.location.hash.slice(1)).has("vault");
  } catch {
    return window.location.hash.startsWith("#vault=");
  }
};

export const sanitizeVaultTelemetryValue = <T>(
  value: T,
  forceVaultContext = false,
): T =>
  redactValue(
    value,
    forceVaultContext || containsVaultIndicator(value),
    0,
    new WeakMap(),
  ) as T;

export const sanitizeSentryEventForTelemetry = <T extends object>(
  event: T,
): T => {
  const sanitized = sanitizeVaultTelemetryValue(event, isCurrentVaultRoute());
  const request = (sanitized as { request?: { url?: string } }).request;
  if (request?.url) {
    request.url = stripUrlFragment(request.url);
  }
  return sanitized;
};

export const sanitizeSentryBreadcrumbForTelemetry = <T extends object>(
  breadcrumb: T,
): T => sanitizeVaultTelemetryValue(breadcrumb, isCurrentVaultRoute());

export const getErrorReportLocalStorage = (
  storage: Storage,
  isVaultRoute: boolean,
): string => {
  if (isVaultRoute) {
    return JSON.stringify({ vault: REDACTED_CONTENT });
  }
  const values: Record<string, unknown> = {};
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key == null) {
      continue;
    }
    const value = storage.getItem(key) ?? "";
    try {
      values[key] = JSON.parse(value);
    } catch {
      values[key] = value;
    }
  }
  return JSON.stringify(values);
};
