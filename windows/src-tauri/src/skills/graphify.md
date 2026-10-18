---
name: graphify
role: 專案知識圖譜
description: 把程式碼、SQL Schema、設定與文件轉成可查詢的知識圖譜，用查圖代替 grep。 Turns a codebase with its docs, SQL schemas, configs and PDFs into a queryable knowledge graph, parsed locally with tree-sitter and with every edge explained.
source: https://github.com/Graphify-Labs/graphify
stars: 127.8k
stars-at: 2026-10-18
---

# Graphify（專案知識圖譜）

- 來源：https://github.com/Graphify-Labs/graphify
- GitHub ★ 127.8k（2026-10-18）
- 用途：把程式碼、SQL Schema、設定與文件轉成可查詢的知識圖譜，用查圖代替 grep。

## Getting the real thing

This skill is published on GitHub at https://github.com/Graphify-Labs/graphify. Before relying on the summary below:

1. If it is already installed on this machine (a plugin, or a folder under `~/.claude/skills`, `~/.codex/skills` or `~/.agents/skills`), use that: it is the full version.
2. Otherwise, when the work folder and the network allow, install it (`npx skills add Graphify-Labs/graphify`) and follow the installed instructions.
3. If neither is possible, work by the rules below. They summarise the original; they do not replace it.

## The rules in short

- With the full skill: `/graphify <folder>` builds a local knowledge graph (AST parsing, no vector store) and you query it instead of grepping.
- Without it, do the same by hand at a smaller scale: list the entities (tables, modules, endpoints, document sections) and the edges (foreign keys, imports, calls, "documented in"), and label each edge EXTRACTED or INFERRED.
- To answer a question, find the relevant nodes, walk one or two hops, and cite the sources.
- Explain every relationship you claim: where it comes from in the code or the docs.
