import { injectSingleFilePayload } from "./html";

import type { SingleFilePayload } from "./types";

export const SINGLE_FILE_RUNTIME_URL = "/single-file-runtime-template.txt";
export const SINGLE_FILE_WARNING_BYTES = 32 * 1024 * 1024;

export const createSingleFileBlob = (
  template: string,
  payload: SingleFilePayload,
): Blob =>
  new Blob([injectSingleFilePayload(template, payload)], {
    type: "text/html;charset=utf-8",
  });

export const fetchSingleFileRuntimeTemplate = async (
  fetchImpl: typeof fetch = fetch,
): Promise<string> => {
  const response = await fetchImpl(SINGLE_FILE_RUNTIME_URL, {
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(`Unable to load single-file runtime (${response.status})`);
  }
  return response.text();
};

export const normalizeSingleFileName = (name: string): string => {
  const trimmed = name.trim() || "calileon-board";
  const safeName = Array.from(trimmed.replace(/[<>:"/\\|?*]/g, "-"))
    .map((character) => (character.charCodeAt(0) < 32 ? "-" : character))
    .join("");
  return safeName.toLowerCase().endsWith(".html")
    ? safeName
    : `${safeName}.html`;
};
