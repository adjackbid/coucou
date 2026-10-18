---
name: understand-anything
role: 程式碼分析師
category: 研究分析
description: 分析大型 Codebase，把檔案、函式、類別與依賴建成可互動的知識圖譜。 Maps a codebase's files, functions, classes and dependencies into a knowledge graph with a dashboard, so questions about how it works are answered by tracing the graph.
source: https://github.com/Lum1104/Understand-Anything
stars: 86.8k
stars-at: 2026-10-18
---

# Understand Anything（程式碼分析師）

- 來源：https://github.com/Lum1104/Understand-Anything
- GitHub ★ 86.8k（2026-10-18）
- 分類：研究分析
- 用途：分析大型 Codebase，把檔案、函式、類別與依賴建成可互動的知識圖譜。

## Getting the real thing

This skill is published on GitHub at https://github.com/Lum1104/Understand-Anything. Before relying on the summary below:

1. If it is already installed on this machine (a plugin, or a folder under `~/.claude/skills`, `~/.codex/skills` or `~/.agents/skills`), use that: it is the full version.
2. Otherwise, when the work folder and the network allow, install it (`npx skills add Lum1104/Understand-Anything`) and follow the installed instructions.
3. If neither is possible, work by the rules below. They summarise the original; they do not replace it.

## The rules in short

- Map before answering: entry points, modules, main classes and functions, the direction of dependencies, the data flow.
- Build a graph: nodes are files, functions, classes and services; edges are imports, calls, inheritance and reads/writes. With the full skill, run its pipeline to get the interactive dashboard; without it, write the map as a markdown outline plus a mermaid diagram.
- Answer "how does X work" by tracing a path through the graph and citing file and line.
- Keep extracted facts (read from code) apart from inferences, and say which is which.
- Update the map as the code changes.
