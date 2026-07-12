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

export const injectSingleFilePayload = (
  template: string,
  payload: SingleFilePayload,
): string => {
  if (!template.includes(SINGLE_FILE_PAYLOAD_PLACEHOLDER)) {
    throw new Error(
      "Single-file runtime template is missing its payload marker",
    );
  }

  return template.replace(
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
