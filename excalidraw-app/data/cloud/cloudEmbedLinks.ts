const CLOUD_EMBED_HASH_PREFIX = "#embed=";
const CLOUD_EMBED_TOKEN_RE = /^[A-Za-z0-9_-]+$/;

export const getCloudEmbedTokenFromUrl = (href: string): string | null => {
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
  return CLOUD_EMBED_TOKEN_RE.test(token) ? token : null;
};

export const getCloudEmbedLink = (token: string): string => {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = `${CLOUD_EMBED_HASH_PREFIX}${window.encodeURIComponent(token)}`;
  return url.toString();
};

export const getCloudEmbedIframeCode = (input: {
  token: string;
  title: string;
  width?: string;
  height?: string;
}): string => {
  const src = getCloudEmbedLink(input.token);
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
