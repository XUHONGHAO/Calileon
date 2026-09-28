import { resolveLanguage } from "@excalidraw/excalidraw/i18n";

import {
  SINGLE_FILE_PAYLOAD_PLACEHOLDER,
  SINGLE_FILE_PAYLOAD_SCRIPT_ID,
  type SingleFilePayload,
} from "./types";
import { isSingleFilePayload } from "./payload";

export const serializeSingleFilePayload = (
  payload: SingleFilePayload,
): string =>
  JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

/**
 * Stamps the board language on the document element so the offline page
 * announces the right language (and writing direction) to assistive tech and
 * browsers even before the runtime boots.
 */
export const applyLanguageToTemplate = (
  template: string,
  language: string | undefined,
): string => {
  if (!language?.trim()) {
    return template;
  }
  const languageMeta = resolveLanguage(language);
  const direction = languageMeta.rtl ? "rtl" : "ltr";
  if (/<html[^>]*\slang=/i.test(template)) {
    const withLang = template.replace(
      /(<html[^>]*\slang=")([^"]*)(")/i,
      `$1${languageMeta.code}$3`,
    );
    return /<html[^>]*\sdir=/i.test(withLang)
      ? withLang.replace(/(<html[^>]*\sdir=")([^"]*)(")/i, `$1${direction}$3`)
      : withLang.replace(
          /(<html[^>]*\slang="[^"]*")/i,
          `$1 dir="${direction}"`,
        );
  }
  return template.replace(
    /<html(\s|>)/i,
    `<html lang="${languageMeta.code}" dir="${direction}"$1`,
  );
};

export const injectSingleFilePayload = (
  template: string,
  payload: SingleFilePayload,
): string => {
  if (!template.includes(SINGLE_FILE_PAYLOAD_PLACEHOLDER)) {
    throw new Error(
      "Single-file runtime template is missing its payload marker",
    );
  }

  return applyLanguageToTemplate(template, payload.document.language).replace(
    SINGLE_FILE_PAYLOAD_PLACEHOLDER,
    serializeSingleFilePayload(payload),
  );
};

export const parseSingleFilePayload = (html: string): SingleFilePayload => {
  const document = new DOMParser().parseFromString(html, "text/html");
  const payloadNode = document.getElementById(SINGLE_FILE_PAYLOAD_SCRIPT_ID);

  if (!payloadNode?.textContent) {
    throw new Error("Single-file payload was not found");
  }

  const payload: unknown = JSON.parse(payloadNode.textContent);
  if (!isSingleFilePayload(payload)) {
    throw new Error("Unsupported single-file payload");
  }

  return payload;
};

export const serializeRuntimeDocument = (
  document: Document,
  payload: SingleFilePayload,
): string => {
  const clone = document.documentElement.cloneNode(true) as HTMLElement;
  const root = clone.querySelector("#root");
  const payloadNode = clone.querySelector(`#${SINGLE_FILE_PAYLOAD_SCRIPT_ID}`);

  if (!root || !payloadNode) {
    throw new Error("Single-file runtime shell is incomplete");
  }

  root.replaceChildren();
  payloadNode.textContent = serializeSingleFilePayload(payload);

  return `<!doctype html>\n${clone.outerHTML}`;
};
