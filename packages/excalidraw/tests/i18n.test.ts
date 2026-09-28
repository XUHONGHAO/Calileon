import {
  defaultLang,
  languages,
  localeCatalog,
  resolveLanguage,
} from "../i18n";

describe("resolveLanguage", () => {
  it("falls back to English for missing or blank codes", () => {
    expect(resolveLanguage(undefined)).toEqual(defaultLang);
    expect(resolveLanguage("")).toEqual(defaultLang);
    expect(resolveLanguage("   ")).toEqual(defaultLang);
  });

  it("matches advertised languages case-insensitively", () => {
    expect(resolveLanguage("zh-CN").code).toBe("zh-CN");
    expect(resolveLanguage("zh-cn").code).toBe("zh-CN");
    expect(resolveLanguage("  de-DE  ").code).toBe("de-DE");
  });

  it("keeps label and writing direction for locales the app does not advertise", () => {
    const hebrew = resolveLanguage("he-IL");

    expect(hebrew.code).toBe("he-IL");
    expect(hebrew.rtl).toBe(true);

    expect(languages.some((lang) => lang.code === "he-IL")).toBe(false);
    expect(localeCatalog.some((lang) => lang.code === "he-IL")).toBe(true);
  });

  it("accepts well-formed codes that this build does not ship", () => {
    expect(resolveLanguage("xx-XX")).toEqual({ code: "xx-XX", label: "xx-XX" });
    expect(resolveLanguage("en-GB")).toEqual({ code: "en-GB", label: "en-GB" });
  });

  it("rejects malformed codes", () => {
    expect(resolveLanguage("<script>alert(1)</script>")).toEqual(defaultLang);
    expect(resolveLanguage("not a language")).toEqual(defaultLang);
    expect(resolveLanguage("a")).toEqual(defaultLang);
  });

  it("keeps the advertised list derived from the catalog", () => {
    expect(languages.length).toBeGreaterThan(0);
    for (const language of languages) {
      expect(localeCatalog.some((lang) => lang.code === language.code)).toBe(
        true,
      );
    }
    expect(languages.some((lang) => lang.code === defaultLang.code)).toBe(true);
  });
});
