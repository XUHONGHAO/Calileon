import { defaultLang } from "@excalidraw/excalidraw/i18n";

import {
  persistSingleFileLanguage,
  resolveSingleFileLanguage,
  SINGLE_FILE_LANGUAGE_STORAGE_KEY,
} from "./language";

const createStorage = (initial: Record<string, string> = {}): Storage => {
  const store = new Map(Object.entries(initial));
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
};

describe("single-file language", () => {
  it("prefers an explicit override over stored, payload, and browser languages", () => {
    const language = resolveSingleFileLanguage({
      payloadLanguage: "zh-CN",
      storage: createStorage({ [SINGLE_FILE_LANGUAGE_STORAGE_KEY]: "de-DE" }),
      override: "ja-JP",
    });

    expect(language.code).toBe("ja-JP");
  });

  it("uses the board language when no override or stored preference exists", () => {
    const language = resolveSingleFileLanguage({
      payloadLanguage: "zh-TW",
      storage: createStorage(),
    });

    expect(language.code).toBe("zh-TW");
  });

  it("supports languages below the main app's completeness threshold", () => {
    const language = resolveSingleFileLanguage({
      payloadLanguage: "ja-JP",
      storage: createStorage(),
    });

    expect(language.code).toBe("ja-JP");
    expect(language.label).toBe("日本語");
  });

  it("keeps RTL direction for languages the app does not advertise", () => {
    const language = resolveSingleFileLanguage({
      payloadLanguage: "he-IL",
      storage: createStorage(),
    });

    expect(language.code).toBe("he-IL");
    expect(language.rtl).toBe(true);
  });

  it("resolves region variants and casing to a known language", () => {
    expect(
      resolveSingleFileLanguage({
        payloadLanguage: "zh",
        storage: createStorage(),
      }).code,
    ).toBe("zh-CN");

    expect(
      resolveSingleFileLanguage({
        payloadLanguage: "DE-de",
        storage: createStorage(),
      }).code,
    ).toBe("de-DE");
  });

  it("keeps the reader's stored choice for boards exported without a language", () => {
    const language = resolveSingleFileLanguage({
      payloadLanguage: undefined,
      storage: createStorage({ [SINGLE_FILE_LANGUAGE_STORAGE_KEY]: "fr-FR" }),
    });

    expect(language.code).toBe("fr-FR");
  });

  it("falls back to a valid language for legacy boards", () => {
    const language = resolveSingleFileLanguage({
      payloadLanguage: undefined,
      storage: createStorage(),
    });

    expect(language.code).toMatch(/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i);
  });

  it("ignores malformed language codes", () => {
    const language = resolveSingleFileLanguage({
      payloadLanguage: "<script>alert(1)</script>",
      storage: createStorage({
        [SINGLE_FILE_LANGUAGE_STORAGE_KEY]: "not a language",
      }),
      override: "   ",
    });

    expect(language.code).toMatch(/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i);
  });

  it("falls back to the default language when nothing can be resolved", () => {
    const language = resolveSingleFileLanguage({
      payloadLanguage: "not-a-language",
      storage: null,
      override: "also-not-a-language",
    });

    expect(["en", defaultLang.code]).toContain(language.code);
  });

  it("persists the selected language and survives unavailable storage", () => {
    const storage = createStorage();
    persistSingleFileLanguage("zh-CN", storage);
    expect(storage.getItem(SINGLE_FILE_LANGUAGE_STORAGE_KEY)).toBe("zh-CN");

    const throwing: Storage = {
      ...createStorage(),
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => persistSingleFileLanguage("zh-CN", throwing)).not.toThrow();
  });
});
