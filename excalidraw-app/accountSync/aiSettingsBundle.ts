/**
 * The AI global settings that sync with the account (ADR 0038 §2): four
 * independent sections, each read from, normalised by and written through
 * the module that already owns it, so a synced copy goes through the same
 * validation as a hand-typed one and every open panel reloads via its usual
 * "config updated" event.
 *
 * Not synced: generation logs, chat history, workbench drafts, video tasks,
 * Many Minds perspectives (per-document or per-device state, not settings).
 */

import { STORAGE_KEYS } from "../app_constants";
import {
  loadAIAgentConfig,
  normalizeAIAgentConfig,
  saveAIAgentConfig,
} from "../ai/agentConfig";
import {
  loadAIImageConfig,
  normalizeAIImageConfig,
  saveAIImageConfig,
} from "../ai/config";
import {
  AI_PROMPT_TEMPLATES_STORAGE_KEY,
  loadCustomPromptTemplates,
  normalizePromptTemplate,
  saveCustomPromptTemplates,
} from "../ai/promptTemplates";
import {
  DEFAULT_AI_PROXY_CONFIG,
  loadAIProxyConfig,
  normalizeAIProxyConfig,
  saveAIProxyConfig,
} from "../ai/proxyConfig";

import type { AIProxyConfigV2 } from "../ai/proxyConfig";
import type {
  AIAgentConfig,
  AIImageProviderConfig,
  PromptTemplate,
} from "../ai/types";

export const AI_SETTINGS_SECTIONS = [
  "models",
  "agents",
  "templates",
  "network",
] as const;

export type AISettingsSection = typeof AI_SETTINGS_SECTIONS[number];

export interface AISettingsSections {
  models: AIImageProviderConfig;
  agents: AIAgentConfig;
  templates: PromptTemplate[];
  network: AIProxyConfigV2;
}

/** The plaintext inside the ciphertext. Sections may be missing. */
export interface AISettingsBundle {
  version: 1;
  sections: Partial<Record<AISettingsSection, unknown>>;
}

export type SectionHashes = Record<AISettingsSection, string>;

/** Change events of every synced section (local edits trigger an upload). */
export { AI_IMAGE_CONFIG_UPDATED_EVENT } from "../ai/config";
export { AI_AGENT_CONFIG_UPDATED_EVENT } from "../ai/agentConfig";
export { AI_PROMPT_TEMPLATES_UPDATED_EVENT } from "../ai/promptTemplates";
export { AI_PROXY_CONFIG_UPDATED_EVENT } from "../ai/proxyConfig";

/** localStorage keys whose `storage` events mean another tab edited. */
export const AI_SETTINGS_STORAGE_KEYS: readonly string[] = [
  STORAGE_KEYS.LOCAL_STORAGE_AI_IMAGE,
  STORAGE_KEYS.LOCAL_STORAGE_AI_AGENT,
  STORAGE_KEYS.LOCAL_STORAGE_AI_PROXY,
  AI_PROMPT_TEMPLATES_STORAGE_KEY,
];

const normalizeTemplates = (value: unknown): PromptTemplate[] =>
  (Array.isArray(value) ? value : [])
    .map(normalizePromptTemplate)
    .filter((template): template is PromptTemplate => !!template)
    .filter((template) => !template.isBuiltIn);

/**
 * Brings an untrusted section value into the shape the app stores, or throws
 * when the owning module rejects it (e.g. an http:// proxy in production).
 */
export const normalizeSection = <S extends AISettingsSection>(
  section: S,
  value: unknown,
): AISettingsSections[S] => {
  const candidate = (value ?? null) as any;
  switch (section) {
    case "models":
      return normalizeAIImageConfig(candidate) as AISettingsSections[S];
    case "agents":
      return normalizeAIAgentConfig(candidate) as AISettingsSections[S];
    case "templates":
      return normalizeTemplates(candidate) as AISettingsSections[S];
    case "network":
      return normalizeAIProxyConfig(
        candidate ?? DEFAULT_AI_PROXY_CONFIG,
      ) as AISettingsSections[S];
  }
  throw new TypeError(`unknown section ${section}`);
};

export const readLocalSections = (): AISettingsSections => ({
  models: normalizeSection("models", loadAIImageConfig()),
  agents: normalizeSection("agents", loadAIAgentConfig()),
  templates: normalizeSection("templates", loadCustomPromptTemplates()),
  network: normalizeSection("network", loadAIProxyConfig()),
});

/** Nothing configured: a fresh device whose section should just take the account's. */
export const isSectionEmpty = (
  section: AISettingsSection,
  value: AISettingsSections[AISettingsSection],
): boolean => {
  switch (section) {
    case "models":
      return (value as AIImageProviderConfig).models.length === 0;
    case "agents": {
      const agents = value as AIAgentConfig;
      return (
        agents.textAgents.length +
          agents.visionAgents.length +
          agents.llmAgents.length +
          agents.customAgents.length +
          agents.skills.length ===
        0
      );
    }
    case "templates":
      return (value as PromptTemplate[]).length === 0;
    case "network": {
      const network = value as AIProxyConfigV2;
      return (
        network.mode === "direct" &&
        !network.endpoint &&
        !network.accessToken &&
        !network.gatewayEndpoint &&
        Object.keys(network.managedRoutes).length === 0
      );
    }
  }
  return true;
};

/** Persists one section through its owning module (fires its update event). */
export const writeLocalSection = <S extends AISettingsSection>(
  section: S,
  value: AISettingsSections[S],
) => {
  switch (section) {
    case "models":
      saveAIImageConfig(value as AIImageProviderConfig);
      return;
    case "agents":
      saveAIAgentConfig(value as AIAgentConfig);
      return;
    case "templates":
      saveCustomPromptTemplates(value as PromptTemplate[]);
      return;
    case "network": {
      // a full replace: saveAIProxyConfig merges into the current config,
      // so pass every field (managedRoutes included) explicitly
      saveAIProxyConfig({ ...(value as AIProxyConfigV2) });
    }
  }
};

/** JSON with sorted object keys, so equal settings always hash the same. */
export const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => (value as any)[key] !== undefined)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify((value as any)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
};

const toHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

export const hashSection = async (value: unknown): Promise<string> =>
  toHex(
    await window.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(stableStringify(value)),
    ),
  );

export const hashSections = async (
  sections: AISettingsSections,
): Promise<SectionHashes> => {
  const entries = await Promise.all(
    AI_SETTINGS_SECTIONS.map(
      async (section) =>
        [section, await hashSection(sections[section])] as const,
    ),
  );
  return Object.fromEntries(entries) as SectionHashes;
};

export const toBundle = (sections: AISettingsSections): AISettingsBundle => ({
  version: 1,
  sections: { ...sections },
});
