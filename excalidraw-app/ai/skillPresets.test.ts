import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  getAllAISkills,
  getBuiltInSkill,
  getSkillSystemPrompt,
  H3_PROMPT_SKILL_ID,
  SEEDANCE20_PROMPT_SKILL_ID,
  SEEDANCE25_PROMPT_SKILL_ID,
} from "./skillPresets";
import {
  DEFAULT_AI_AGENT_CONFIG,
  loadAIAgentConfig,
  saveAIAgentConfig,
} from "./agentConfig";

describe("bundled H3 skill", () => {
  it.each([
    [
      "SKILL.md",
      "a7000443588ca3f145e3b3fd8900f14e0325dc460bd811268fac89a9dc8e56d0",
    ],
    [
      "references/base-en.txt",
      "2cfebc096a6e08370f288d468d90b60f7f9bcb938f94bf090816e910e48e75fc",
    ],
    [
      "references/ref-en.txt",
      "1e574f356716ad55612247ffb7bbccbcdb484ad96599d63c7dca1af186b1fab7",
    ],
  ])(
    "preserves the pinned official %s and supplies it in full",
    (path, hash) => {
      const bytes = readFileSync(
        `excalidraw-app/ai/skills/h3-prompt-writing/${path}`,
      );
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
      expect(getSkillSystemPrompt(H3_PROMPT_SKILL_ID)).toContain(
        bytes.toString("utf8"),
      );
    },
  );

  it("keeps built-in skills available when local settings are empty or replaced", () => {
    localStorage.clear();
    saveAIAgentConfig(DEFAULT_AI_AGENT_CONFIG);
    expect(loadAIAgentConfig().skills).toEqual([]);
    const custom = {
      id: "mine",
      name: "My Skill",
      icon: "AI",
      description: "Custom",
    };
    expect(getAllAISkills([custom]).map((skill) => skill.id)).toEqual([
      H3_PROMPT_SKILL_ID,
      SEEDANCE25_PROMPT_SKILL_ID,
      SEEDANCE20_PROMPT_SKILL_ID,
      "mine",
    ]);
    expect(
      getAllAISkills([{ ...custom, id: H3_PROMPT_SKILL_ID }])[0].name,
    ).toBe("H3 Video Prompt Writing");
    expect(getSkillSystemPrompt("mine")).toBeUndefined();
  });

  it.each([
    [
      SEEDANCE20_PROMPT_SKILL_ID,
      "sd2-pe",
      "8836cdb2bc4f7d8a329c4ecd33cca19efdcfc71afdd927e8defe6e1f9a2e2b3c",
    ],
    [
      SEEDANCE25_PROMPT_SKILL_ID,
      "sd25-pe",
      "ee04557ba9a1c9f5517b574e24fc73d0022b22254373074db4c11f3d0635ea57",
    ],
  ])(
    "preserves the official %s artifact and includes all writing rules",
    (id, folder, hash) => {
      const bytes = readFileSync(`excalidraw-app/ai/skills/${folder}/SKILL.md`);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(hash);
      const source = bytes.toString("utf8");
      const writingStart =
        folder === "sd25-pe" ? source.indexOf("\n## 目的\n") + 1 : 0;
      expect(writingStart).toBeGreaterThanOrEqual(0);
      if (folder === "sd25-pe") {
        expect(writingStart).toBeGreaterThan(0);
      }
      const prompt = getSkillSystemPrompt(id)!;
      expect(prompt).toContain(source.slice(writingStart));
      expect(prompt).not.toContain("npx --yes skills@latest update");
      expect(prompt).not.toContain("--- Official SKILL.md ---");
      expect(prompt).not.toContain(
        folder === "sd25-pe"
          ? "# Seedance 2.0 Prompt Optimizer"
          : "# Seedance 2.5 Prompt Optimizer",
      );
      expect(getBuiltInSkill(id)?.sourceURL).toContain(
        folder === "sd25-pe" ? "seedance-2-5" : "seedance-2-0",
      );
      expect(getBuiltInSkill(id)?.inputPlaceholder).not.toContain("4–15");
    },
  );
});
