import { BRAND_COPY, BRAND_LANGS } from "./content";
import {
  normalizeBrandLang,
  resolveBrandLang,
  resolveBrandTheme,
} from "./preferences";
import { renderBrandPage } from "./render";
import { BRAND_PAGE_URLS } from "./routes";

import type { BrandCopy, BrandPageId } from "./content";

const PAGES: BrandPageId[] = ["plus", "security"];

const shape = (copy: BrandCopy) =>
  PAGES.map((page) =>
    copy.pages[page].sections.map((section) => ({
      id: section.id,
      cards: section.cards.length,
      note: !!section.note,
      link: section.link?.href ?? null,
    })),
  );

describe("brand page copy", () => {
  it("keeps both languages structurally identical", () => {
    expect(shape(BRAND_COPY["zh-CN"])).toEqual(shape(BRAND_COPY.en));
  });

  it("has no empty strings", () => {
    const empty: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (typeof value === "string") {
        if (!value.trim()) {
          empty.push(path);
        }
      } else if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) {
          walk(child, `${path}.${key}`);
        }
      }
    };
    for (const lang of BRAND_LANGS) {
      walk(BRAND_COPY[lang], lang);
    }
    expect(empty).toEqual([]);
  });

  it("only links to same-origin brand routes", () => {
    const allowed = new Set<string>(Object.values(BRAND_PAGE_URLS));
    for (const lang of BRAND_LANGS) {
      for (const page of PAGES) {
        const content = BRAND_COPY[lang].pages[page];
        expect(allowed.has(content.hero.secondary.href)).toBe(true);
        for (const section of content.sections) {
          if (section.link) {
            expect(allowed.has(section.link.href)).toBe(true);
          }
        }
      }
    }
  });
});

describe("brand page preferences", () => {
  it("normalizes language tags", () => {
    expect(normalizeBrandLang("zh-TW")).toBe("zh-CN");
    expect(normalizeBrandLang("en-GB")).toBe("en");
    expect(normalizeBrandLang("de-DE")).toBeNull();
    expect(normalizeBrandLang(null)).toBeNull();
  });

  it("prefers ?lang over the stored editor language and the browser", () => {
    expect(resolveBrandLang("?lang=en", "zh-CN", ["zh-CN"])).toBe("en");
    expect(resolveBrandLang("", "zh-CN", ["en-US"])).toBe("zh-CN");
    expect(resolveBrandLang("", null, ["fr", "zh-HK"])).toBe("zh-CN");
    expect(resolveBrandLang("?lang=xx", "de", ["fr"])).toBe("en");
  });

  it("mirrors the editor theme setting", () => {
    expect(resolveBrandTheme(null, true)).toBe("light");
    expect(resolveBrandTheme("dark", false)).toBe("dark");
    expect(resolveBrandTheme("system", true)).toBe("dark");
    expect(resolveBrandTheme("system", false)).toBe("light");
  });
});

describe("renderBrandPage", () => {
  let root: HTMLElement;

  beforeEach(() => {
    document.head.innerHTML = '<meta name="description" content="" />';
    root = document.createElement("div");
    document.body.replaceChildren(root);
  });

  it.each(PAGES)("renders the %s page with nav state and app links", (page) => {
    const onToggleLang = vi.fn();
    renderBrandPage(root, {
      copy: BRAND_COPY.en,
      lang: "en",
      page,
      onToggleLang,
    });
    const content = BRAND_COPY.en.pages[page];

    expect(document.title).toBe(content.documentTitle);
    expect(document.documentElement.lang).toBe("en");
    expect(root.querySelector("h1")?.textContent).toBe(content.hero.title);
    expect(root.querySelectorAll("section.brand-section")).toHaveLength(
      content.sections.length,
    );
    expect(
      root.querySelector('[aria-current="page"]')?.getAttribute("href"),
    ).toBe(BRAND_PAGE_URLS[page]);
    expect(root.querySelector(".brand-logo")?.getAttribute("href")).toBe("/");
    expect(
      root.querySelector('svg[role="img"]')?.getAttribute("aria-label"),
    ).toBe("Calileon");

    root.querySelector<HTMLButtonElement>(".brand-header button")?.click();
    expect(onToggleLang).toHaveBeenCalledTimes(1);
  });

  it("renders copy as text, never as markup", () => {
    const copy: BrandCopy = structuredClone(BRAND_COPY.en);
    copy.pages.plus.hero.title = '<img src=x onerror="alert(1)">';
    renderBrandPage(root, {
      copy,
      lang: "en",
      page: "plus",
      onToggleLang: () => {},
    });

    expect(root.querySelector("img")).toBeNull();
    expect(root.querySelector("h1")?.textContent).toBe(
      copy.pages.plus.hero.title,
    );
  });

  it("sets the document language for Chinese", () => {
    renderBrandPage(root, {
      copy: BRAND_COPY["zh-CN"],
      lang: "zh-CN",
      page: "security",
      onToggleLang: () => {},
    });
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(
      root.querySelector(".brand-header button")?.getAttribute("lang"),
    ).toBe("en");
  });
});
