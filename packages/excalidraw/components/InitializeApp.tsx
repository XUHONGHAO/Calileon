import React, { useEffect, useState } from "react";

import type { Theme } from "@excalidraw/element/types";

import { resolveLanguage, setLanguage } from "../i18n";

import { LoadingMessage } from "./LoadingMessage";

import type { Language } from "../i18n";

interface Props {
  langCode: Language["code"];
  children: React.ReactElement;
  theme?: Theme;
}

export const InitializeApp = (props: Props) => {
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const updateLang = async () => {
      await setLanguage(currentLang);
      setLoading(false);
    };
    const currentLang = resolveLanguage(props.langCode);
    updateLang();
  }, [props.langCode]);

  return loading ? <LoadingMessage theme={props.theme} /> : props.children;
};
