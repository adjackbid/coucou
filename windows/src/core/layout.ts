// Island geometry — ported from IslandTypes.swift + IslandWindowController.islandSize
// + IslandRootView.botPosition. All values are logical pixels, identical to the
// macOS app's points.

export type IslandMode = "hidden" | "compact" | "expanded";

export type IslandViewName =
  | "overview"
  | "empty"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "confused"
  | "upload"
  | "uploading"
  | "choose"
  | "mail"
  | "prompt"
  | "searching"
  | "result"
  | "note"
  | "settings"
  | "session"
  | "greeting";

export type BotStateName =
  | "idle"
  | "working"
  | "thinking"
  | "searching"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "ratelimit"
  | "sleeping"
  | "dizzy";

export type BotEmoteName = "love" | "surprised" | "proud" | "wink" | "yawn" | "happy" | "annoyed";

export type AgentLayoutMode = "none" | "grid" | "pills" | "column";

export interface ViewLayout {
  height: number;
  botX: number;
  botY: number | null; // null = auto-centred
  botDiameter: number;
  agentMode: AgentLayoutMode;
}

// The window is a fixed 1320×320 (largest view); the island is drawn inside it,
// glued to the top edge and horizontally centred. Wider than the macOS panel
// because the overview grows a card per unread session (src-tauri/src/island.rs
// must agree).
export const PANEL_W = 1320;
export const PANEL_H = 320;

// No notch on a PC: these are the hidden/compact sizes from docs/SPEC.md.
export const NOTCH_W = 184;
export const NOTCH_H = 32;
export const COMPACT_W = 288; // NOTCH_W + 104
export const EXPANDED_W = 640;

export const ROUNDED_CORNER = 14; // hidden / compact
export const EXPANDED_CORNER = 22;

/** Invisible hover strip that wakes the island when hidden. */
export const WAKE_STRIP_W = 240;
export const WAKE_STRIP_H = 6;

export const VIEW_LAYOUTS: Record<IslandViewName, ViewLayout> = {
  overview: { height: 160, botX: 68, botY: null, botDiameter: 58, agentMode: "pills" },
  empty: { height: 160, botX: 70, botY: null, botDiameter: 62, agentMode: "none" },
  // The nominal (largest) height; the real one follows the request, see approvalHeight.
  approval: { height: 300, botX: 62, botY: null, botDiameter: 56, agentMode: "column" },
  question: { height: 160, botX: 62, botY: null, botDiameter: 56, agentMode: "column" },
  error: { height: 160, botX: 62, botY: null, botDiameter: 58, agentMode: "column" },
  finished: { height: 160, botX: 62, botY: null, botDiameter: 58, agentMode: "column" },
  confused: { height: 160, botX: 76, botY: null, botDiameter: 66, agentMode: "column" },
  upload: { height: 176, botX: 140, botY: 104, botDiameter: 62, agentMode: "column" },
  // botY 103 = bar top (42 + 58) + 3, so the dot really rides the bar. The Swift
  // layout says 118 while its own comment says 103; the comment matches the spec.
  uploading: { height: 176, botX: 46, botY: 103, botDiameter: 20, agentMode: "none" },
  choose: { height: 176, botX: 60, botY: 101, botDiameter: 52, agentMode: "column" },
  mail: { height: 240, botX: 56, botY: null, botDiameter: 46, agentMode: "column" },
  prompt: { height: 160, botX: 52, botY: null, botDiameter: 44, agentMode: "column" },
  searching: { height: 160, botX: 52, botY: null, botDiameter: 44, agentMode: "column" },
  result: { height: 160, botX: 52, botY: null, botDiameter: 44, agentMode: "column" },
  note: { height: 160, botX: 60, botY: null, botDiameter: 50, agentMode: "column" },
  settings: { height: 160, botX: 54, botY: null, botDiameter: 46, agentMode: "none" },
  // The whole conversation of the focused agent, scrolling; as tall as the chat.
  session: { height: 300, botX: 52, botY: 90, botDiameter: 44, agentMode: "column" },
  greeting: { height: 150, botX: 320, botY: 90, botDiameter: 0, agentMode: "none" },
};

// The upload views above are only the fallback geometry. Once a file is actually
// dropped the whole sequence — Mochi included — is drawn by src/upload, which
// owns its own constants (USC) straight from UploadSequenceEngine.swift.

/** Chat view grows with the conversation — IslandContainer.chatPromptHeight. */
export function chatPromptHeight(messageCount: number): number {
  return Math.min(300, 240 + messageCount * 40);
}

/** The one-line card, as every other alert view. */
export const APPROVAL_MIN_H = 160;
/** Past this the request scrolls inside the card rather than growing it. */
export const APPROVAL_MAX_H = VIEW_LAYOUTS.approval.height;
/** Line height of the card's monospace text. */
const CODE_LINE_H = 16;

/**
 * The approval card grows with the request so a whole command or an Edit's
 * old and new strings can be read before they are allowed; one line of text
 * is the familiar 160 pt card, and the cap keeps the island a card rather
 * than a window.
 */
export function approvalHeight(lines: number): number {
  return Math.min(APPROVAL_MAX_H, APPROVAL_MIN_H + Math.round(Math.max(0, lines - 1) * CODE_LINE_H));
}

/** The question card: the familiar 160 pt card for one line and no choices. */
const QUESTION_MIN_H = 160;
const QUESTION_MAX_H = 320;
/** Width the question's text and choices have, left of the Mochi and inside the padding. */
const QUESTION_TEXT_W = EXPANDED_W - 116 - 16 - 24;

/**
 * The question card grows with what was asked: a long question wraps, and
 * every row of choice buttons needs its own line. Rough text metrics are
 * enough — the card is a little tall rather than clipping a choice.
 */
export function questionHeight(q: { text: string; choices: string[] } | null, withInput: boolean): number {
  if (!q) return QUESTION_MIN_H;
  const textLines = Math.min(3, Math.max(1, Math.ceil(q.text.length * 7.5 / QUESTION_TEXT_W)));
  let rows = 0;
  let used = 0;
  for (const c of q.choices) {
    const w = Math.min(QUESTION_TEXT_W, c.length * 7 + 34);
    if (used === 0 || used + w + 6 > QUESTION_TEXT_W) {
      rows += 1;
      used = w;
    } else {
      used += w + 6;
    }
  }
  const h = QUESTION_MIN_H + (textLines - 1) * 18 + rows * 32 + (withInput ? 36 : 0);
  return Math.min(QUESTION_MAX_H, h);
}

/** A row of pills in the overview's right card. */
const PILL_ROW_H = 32;
/** One extra session card in the overview, gap included. */
export const SESSION_CARD_W = 280;

/** The overview widens by a card for every unread session shown beside the focused one. */
export function overviewWidth(extraCards: number): number {
  return EXPANDED_W + Math.max(0, extraCards) * SESSION_CARD_W;
}

/**
 * The overview grows by a row of pills past the second: with several
 * sessions open the right card would otherwise clip the ones that matter.
 */
export function overviewHeight(pillCount: number): number {
  const rows = Math.ceil(Math.max(0, pillCount) / 2);
  return VIEW_LAYOUTS.overview.height + Math.max(0, rows - 2) * PILL_ROW_H;
}

export function islandSize(
  mode: IslandMode,
  view: IslandViewName,
  chatCount = 0,
  approvalLines = 0,
  pillCount = 0,
  extraCards = 0,
  question: { text: string; choices: string[] } | null = null,
  questionInput = false,
): { w: number; h: number } {
  switch (mode) {
    case "hidden":
      // No notch to hide inside on a PC: the island retracts to zero height and
      // slides into the top edge of the screen instead of sitting there as a bar.
      return { w: NOTCH_W, h: 0 };
    case "compact":
      return { w: COMPACT_W, h: NOTCH_H };
    case "expanded": {
      const h =
        view === "prompt" ? chatPromptHeight(chatCount)
        : view === "approval" ? approvalHeight(approvalLines)
        : view === "overview" ? overviewHeight(pillCount)
        : view === "question" ? questionHeight(question, questionInput)
        : VIEW_LAYOUTS[view].height;
      const w = view === "overview" ? overviewWidth(extraCards) : EXPANDED_W;
      return { w, h };
    }
  }
}

export interface BotPlacement {
  cx: number;
  cy: number;
  diameter: number;
  opacity: number;
}

/** IslandRootView.botPosition — cy is measured from the island's top edge. */
export function botPosition(
  mode: IslandMode,
  view: IslandViewName,
  islandH: number,
  uploadProgress = 0,
): BotPlacement {
  switch (mode) {
    case "hidden":
      return { cx: 46, cy: 16, diameter: 6, opacity: 0 };
    case "compact":
      return { cx: 40, cy: 16, diameter: 20, opacity: 1 };
    case "expanded": {
      const layout = VIEW_LAYOUTS[view];
      if (view === "uploading") {
        return {
          cx: 36 + uploadProgress * 526,
          cy: layout.botY ?? 103,
          diameter: layout.botDiameter,
          opacity: 1,
        };
      }
      if (layout.botY != null) {
        return { cx: layout.botX, cy: layout.botY, diameter: layout.botDiameter, opacity: 1 };
      }
      // Centre of the fixed 84 pt card (8 pt top inset + 34 pt header → content at y = 42)
      const headerBottom = 42;
      const cardH = 84;
      const cy = headerBottom + (islandH - headerBottom - cardH) / 2 + cardH / 2;
      return { cx: layout.botX, cy, diameter: layout.botDiameter, opacity: 1 };
    }
  }
}

export function botGlowColor(s: BotStateName): string {
  switch (s) {
    case "working":
      return "#3B9EFF";
    case "thinking":
      return "#A78BFA";
    case "searching":
      return "#6366F1";
    case "approval":
      return "#F5A524";
    case "error":
      return "#F4505E";
    case "finished":
      return "#34D399";
    case "ratelimit":
      return "#F59E0B";
    default:
      return "#FFFFFF";
  }
}

export function botGlowOpacity(s: BotStateName): number {
  switch (s) {
    case "idle":
    case "sleeping":
      return 0.15;
    case "dizzy":
      return 0;
    default:
      return 0.65;
  }
}

// Project colours (IslandConst.projectColors)
const PROJECT_COLORS: Record<string, string> = {
  korus: "#FF5A4E",
  "sbe hub": "#2EC4A0",
  "morning ai brief": "#F29B38",
  "publication ig": "#7C5CFF",
  "ig post": "#7C5CFF",
  "louisraille.fr": "#38BDF8",
  louisraille: "#38BDF8",
  "notch buddy": "#EC4899",
  "notch-buddy": "#EC4899",
  notchbuddy: "#EC4899",
};

const FALLBACK_COLORS = ["#22C55E", "#EAB308", "#60A5FA", "#E879F9"];

export function colorForProject(name: string): string {
  const key = name.toLowerCase().trim();
  const exact = PROJECT_COLORS[key];
  if (exact) return exact;
  for (const [k, c] of Object.entries(PROJECT_COLORS)) {
    if (key.startsWith(k) || key.includes(k)) return c;
  }
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
}

// Card wash colours (CardBackground.washColor)
export type Wash = "red" | "green" | "pink" | "amber" | "cyan" | "indigo" | "soft" | null;

export function washRGBA(wash: Wash): string {
  switch (wash) {
    case "red":
      return "rgba(244,80,94,0.55)";
    case "green":
      return "rgba(52,211,153,0.5)";
    case "pink":
      return "rgba(244,114,182,0.55)";
    case "amber":
      return "rgba(245,165,36,0.42)";
    case "cyan":
      return "rgba(34,211,238,0.38)";
    case "indigo":
      return "rgba(99,102,241,0.5)";
    case "soft":
      return "rgba(255,255,255,0.08)";
    default:
      return "rgba(0,0,0,0)";
  }
}
