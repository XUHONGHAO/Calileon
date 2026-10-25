import { useI18n, languages } from "@excalidraw/excalidraw/i18n";
import React from "react";

import { useSetAtom } from "../app-jotai";
import { Select } from "../components/ui";

import { appLangCodeAtom } from "./language-state";

export const LanguageList = ({ style }: { style?: React.CSSProperties }) => {
  const { t, langCode } = useI18n();
  const setLangCode = useSetAtom(appLangCodeAtom);

  return (
    <Select
      className="dropdown-select__language"
      onChange={({ target }) => setLangCode(target.value)}
      value={langCode}
      aria-label={t("buttons.selectLanguage")}
      // Sits at the foot of the main menu: open upwards, away from the zoom
      // controls in the bottom-left corner.
      placement="top-start"
      style={style}
    >
      {languages.map((lang) => (
        <option key={lang.code} value={lang.code}>
          {lang.label}
        </option>
      ))}
    </Select>
  );
};
