---
name: agent-browser
role: 瀏覽器操作員
category: 工具自動化
description: 自動開網站、點按鈕、填表單、截圖抓資料的命令列瀏覽器。 A browser automation CLI for agents: open pages, read an accessibility-tree snapshot with element refs, click, fill, press keys, take screenshots and keep sessions.
source: https://github.com/vercel-labs/agent-browser
stars: 41.1k
stars-at: 2026-10-18
---

# Agent Browser（瀏覽器操作員）

- 來源：https://github.com/vercel-labs/agent-browser
- GitHub ★ 41.1k（2026-10-18）
- 分類：工具自動化
- 用途：自動開網站、點按鈕、填表單、截圖抓資料的命令列瀏覽器。

## Getting the real thing

This skill is published on GitHub at https://github.com/vercel-labs/agent-browser. Before relying on the summary below:

1. If it is already installed on this machine (a plugin, or a folder under `~/.claude/skills`, `~/.codex/skills` or `~/.agents/skills`), use that: it is the full version.
2. Otherwise, when the work folder and the network allow, install it (`npm i -g agent-browser`) and follow the installed instructions.
3. If neither is possible, work by the rules below. They summarise the original; they do not replace it.

## The rules in short

- The loop: `agent-browser open <url>` → `snapshot` (accessibility tree with refs such as `@e12`) → `click @e12`, `fill @e3 "text"`, `press Enter` → `snapshot` again to confirm. Act on refs, never on guessed selectors.
- Read with `get text`, `screenshot out.png`; wait with `wait` for the page to settle before the next snapshot.
- Sessions and profiles keep logins between runs; name them with the session/profile options.
- Stay on the sites the task names. Never submit payments, deletions or anything irreversible without the user's own word. Keep credentials out of logs and reports.
- Install with `npm i -g agent-browser` (or brew / cargo) when allowed; if it cannot run here, say so instead of pretending the browsing happened.
