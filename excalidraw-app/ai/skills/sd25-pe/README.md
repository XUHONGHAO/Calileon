# Bundled official Seedance 2.5 prompt optimizer

- Official guide: <https://ark.volcengine.com/region:cn-beijing/docs/seedance-2-5-prompt-guide>
- Official discovery index: <https://arkdocs.tos-cn-beijing.volces.com/skills/.well-known/agent-skills/index.json>
- Artifact: <https://arkdocs.tos-cn-beijing.volces.com/skills/artifacts/video-generation/sd25-pe/0.1.1/sd25-pe-0.1.1.zip>
- Version: `sd25-pe` 0.1.1. Retrieved: 2026-11-10.
- Official archive SHA-256: `de823de6dc053ad463a3a5ccd2b1a59bf65f06515ebd5badc12a351d59269f85`.
- Verbatim `SKILL.md` SHA-256: `ee04557ba9a1c9f5517b574e24fc73d0022b22254373074db4c11f3d0635ea57`.

The archive was checked against the digest published in the official discovery index before extracting its only file. `SKILL.md` remains unmodified.

Runtime adaptation: the official file's front matter and local CLI self-update section precede `## 目的` (Purpose). The app supplies everything from Purpose onward, including all writing workflows, templates, parameter-lock rules, reference-fidelity rules, output contract and text-only fallbacks. Local skill maintenance is handled by reviewed app releases; the chat has no shell, network or filesystem tools, so it does not receive the CLI self-update instruction or emit a misleading automatic-upgrade failure notice.

This preserves the official writing and output rules: do not impose H3 fields, English-only output, Seedance 2.0 shot rules or generic constraint packs on 2.5. Only the selected skill is supplied to the writer model on each active turn. The skill does not submit video generation tasks. Do not translate or format the vendored source. Review upstream changes and update provenance, the Purpose boundary and fidelity tests together when replacing it.
