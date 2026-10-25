import type { BrandLang } from "./content";

// Same keys the editor writes, so the brand pages open in the language and
// theme the user already picked in the app.
const THEME_STORAGE_KEY = "excalidraw-theme";
const LANG_STORAGE_KEY = "i18nextLng";

export type BrandTheme = "light" | "dark";

const readStorage = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

/** Maps any language tag to one of the two languages the pages ship. */
export const normalizeBrandLang = (
  value: string | null | undefined,
): BrandLang | null => {
  if (!value) {
    return null;
  }
  const tag = value.toLowerCase();
  if (tag.startsWith("zh")) {
    return "zh-CN";
  }
  if (tag.startsWith("en")) {
    return "en";
  }
  return null;
};

/**
 * Priority: explicit `?lang=` > the editor's stored language > browser
 * languages > English.
 */
export const resolveBrandLang = (
  search: string,
  storedLang: string | null,
  browserLangs: readonly string[],
): BrandLang => {
  const fromQuery = normalizeBrandLang(new URLSearchParams(search).get("lang"));
  if (fromQuery) {
    return fromQuery;
  }
  const fromStorage = normalizeBrandLang(storedLang);
  if (fromStorage) {
    return fromStorage;
  }
  for (const lang of browserLangs) {
    const normalized = normalizeBrandLang(lang);
    if (normalized) {
      return normalized;
    }
  }
  return "en";
};

/** Mirrors useHandleAppTheme: missing value means light, "system" follows OS. */
export const resolveBrandTheme = (
  storedTheme: string | null,
  prefersDark: boolean,
): BrandTheme => {
  if (storedTheme === "dark") {
    return "dark";
  }
  if (storedTheme === "system") {
    return prefersDark ? "dark" : "light";
  }
  return "light";
};

export const getInitialBrandLang = (): BrandLang =>
  resolveBrandLang(
    window.location.search,
    readStorage(LANG_STORAGE_KEY),
    navigator.languages?.length ? navigator.languages : [navigator.language],
  );

export const getStoredBrandTheme = () => readStorage(THEME_STORAGE_KEY);
