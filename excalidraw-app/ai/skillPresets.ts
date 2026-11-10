import { t } from "@excalidraw/excalidraw/i18n";

import h3Skill from "./skills/h3-prompt-writing/SKILL.md?raw";
import h3BaseGuide from "./skills/h3-prompt-writing/references/base-en.txt?raw";
import h3ReferenceGuide from "./skills/h3-prompt-writing/references/ref-en.txt?raw";
import seedance20Skill from "./skills/sd2-pe/SKILL.md?raw";
import seedance25Skill from "./skills/sd25-pe/SKILL.md?raw";

import type { AISkill } from "./types";

export const H3_PROMPT_SKILL_ID = "builtin:h3-prompt-writing";
export const H3_PROMPT_SKILL_SOURCE =
  "https://github.com/MiniMax-AI/MiniMax-H3/tree/a107547fa669c509b8e6363fe18378d46ab3066c/skills/h3-prompt-writing";

export const SEEDANCE20_PROMPT_SKILL_ID = "builtin:seedance-2.0-prompt-writing";
export const SEEDANCE25_PROMPT_SKILL_ID = "builtin:seedance-2.5-prompt-writing";
export const SEEDANCE20_PROMPT_SKILL_SOURCE =
  "https://ark.volcengine.com/region:cn-beijing/docs/seedance-2-0-prompt-guide";
export const SEEDANCE25_PROMPT_SKILL_SOURCE =
  "https://ark.volcengine.com/region:cn-beijing/docs/seedance-2-5-prompt-guide";

const BUILT_IN_SKILL_IDS = [
  H3_PROMPT_SKILL_ID,
  SEEDANCE25_PROMPT_SKILL_ID,
  SEEDANCE20_PROMPT_SKILL_ID,
];

type BuiltInAISkill = AISkill & {
  sourceURL: string;
  sourceLabel: string;
  scopeDescription: string;
  inputPlaceholder: string;
};

export const isBuiltInSkill = (id: string | undefined) =>
  !!id && BUILT_IN_SKILL_IDS.includes(id);

export const getBuiltInSkills = (): BuiltInAISkill[] => [
  {
    id: H3_PROMPT_SKILL_ID,
    name: t("ai.settings.h3Skill.name"),
    icon: "🎬",
    description: t("ai.settings.h3Skill.description"),
    triggers: ["H3", "MiniMax", "video prompt", "视频提示词"],
    sourceURL: H3_PROMPT_SKILL_SOURCE,
    sourceLabel: t("ai.settings.h3Skill.source"),
    scopeDescription: t("ai.settings.h3Skill.modes"),
    inputPlaceholder: t("ai.assistant.h3SkillInput"),
  },
  {
    id: SEEDANCE25_PROMPT_SKILL_ID,
    name: t("ai.settings.seedance25Skill.name"),
    icon: "🎬",
    description: t("ai.settings.seedance25Skill.description"),
    triggers: ["Seedance 2.5", "sd25-pe", "Doubao", "即梦", "视频提示词"],
    sourceURL: SEEDANCE25_PROMPT_SKILL_SOURCE,
    sourceLabel: t("ai.settings.seedance25Skill.source"),
    scopeDescription: t("ai.settings.seedance25Skill.modes"),
    inputPlaceholder: t("ai.settings.seedance25Skill.input"),
  },
  {
    id: SEEDANCE20_PROMPT_SKILL_ID,
    name: t("ai.settings.seedance20Skill.name"),
    icon: "🎬",
    description: t("ai.settings.seedance20Skill.description"),
    triggers: ["Seedance 2.0", "sd2-pe", "Doubao", "即梦", "视频提示词"],
    sourceURL: SEEDANCE20_PROMPT_SKILL_SOURCE,
    sourceLabel: t("ai.settings.seedance20Skill.source"),
    scopeDescription: t("ai.settings.seedance20Skill.modes"),
    inputPlaceholder: t("ai.settings.seedance20Skill.input"),
  },
];

export const getBuiltInSkill = (id: string | undefined) =>
  getBuiltInSkills().find((skill) => skill.id === id);

// Bundled presets never enter local settings or the account-sync payload.
export const getAllAISkills = (customSkills: readonly AISkill[]) => [
  ...getBuiltInSkills(),
  ...customSkills.filter((skill) => !isBuiltInSkill(skill.id)),
];

export const getSkillSystemPrompt = (id: string | undefined) => {
  if (id === SEEDANCE20_PROMPT_SKILL_ID || id === SEEDANCE25_PROMPT_SKILL_ID) {
    // The official 2.5 artifact includes local CLI self-maintenance. The app
    // vendors releases, so only its writing workflow (from Purpose onward)
    // belongs in a text-only LLM request. Keep the original artifact intact.
    const writingRules =
      id === SEEDANCE20_PROMPT_SKILL_ID
        ? seedance20Skill
        : seedance25Skill.slice(seedance25Skill.indexOf("\n## 目的\n") + 1);
    const model = id === SEEDANCE20_PROMPT_SKILL_ID ? "2.0" : "2.5";
    return `Apply the official Seedance ${model} prompt optimizer below. Keep this selected skill active across all conversation turns and revisions. Follow this version's writing workflow, reference syntax, task routing and output contract; do not mix in another model's rules.
This app provides text-only chat, without filesystem access, network access, tool use, or local CLI maintenance. Preserve known user reference labels and use only facts provided in text; never claim to have inspected image, video or audio assets. Apply the official text-only fallback and clarification rules. Do not execute installation or update commands and do not call video generation APIs. Bundled skill releases are maintained by the application.

--- Official Seedance ${model} writing instructions ---
${writingRules}`;
  }
  if (!isBuiltInSkill(id)) {
    return undefined;
  }

  return `You are helping the user write MiniMax H3 video prompts using the official h3-prompt-writing skill below. Keep this skill active for all turns, including revisions and generation-mode changes.
Follow the official SKILL.md and the applicable reference guide. Both guides are included in full; use base-en.txt for T2VA/I2VA/FL2VA/L2VA and ref-en.txt for Ref2VA (with base-en.txt for shared notation).
Before drafting, establish the generation mode, requested duration (4–15 seconds), creative intent, and any required reference-frame or asset descriptions. Ask concise questions in the user's language if necessary information is missing. This chat receives text only: do not claim to have inspected image, video, or audio assets; ask the user to describe their contents and reference roles when needed.
Once the brief is sufficient, output the final prompt itself, with the exact official field names, order, reference labels, speaker and dialogue tags, keyframe alignment, and timing notation. Write the rewrite sections in English while retaining the original language of dialogue, lyrics, and visible text. Do not add a preface or translate the final field names. Do not generate a video or claim that generation has run.

--- Official SKILL.md ---
${h3Skill}

--- Official references/base-en.txt ---
${h3BaseGuide}

--- Official references/ref-en.txt ---
${h3ReferenceGuide}`;
};
