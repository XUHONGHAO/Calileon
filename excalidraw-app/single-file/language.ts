import { localeCatalog, resolveLanguage } from "@excalidraw/excalidraw/i18n";

import type { Language } from "@excalidraw/excalidraw/i18n";

export const SINGLE_FILE_LANGUAGE_STORAGE_KEY = "calileon-single-file-language";

/**
 * Normalizes a stored/declared code into a `Language` the editor can load.
 *
 * Resolution order: an exact catalog match, then a catalog locale that extends
 * the code ("zh" → "zh-CN"), then a catalog locale the code extends ("en-GB" →
 * "en"). Codes absent from the catalog are still accepted as-is, because a
 * single-file board may have been exported in a locale this build does not
 * ship; `setLanguage` falls back to English data when a locale file is missing.
 */
const findLanguage = (code?: string | null): Language | null => {
  const normalized = code?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const known =
    localeCatalog.find((lang) => lang.code.toLowerCase() === normalized) ??
    localeCatalog.find((lang) =>
      lang.code.toLowerCase().startsWith(`${normalized}-`),
    ) ??
    localeCatalog.find((lang) =>
      normalized.startsWith(`${lang.code.toLowerCase()}-`),
    );
  return resolveLanguage(known?.code ?? normalized);
};

const readStoredLanguage = (storage: Storage | null): Language | null => {
  try {
    return findLanguage(storage?.getItem(SINGLE_FILE_LANGUAGE_STORAGE_KEY));
  } catch {
    return null;
  }
};

const readBrowserLanguage = (): Language | null => {
  if (typeof navigator === "undefined") {
    return null;
  }
  const candidates = [
    ...(navigator.languages ?? []),
    navigator.language,
  ].filter((code): code is string => typeof code === "string" && !!code);
  for (const candidate of candidates) {
    const match = findLanguage(candidate);
    if (match) {
      return match;
    }
  }
  return null;
};

/**
 * Resolves the language of a single-file board.
 *
 * Priority: an explicit override (the reader switched language in the exported
 * page), then a previously stored preference, then the language the board was
 * exported in, then the browser language, then English.
 */
export const resolveSingleFileLanguage = ({
  payloadLanguage,
  storage = typeof localStorage === "undefined" ? null : localStorage,
  override,
}: {
  payloadLanguage?: string | null;
  storage?: Storage | null;
  override?: string | null;
}): Language => {
  return (
    findLanguage(override) ??
    readStoredLanguage(storage) ??
    findLanguage(payloadLanguage) ??
    readBrowserLanguage() ??
    resolveLanguage(undefined)
  );
};

export const persistSingleFileLanguage = (
  code: string,
  storage: Storage | null = typeof localStorage === "undefined"
    ? null
    : localStorage,
) => {
  try {
    storage?.setItem(SINGLE_FILE_LANGUAGE_STORAGE_KEY, code);
  } catch {
    // Storage may be unavailable (file:// with blocked storage); the board
    // still works with the in-memory language.
  }
};
