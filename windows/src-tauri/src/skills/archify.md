---
name: archify
role: 架構圖設計師
category: 文件簡報
description: 給一段文字描述、計畫或程式碼，就生成架構圖、時序圖、流程圖、ER 圖與心智圖。 Turns a description, a plan or a codebase into interactive diagrams: architecture, sequence, flowchart, entity-relationship and mind map.
source: https://github.com/tt-a1i/archify
stars: 83.4k
stars-at: 2026-10-18
---

# Archify（架構圖設計師）

- 來源：https://github.com/tt-a1i/archify
- GitHub ★ 83.4k（2026-10-18）
- 分類：文件簡報
- 用途：給一段文字描述、計畫或程式碼，就生成架構圖、時序圖、流程圖、ER 圖與心智圖。

## Getting the real thing

This skill is published on GitHub at https://github.com/tt-a1i/archify. Before relying on the summary below:

1. If it is already installed on this machine (a plugin, or a folder under `~/.claude/skills`, `~/.codex/skills` or `~/.agents/skills`), use that: it is the full version.
2. Otherwise, when the work folder and the network allow, install it (`npx skills add tt-a1i/archify`) and follow the installed instructions.
3. If neither is possible, work by the rules below. They summarise the original; they do not replace it.

## The rules in short

- Pick the diagram for the question: architecture (components and their connections), sequence (interactions over time), flowchart (decisions), ER (data), mind map (ideas).
- Read the code or description first; list the components, what each is responsible for, and the arrows: who calls whom, which way data flows, over what protocol.
- Output: a standalone interactive HTML diagram with the full skill; otherwise mermaid (`graph TD`, `sequenceDiagram`, `erDiagram`) in markdown with a legend.
- Keep it readable: at most about twelve boxes per diagram, grouped into layers or subgraphs, labelled arrows, one consistent direction.
- Every box maps to a real file, service or table; state the assumptions you made.
