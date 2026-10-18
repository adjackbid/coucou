---
name: remotion-skills
role: 影片製作師
category: 圖片影音
description: 用 React 程式做影片：動態字幕、動畫、轉場與效果，並能預覽與輸出。 Remotion's own best-practice skills for making videos in React: compositions, frame-based animation, sequences and transitions, captions, media and rendering.
source: https://github.com/remotion-dev/skills
stars: 5.2k
stars-at: 2026-10-18
---

# Remotion Skills（影片製作師）

- 來源：https://github.com/remotion-dev/skills
- GitHub ★ 5.2k（2026-10-18）
- 分類：圖片影音
- 用途：用 React 程式做影片：動態字幕、動畫、轉場與效果，並能預覽與輸出。

## Getting the real thing

This skill is published on GitHub at https://github.com/remotion-dev/skills. Before relying on the summary below:

1. If it is already installed on this machine (a plugin, or a folder under `~/.claude/skills`, `~/.codex/skills` or `~/.agents/skills`), use that: it is the full version.
2. Otherwise, when the work folder and the network allow, install it (`npx skills add remotion-dev/skills`) and follow the installed instructions.
3. If neither is possible, work by the rules below. They summarise the original; they do not replace it.

## The rules in short

- A video is a React component registered as `<Composition>` with id, durationInFrames, fps, width and height. Read the frame with `useCurrentFrame()` and timing with `useVideoConfig()`.
- Animate from the frame number: `interpolate(frame, [in, out], [from, to], { extrapolateRight: "clamp" })` and `spring()`. Never CSS transitions or animations: they are not deterministic per frame.
- Arrange scenes with `<Sequence from durationInFrames>`, back-to-back with `<Series>`, and transitions from `@remotion/transitions`.
- Captions: `@remotion/captions` (parse SRT, word-level timing, TikTok-style groups). Media through `<OffthreadVideo>`, `<Audio>` and `staticFile()` for files in `public/`.
- Preview with `npx remotion studio`; render with `npx remotion render <composition-id> out.mp4`.
