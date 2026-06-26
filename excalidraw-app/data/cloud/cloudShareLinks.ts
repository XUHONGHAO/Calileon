const CLOUD_SHARE_HASH_PREFIX = "#cloud=";
const CLOUD_SHARE_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

export interface CloudShareLinkAccess {
  token: string;
  key: string | null;
}

export const getCloudShareAccessFromUrl = (
  href: string,
): CloudShareLinkAccess | null => {
  let hash: string;
  try {
    hash = new URL(href).hash;
  } catch {
    return null;
  }

  if (!hash.startsWith(CLOUD_SHARE_HASH_PREFIX)) {
    return null;
  }

  const token = window.decodeURIComponent(
    hash.slice(CLOUD_SHARE_HASH_PREFIX.length),
  );
  const parts = token.split(",");
  if (
    (parts.length !== 1 && parts.length !== 2) ||
    !CLOUD_SHARE_TOKEN_RE.test(parts[0]) ||
    (parts[1] !== undefined && !CLOUD_SHARE_TOKEN_RE.test(parts[1]))
  ) {
    return null;
  }
  return {
    token: parts[0],
    key: parts[1] ?? null,
  };
};

export const getCloudShareTokenFromUrl = (href: string): string | null =>
  getCloudShareAccessFromUrl(href)?.token ?? null;

export const getCloudShareLink = (token: string, key?: string): string => {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = `${CLOUD_SHARE_HASH_PREFIX}${window.encodeURIComponent(token)}${
    key ? `,${window.encodeURIComponent(key)}` : ""
  }`;
  return url.toString();
};
