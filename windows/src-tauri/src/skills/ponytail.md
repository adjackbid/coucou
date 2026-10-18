---
name: ponytail
role: 極簡程式
category: 程式開發
description: 用最少的程式碼解決問題：先找現有程式與標準函式庫，少裝不必要的依賴。 Makes the agent write only the code a task needs: reuse existing code, the standard library and platform features before adding anything new.
source: https://github.com/DietrichGebert/ponytail
stars: 165.3k
stars-at: 2026-10-18
---

# Ponytail（極簡程式）

- 來源：https://github.com/DietrichGebert/ponytail
- GitHub ★ 165.3k（2026-10-18）
- 分類：程式開發
- 用途：用最少的程式碼解決問題：先找現有程式與標準函式庫，少裝不必要的依賴。

## Getting the real thing

This skill is published on GitHub at https://github.com/DietrichGebert/ponytail. Before relying on the summary below:

1. If it is already installed on this machine (a plugin, or a folder under `~/.claude/skills`, `~/.codex/skills` or `~/.agents/skills`), use that: it is the full version.
2. Otherwise, when the work folder and the network allow, install it (`npx skills add DietrichGebert/ponytail`) and follow the installed instructions.
3. If neither is possible, work by the rules below. They summarise the original; they do not replace it.

## The rules in short

- Before writing code, look for a function, module or library already in the project that does it, and reuse it.
- Prefer the standard library and platform features over a new dependency. Add a dependency only when it removes real complexity, and say why.
- The smallest change that solves the task: a one-line fix beats a new abstraction; no speculative generality; no options nobody asked for.
- Delete what you make unnecessary: no dead code, no commented-out code.
- Keep what matters even when cutting: input validation, security, error handling that prevents data loss, accessibility basics.
- Say what you reused instead of writing, so the reviewer sees the code that was avoided.
