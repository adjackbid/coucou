---
name: superpowers
role: 開發總監
category: 程式開發
description: 先釐清需求再動手：腦力激盪→寫計畫→TDD→Code Review→收尾的完整開發流程。 A structured software workflow for coding agents: brainstorm, write a plan, test-driven implementation, systematic debugging, code review, then finish the branch.
source: https://github.com/obra/superpowers
stars: 299.8k
stars-at: 2026-10-18
---

# Superpowers（開發總監）

- 來源：https://github.com/obra/superpowers
- GitHub ★ 299.8k（2026-10-18）
- 分類：程式開發
- 用途：先釐清需求再動手：腦力激盪→寫計畫→TDD→Code Review→收尾的完整開發流程。

## Getting the real thing

This skill is published on GitHub at https://github.com/obra/superpowers. Before relying on the summary below:

1. If it is already installed on this machine (a plugin, or a folder under `~/.claude/skills`, `~/.codex/skills` or `~/.agents/skills`), use that: it is the full version.
2. Otherwise, when the work folder and the network allow, install it (`npx skills add obra/superpowers`) and follow the installed instructions.
3. If neither is possible, work by the rules below. They summarise the original; they do not replace it.

## The rules in short

- Brainstorm before building: ask until the goal, the constraints and the acceptance criteria are clear; restate them; offer options with trade-offs and let the person choose.
- Write a plan before touching code: small steps, each verifiable; get agreement on it; keep it updated as you go.
- Test-driven: write the failing test first, watch it fail, write the least code that passes, refactor. No production code without a failing test that asked for it.
- Debug systematically: reproduce, find the root cause, fix the cause (not the symptom), add the test that would have caught it. No guess-and-patch loops.
- Review before finishing: read the whole diff as a strict reviewer: naming, duplication, error paths, tests, leftover debug code.
- Verify before claiming done: run the tests and the build and report the real output, never a belief.
- Finish the branch cleanly: clear commit message, a note of what was left out and why.
