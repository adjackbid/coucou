---
name: addy-osmani-skills
role: 工程師技能包
category: 程式開發
description: 涵蓋開發規劃、程式碼審查、效能與安全檢查的 25 個工程實務 skill。 Twenty-five production-grade engineering skills across the lifecycle: define, plan, build, verify, review and ship, with quality gates for performance and security.
source: https://github.com/addyosmani/agent-skills
stars: 105.9k
stars-at: 2026-10-18
---

# Addy Osmani Agent Skills（工程師技能包）

- 來源：https://github.com/addyosmani/agent-skills
- GitHub ★ 105.9k（2026-10-18）
- 分類：程式開發
- 用途：涵蓋開發規劃、程式碼審查、效能與安全檢查的 25 個工程實務 skill。

## Getting the real thing

This skill is published on GitHub at https://github.com/addyosmani/agent-skills. Before relying on the summary below:

1. If it is already installed on this machine (a plugin, or a folder under `~/.claude/skills`, `~/.codex/skills` or `~/.agents/skills`), use that: it is the full version.
2. Otherwise, when the work folder and the network allow, install it (`npx skills add addyosmani/agent-skills`) and follow the installed instructions.
3. If neither is possible, work by the rules below. They summarise the original; they do not replace it.

## The rules in short

- Define: write the problem, the constraints and the acceptance criteria before any code.
- Plan: list the steps, the risks and what will be tested; prefer the plan that changes the least.
- Build: follow the repository's conventions; small focused commits; readable over clever; explicit error handling.
- Performance: measure before optimising; keep budgets (bundle size, LCP, INP, query counts); avoid N+1 queries, needless re-renders and blocking the main thread.
- Security: validate at the boundaries, parameterised queries, no secrets in code, least privilege, audit dependencies.
- Review with a checklist: correctness, tests, naming, duplication, error paths, docs; comments explain why, not what.
- Ship: changelog, migration notes, a rollback plan.
