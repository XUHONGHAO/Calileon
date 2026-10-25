import { BRAND_PAGE_URLS } from "./routes";
import { createBrandLogo } from "./logo";

import type {
  BrandCard,
  BrandCopy,
  BrandLang,
  BrandPageId,
  BrandSection,
} from "./content";

type Child = Node | string | null | undefined | false;

/**
 * Tiny element helper. Text always goes through text nodes, never innerHTML,
 * so copy can't inject markup.
 */
const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    el.setAttribute(name, value);
  }
  for (const child of children) {
    if (child) {
      el.append(child);
    }
  }
  return el;
};

const renderCard = (card: BrandCard) =>
  h("li", { class: "brand-card" }, [
    h("h3", { class: "brand-card__title" }, [card.title]),
    h("p", { class: "brand-card__body" }, [card.body]),
  ]);

const renderSection = (section: BrandSection) => {
  const headingId = `${section.id}-title`;
  return h(
    "section",
    {
      class: "brand-section",
      id: section.id,
      "aria-labelledby": headingId,
    },
    [
      h("p", { class: "brand-eyebrow" }, [section.eyebrow]),
      h("h2", { class: "brand-section__title", id: headingId }, [
        section.title,
      ]),
      h("p", { class: "brand-section__lead" }, [section.lead]),
      h("ul", { class: "brand-grid" }, section.cards.map(renderCard)),
      section.note && h("p", { class: "brand-note" }, [section.note]),
      section.link &&
        h("a", { class: "brand-link", href: section.link.href }, [
          section.link.label,
        ]),
    ],
  );
};

export interface RenderBrandPageOptions {
  copy: BrandCopy;
  lang: BrandLang;
  page: BrandPageId;
  onToggleLang: () => void;
}

export const renderBrandPage = (
  root: HTMLElement,
  { copy, lang, page, onToggleLang }: RenderBrandPageOptions,
) => {
  const { chrome } = copy;
  const content = copy.pages[page];

  document.documentElement.lang = lang;
  document.title = content.documentTitle;
  document
    .querySelector('meta[name="description"]')
    ?.setAttribute("content", content.description);

  const navLink = (target: BrandPageId, label: string) => {
    const link = h(
      "a",
      { class: "brand-nav__link", href: BRAND_PAGE_URLS[target] },
      [label],
    );
    if (target === page) {
      link.setAttribute("aria-current", "page");
    }
    return link;
  };

  const langButton = h(
    "button",
    {
      type: "button",
      class: "brand-button brand-button--ghost",
      lang: lang === "en" ? "zh-CN" : "en",
      "aria-label": chrome.switchLanguageLabel,
    },
    [chrome.switchLanguage],
  );
  langButton.addEventListener("click", onToggleLang);

  const header = h("header", { class: "brand-header" }, [
    h(
      "a",
      { class: "brand-logo", href: BRAND_PAGE_URLS.app },
      createBrandLogo(),
    ),
    h("nav", { class: "brand-nav", "aria-label": chrome.navLabel }, [
      navLink("plus", chrome.navPlus),
      navLink("security", chrome.navSecurity),
    ]),
    h("div", { class: "brand-header__actions" }, [
      langButton,
      h(
        "a",
        {
          class: "brand-button brand-button--primary",
          href: BRAND_PAGE_URLS.app,
        },
        [chrome.openApp],
      ),
    ]),
  ]);

  const hero = h("section", { class: "brand-hero" }, [
    h("p", { class: "brand-eyebrow" }, [content.hero.eyebrow]),
    h("h1", { class: "brand-hero__title" }, [content.hero.title]),
    h("p", { class: "brand-hero__lead" }, [content.hero.lead]),
    h("div", { class: "brand-hero__actions" }, [
      h(
        "a",
        {
          class: "brand-button brand-button--primary brand-button--lg",
          href: BRAND_PAGE_URLS.app,
        },
        [content.hero.primary],
      ),
      h(
        "a",
        {
          class: "brand-button brand-button--secondary brand-button--lg",
          href: content.hero.secondary.href,
        },
        [content.hero.secondary.label],
      ),
    ]),
  ]);

  const closing = h("section", { class: "brand-closing" }, [
    h("h2", { class: "brand-closing__title" }, [content.closing.title]),
    h("p", { class: "brand-closing__lead" }, [content.closing.lead]),
    h(
      "a",
      {
        class: "brand-button brand-button--primary brand-button--lg",
        href: BRAND_PAGE_URLS.app,
      },
      [content.closing.cta],
    ),
  ]);

  root.replaceChildren(
    h("a", { class: "brand-skip", href: "#main" }, [chrome.skipToContent]),
    header,
    h("main", { id: "main", class: "brand-main", tabindex: "-1" }, [
      hero,
      ...content.sections.map(renderSection),
      closing,
    ]),
    h("footer", { class: "brand-footer" }, [chrome.footer]),
  );
};
