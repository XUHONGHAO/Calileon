import { BRAND_COPY } from "./content";
import {
  getInitialBrandLang,
  getStoredBrandTheme,
  resolveBrandTheme,
} from "./preferences";
import { renderBrandPage } from "./render";

import "./brandPages.scss";

import type { BrandLang, BrandPageId } from "./content";

const isBrandPageId = (value: string | undefined): value is BrandPageId =>
  value === "plus" || value === "security";

const applyTheme = () => {
  const prefersDark =
    window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const theme = resolveBrandTheme(getStoredBrandTheme(), prefersDark);
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.body.classList.toggle("theme--dark", theme === "dark");
  document.body.classList.toggle("theme--light", theme === "light");
};

const boot = () => {
  const root = document.getElementById("brand-root");
  const page = document.body.dataset.brandPage;
  if (!root || !isBrandPageId(page)) {
    return;
  }

  applyTheme();
  window
    .matchMedia?.("(prefers-color-scheme: dark)")
    .addEventListener?.("change", applyTheme);

  let lang: BrandLang = getInitialBrandLang();

  const render = () =>
    renderBrandPage(root, {
      copy: BRAND_COPY[lang],
      lang,
      page,
      onToggleLang: () => {
        lang = lang === "en" ? "zh-CN" : "en";
        // keep the choice in the URL only; the editor's language setting is
        // the user's, not ours to overwrite
        const params = new URLSearchParams(window.location.search);
        params.set("lang", lang);
        window.history.replaceState(
          null,
          "",
          `${window.location.pathname}?${params}${window.location.hash}`,
        );
        render();
        root.querySelector<HTMLButtonElement>(".brand-header button")?.focus();
      },
    });

  render();
};

boot();
