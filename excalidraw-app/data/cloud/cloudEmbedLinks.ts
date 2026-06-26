const CLOUD_EMBED_HASH_PREFIX = "#embed=";
const CLOUD_EMBED_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

export interface CloudEmbedLinkAccess {
  token: string;
  key: string | null;
}

export const getCloudEmbedAccessFromUrl = (
  href: string,
): CloudEmbedLinkAccess | null => {
  let hash: string;
  try {
    hash = new URL(href).hash;
  } catch {
    return null;
  }

  if (!hash.startsWith(CLOUD_EMBED_HASH_PREFIX)) {
    return null;
  }

  const token = window.decodeURIComponent(
    hash.slice(CLOUD_EMBED_HASH_PREFIX.length),
  );
  const parts = token.split(",");
  if (
    (parts.length !== 1 && parts.length !== 2) ||
    !CLOUD_EMBED_TOKEN_RE.test(parts[0]) ||
    (parts[1] !== undefined && !CLOUD_EMBED_TOKEN_RE.test(parts[1]))
  ) {
    return null;
  }
  return {
    token: parts[0],
    key: parts[1] ?? null,
  };
};

export const getCloudEmbedTokenFromUrl = (href: string): string | null =>
  getCloudEmbedAccessFromUrl(href)?.token ?? null;

export const getCloudEmbedLink = (token: string, key?: string): string => {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = `${CLOUD_EMBED_HASH_PREFIX}${window.encodeURIComponent(token)}${
    key ? `,${window.encodeURIComponent(key)}` : ""
  }`;
  return url.toString();
};

export const getCloudEmbedIframeCode = (input: {
  token: string;
  key?: string;
  title: string;
  width?: string;
  height?: string;
}): string => {
  const src = getCloudEmbedLink(input.token, input.key);
  const title = input.title.replace(/"/g, "&quot;");
  const width = input.width ?? "100%";
  const height = input.height ?? "600";
  return `<iframe src="${src}" title="${title}" width="${width}" height="${height}" style="border:0" allow="clipboard-read; clipboard-write"></iframe>`;
};

export const getCloudEmbedHostSnippet = (input: { iframeId: string }): string =>
  [
    "const iframe = document.getElementById(",
    JSON.stringify(input.iframeId),
    ");",
    "\nconst send = (name, payload) => iframe.contentWindow.postMessage({",
    "\n  source: 'excalidraw-embed',",
    "\n  version: 1,",
    "\n  type: 'command',",
    "\n  name,",
    "\n  requestId: crypto.randomUUID?.() ?? String(Date.now()),",
    "\n  payload,",
    "\n}, new URL(iframe.src).origin);",
    "\nwindow.addEventListener('message', (event) => {",
    "\n  if (event.data?.source === 'excalidraw-embed' && event.data?.version === 1) {",
    "\n    console.log('Excalidraw embed:', event.data);",
    "\n  }",
    "\n});",
  ].join("");
