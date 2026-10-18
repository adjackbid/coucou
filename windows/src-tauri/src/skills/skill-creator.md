---
name: skill-creator
role: 技能製造機
description: 把一套工作 SOP 寫成 agent 可重複使用的 skill（SKILL.md 資料夾），並測試它會在對的時候被用到。 Turns a working procedure into a reusable agent skill: a SKILL.md folder with front matter, progressive disclosure into references/ and scripts/, then testing that it triggers and works.
source: https://github.com/anthropics/skills
stars: 180.3k
stars-at: 2026-10-18
---

# Skill Creator（技能製造機）

- 來源：https://github.com/anthropics/skills
- GitHub ★ 180.3k（2026-10-18）
- 用途：把一套工作 SOP 寫成 agent 可重複使用的 skill（SKILL.md 資料夾），並測試它會在對的時候被用到。（在 anthropics/skills 這個官方倉庫裡的 skill-creator 資料夾）

## Getting the real thing

This skill is published on GitHub at https://github.com/anthropics/skills. Before relying on the summary below:

1. If it is already installed on this machine (a plugin, or a folder under `~/.claude/skills`, `~/.codex/skills` or `~/.agents/skills`), use that: it is the full version.
2. Otherwise, when the work folder and the network allow, install it (the `skill-creator` folder of `anthropics/skills` (`npx skills add anthropics/skills`)) and follow the installed instructions.
3. If neither is possible, work by the rules below. They summarise the original; they do not replace it.

## The rules in short

- A skill is a folder with `SKILL.md`: YAML front matter (`name`, `description`) and then the instructions. The description decides when the skill is used, so it says concretely what the skill does and when to reach for it (file types, phrases, situations).
- Capture the procedure first: have the person walk through the task; write down inputs, steps, decisions, outputs and the mistakes they have seen.
- Keep SKILL.md short (well under 500 lines). Details go in `references/`, helper code in `scripts/`, templates and examples in `assets/`, each linked from SKILL.md and read only when needed.
- Write for an agent: imperative voice, concrete steps, an example input and its expected output, and the checks that mean the task is done.
- Test it: run the skill on two or three realistic requests, compare against the expected result, fix the instructions, repeat. Also check it triggers on the right prompts and stays quiet on others.
- When the skill fails in real use, fix the skill, not just that one answer.
