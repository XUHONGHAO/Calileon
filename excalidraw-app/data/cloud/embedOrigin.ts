const HTTP_ORIGIN_RE = /^https?:$/;

export const normalizeEmbedOrigin = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (!HTTP_ORIGIN_RE.test(url.protocol) || url.origin === "null") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
};

export const normalizeEmbedOrigins = (values: string[]): string[] => {
  const origins = new Set<string>();
  for (const value of values) {
    const origin = normalizeEmbedOrigin(value);
    if (origin) {
      origins.add(origin);
    }
  }
  return [...origins];
};

export const isEmbedOriginAllowed = (
  allowedOrigins: string[],
  origin: string,
): boolean => {
  const normalizedOrigin = normalizeEmbedOrigin(origin);
  if (!normalizedOrigin) {
    return false;
  }
  return allowedOrigins
    .map((allowed) => normalizeEmbedOrigin(allowed))
    .some((allowed) => allowed === normalizedOrigin);
};

export const getEmbedParentOrigin = (input: {
  referrer?: string;
  fallbackOrigin: string;
}): string | null => {
  if (input.referrer) {
    const referrerOrigin = normalizeEmbedOrigin(input.referrer);
    if (referrerOrigin) {
      return referrerOrigin;
    }
  }
  return normalizeEmbedOrigin(input.fallbackOrigin);
};
