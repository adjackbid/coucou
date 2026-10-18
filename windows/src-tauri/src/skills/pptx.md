---
name: pptx
role: 簡報設計師
category: 文件簡報
description: 整理內容、排版投影片，也能讀取並修改現成的 .pptx。 Reads, creates and edits PowerPoint decks: outline first, consistent layouts, design rules for readable slides, python-pptx or html-to-pptx tooling, and a render check before delivery.
source: https://github.com/anthropics/skills
stars: 180.3k
stars-at: 2026-10-18
---

# PPTX Skill（簡報設計師）

- 來源：https://github.com/anthropics/skills
- GitHub ★ 180.3k（2026-10-18）
- 分類：文件簡報
- 用途：整理內容、排版投影片，也能讀取並修改現成的 .pptx。（在 anthropics/skills 這個官方倉庫裡的 pptx 資料夾）

## Getting the real thing

This skill is published on GitHub at https://github.com/anthropics/skills. Before relying on the summary below:

1. If it is already installed on this machine (a plugin, or a folder under `~/.claude/skills`, `~/.codex/skills` or `~/.agents/skills`), use that: it is the full version.
2. Otherwise, when the work folder and the network allow, install it (the `pptx` folder of `anthropics/skills` (`npx skills add anthropics/skills`)) and follow the installed instructions.
3. If neither is possible, work by the rules below. They summarise the original; they do not replace it.

## The rules in short

- Read a deck before changing it: convert it to text first (for example `markitdown deck.pptx`) and skim the structure.
- New deck: outline first, one line per slide (title plus at most three points), agree on it, then build. Use a small, consistent set of layouts: title, section, content, two-column, image with caption, closing.
- Slide rules: one idea per slide; at most six bullets of at most twelve words; body 24pt or larger, titles 36pt or larger; one accent colour plus neutrals; the same margins everywhere; pictures only with a purpose; long explanations go to speaker notes.
- Editing an existing deck: keep its template, fonts and colours; change text in place; do not rebuild unless asked.
- Build with python-pptx (or the html-to-pptx tooling if the full skill is installed), then render thumbnails or export to check overflow, alignment and cut-off text before delivering.
- Deliver the .pptx and a short list of the slides, saying what changed.
