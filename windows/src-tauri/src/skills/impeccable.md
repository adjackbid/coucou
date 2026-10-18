---
name: impeccable
role: UI 品質
category: UI/UX 設計
description: 修掉介面的 AI 味：調字體、排版、層次與留白，讓畫面像設計師做的。 A design language for AI-built front ends: typography, hierarchy, spacing and colour rules, plus commands and deterministic checks that catch the common AI-generated look.
source: https://github.com/pbakaus/impeccable
stars: 82.2k
stars-at: 2026-10-18
---

# Impeccable（UI 品質）

- 來源：https://github.com/pbakaus/impeccable
- GitHub ★ 82.2k（2026-10-18）
- 分類：UI/UX 設計
- 用途：修掉介面的 AI 味：調字體、排版、層次與留白，讓畫面像設計師做的。

## Getting the real thing

This skill is published on GitHub at https://github.com/pbakaus/impeccable. Before relying on the summary below:

1. If it is already installed on this machine (a plugin, or a folder under `~/.claude/skills`, `~/.codex/skills` or `~/.agents/skills`), use that: it is the full version.
2. Otherwise, when the work folder and the network allow, install it (`npx skills add pbakaus/impeccable`) and follow the installed instructions.
3. If neither is possible, work by the rules below. They summarise the original; they do not replace it.

## The rules in short

- The goal is to remove the AI look: default fonts, purple gradients, everything centred, rows of identical cards, emoji bullets, generic hero copy.
- Typography: a real type pair with character; a scale; tight headings (letter-spacing around -0.01 to -0.02em), relaxed body; few weights.
- Hierarchy: one focal point per screen; group with size, weight, colour and space rather than boxes and borders.
- Spacing: one scale; more space between sections than inside them; align to a grid.
- Colour: a restrained palette, real neutrals (not pure grey), one accent; gradients only with a reason.
- Details: real content instead of lorem ipsum; micro-interactions with a purpose; hover, focus, empty and loading states.
- With the full skill installed, use its commands (polish, critique, audit, normalize) and its rule checker; without it, critique your own screen against this list before delivering.
