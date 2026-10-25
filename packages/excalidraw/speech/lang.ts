/** BCP 47 tags recognizers know; bare editor codes map to a common region. */
const REGION_DEFAULTS: Record<string, string> = {
  en: "en-US",
  ja: "ja-JP",
  ko: "ko-KR",
  de: "de-DE",
  fr: "fr-FR",
  es: "es-ES",
  it: "it-IT",
  pt: "pt-BR",
  ru: "ru-RU",
};

/** Recognition languages offered in the recording overlay, in native names. */
export const SPEECH_LANGUAGES = [
  { code: "zh-CN", label: "中文" },
  { code: "en-US", label: "English" },
  { code: "ja-JP", label: "日本語" },
  { code: "ko-KR", label: "한국어" },
] as const;

/** Editor `langCode` → recognition language; every `zh-*` maps to `zh-CN`. */
export const getSpeechLang = (langCode: string) => {
  const [base] = langCode.split("-");
  if (base.toLowerCase() === "zh") {
    return "zh-CN";
  }
  if (langCode.includes("-")) {
    return langCode;
  }
  return REGION_DEFAULTS[base.toLowerCase()] ?? langCode;
};
