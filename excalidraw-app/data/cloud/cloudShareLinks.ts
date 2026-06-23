const CLOUD_SHARE_HASH_PREFIX = "#cloud=";
const CLOUD_SHARE_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

export const getCloudShareTokenFromUrl = (href: string): string | null => {
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
  return CLOUD_SHARE_TOKEN_RE.test(token) ? token : null;
};

export const getCloudShareLink = (token: string): string => {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = `${CLOUD_SHARE_HASH_PREFIX}${window.encodeURIComponent(token)}`;
  return url.toString();
};
