import { vi } from "vitest";

import {
  DEFAULT_FONT_FAMILY,
  FONT_FAMILY,
  FONT_METADATA,
  getDefaultFontFamily,
  getFontFamilyDisplayName,
  getFontFamilyString,
} from "@excalidraw/common";

import type { ExcalidrawTextElement } from "@excalidraw/element/types";

import { getDefaultAppState, cleanAppStateForExport } from "../appState";
import { restoreAppState, restoreElements } from "../data/restore";
import { Fonts } from "../fonts";
import { Excalidraw } from "../index";
import { defaultLang, resolveLanguage, setLanguage } from "../i18n";

import { API } from "./helpers/api";
import { Pointer, UI } from "./helpers/ui";
import { act, fireEvent, render, waitFor } from "./test-utils";

const { h } = window;
const GB = FONT_FAMILY["LXGW WenKai GB"];
const TC = FONT_FAMILY["LXGW WenKai TC"];

afterEach(async () => {
  vi.unstubAllGlobals();
  await setLanguage(defaultLang);
});

describe("Chinese canvas fonts", () => {
  it.each([
    ["zh-CN", GB],
    ["zh-SG", GB],
    ["zh-Hans", GB],
    ["zh-Hans-TW", GB],
    ["zh-TW", TC],
    ["zh-HK", TC],
    ["zh-Hant-CN", TC],
    ["en", DEFAULT_FONT_FAMILY],
  ])("defaults new text for %s", async (code, expected) => {
    expect(getDefaultFontFamily(code as string)).toBe(expected);
    if (code === "zh-CN" || code === "zh-TW") {
      await render(<Excalidraw langCode={code} />);
      expect(h.state.currentItemFontFamily).toBe(expected);
      UI.clickTool("text");
      const mouse = new Pointer("mouse");
      mouse.clickAt(100, 100);
      expect(h.state.editingTextElement?.fontFamily).toBe(expected);
    }
  });

  it("keeps each font's original script and the Calileon prefix", async () => {
    for (const code of ["zh-CN", "zh-TW", "en"]) {
      await setLanguage(resolveLanguage(code));
      expect(getFontFamilyDisplayName(GB)).toBe("Calileon 霞鹜文楷 GB");
      expect(getFontFamilyDisplayName(TC)).toBe("Calileon 霞鶩文楷 TC");
      expect(getFontFamilyDisplayName(FONT_FAMILY["Calileon CJK Serif"])).toBe(
        "Calileon 霞鶩新緻宋",
      );
      expect(getFontFamilyDisplayName(FONT_FAMILY["Calileon CJK Sans"])).toBe(
        "Calileon 霞鶩晰黑",
      );
      expect(getFontFamilyDisplayName(FONT_FAMILY.Excalifont)).toBe(
        "Calileon Excalifont",
      );
    }
    expect(getFontFamilyString({ fontFamily: GB })).toContain("LXGW WenKai GB");
    expect(getFontFamilyString({ fontFamily: GB })).not.toContain("Calileon");
  });

  it("migrates legacy defaults, preserves explicit preferences, and excludes the preference from exports", async () => {
    await setLanguage(resolveLanguage("zh-TW"));
    expect(
      restoreAppState({ currentItemFontFamily: DEFAULT_FONT_FAMILY }, null)
        .currentItemFontFamily,
    ).toBe(TC);
    const explicit = restoreAppState(
      {
        currentItemFontFamily: DEFAULT_FONT_FAMILY,
        currentItemFontFamilyIsDefault: false,
      },
      null,
    );
    expect(explicit.currentItemFontFamily).toBe(DEFAULT_FONT_FAMILY);
    expect(explicit.currentItemFontFamilyIsDefault).toBe(false);
    expect(
      restoreAppState(
        { currentItemFontFamily: FONT_FAMILY.Nunito },
        { currentItemFontFamily: GB, currentItemFontFamilyIsDefault: true },
      ).currentItemFontFamily,
    ).toBe(FONT_FAMILY.Nunito);
    expect(cleanAppStateForExport(getDefaultAppState())).not.toHaveProperty(
      "currentItemFontFamilyIsDefault",
    );
  });

  it("switches the language default without changing existing text or manual choices", async () => {
    const oldText = API.createElement({
      type: "text",
      text: "原有文字 ABC",
      fontFamily: DEFAULT_FONT_FAMILY,
    });
    const view = await render(
      <Excalidraw langCode="zh-CN" initialData={{ elements: [oldText] }} />,
    );
    expect(h.state.currentItemFontFamily).toBe(GB);
    view.rerender(
      <Excalidraw langCode="zh-TW" initialData={{ elements: [oldText] }} />,
    );
    await waitFor(() => expect(h.state.currentItemFontFamily).toBe(TC));
    expect((h.elements[0] as ExcalidrawTextElement).fontFamily).toBe(
      DEFAULT_FONT_FAMILY,
    );
    UI.clickTool("text");
    fireEvent.click(view.getByTestId("font-family-normal"));
    await waitFor(() =>
      expect(h.state.currentItemFontFamilyIsDefault).toBe(false),
    );
    view.rerender(<Excalidraw langCode="zh-CN" />);
    await waitFor(() => expect(document.documentElement.lang).toBe("zh-CN"));
    expect(h.state.currentItemFontFamily).toBe(FONT_FAMILY.Nunito);
    expect(
      restoreElements([oldText], null)[0] as ExcalidrawTextElement,
    ).toMatchObject({
      fontFamily: DEFAULT_FONT_FAMILY,
      originalText: oldText.originalText,
    });
  });

  it("shows all four bundled fonts in the picker and lets the user select them", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const view = await render(<Excalidraw langCode="zh-CN" />);
    UI.clickTool("text");
    act(() => view.getByTestId("font-family-show-fonts").click());
    for (const id of [
      GB,
      TC,
      FONT_FAMILY["Calileon CJK Serif"],
      FONT_FAMILY["Calileon CJK Sans"],
    ]) {
      expect(
        view.getAllByTitle(getFontFamilyDisplayName(id)).length,
      ).toBeGreaterThan(0);
    }
    fireEvent.click(view.getByTitle("Calileon 霞鶩新緻宋"));
    await waitFor(() =>
      expect(h.state.currentItemFontFamily).toBe(
        FONT_FAMILY["Calileon CJK Serif"],
      ),
    );
    expect(h.state.currentItemFontFamilyIsDefault).toBe(false);
  });

  it("registers font metrics and includes license text in SVG font declarations", async () => {
    for (const id of [
      GB,
      TC,
      FONT_FAMILY["Calileon CJK Serif"],
      FONT_FAMILY["Calileon CJK Sans"],
    ]) {
      const entry = Fonts.registered.get(id)!;
      expect(entry.metadata).toBe(FONT_METADATA[id]);
      expect(entry.metadata.private).toBeUndefined();
      expect(entry.fontFaces.length).toBeGreaterThan(1);
      const spies = entry.fontFaces.map((face) =>
        vi.spyOn(face, "toCSS").mockReturnValue(undefined),
      );
      const text = API.createElement({
        type: "text",
        text: "中文繁體 ABC",
        fontFamily: id,
      });
      const css = await Fonts.generateFontFaceDeclarations([text]);
      expect(css.join("\n")).toContain(
        id === GB || id === TC
          ? "SIL OPEN FONT LICENSE"
          : "IPA Font License Agreement",
      );
      spies.forEach((spy) => spy.mockRestore());
    }
  });
});
