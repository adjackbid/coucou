// Claude Code hook events → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell…) and all of them are handled.

import { Bridge, IS_TAURI, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { INTEGRATION_AGENTS, State, type AgentSource, type ApprovalSection } from "../core/state";
import type { Island } from "./island";

/** Which agent each `--agent` of the relay is. Anything unknown is Claude Code. */
const AGENT_SOURCES: Record<string, { source: AgentSource; standing: string }> = {
  claude: { source: "claudeCode", standing: "integration_claude" },
  copilot: { source: "copilot", standing: "integration_copilot" },
};

/**
 * The pill an event belongs to: its session's own pill, named after the
 * project, so two Copilots in two folders are two pills. Without a session id
 * the agent's standing pill takes it.
 */
function taskFor(payload: HookPayload, projectName: string, cwd: string): string {
  const agent = AGENT_SOURCES[payload.agent ?? "claude"] ?? AGENT_SOURCES.claude;
  const sessionId = (payload.session_id ?? "").trim();
  if (sessionId) return State.ensureSessionTask(agent.source, sessionId, projectName, cwd);
  State.ensureTask(agent.standing);
  return agent.standing;
}

/** Clears the approval card if no decision was made before the hook gave up. */
let pendingTimeout: number | null = null;

interface HookPayload {
  hook_event_name?: string;
  /** Added by the relay: "claude" or "copilot". */
  agent?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  /** Added by the relay on Stop: the assistant's last message, from the transcript. */
  last_reply?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Set by coucou-hook when it had to cut a field: the input is not whole. */
  coucou_truncated?: boolean;
}

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** frenchStep() — same labels as the macOS app. */
const TOOL_LABELS: Record<string, string> = {
  Bash: "Exécute",
  Read: "Lit",
  Write: "Écrit",
  Edit: "Modifie",
  Glob: "Cherche",
  Grep: "Recherche",
  WebSearch: "Recherche web",
  WebFetch: "Récupère",
  TodoWrite: "Tâches",
  Task: "Agent",
  LS: "Liste",
  MultiEdit: "Modifie",
  NotebookEdit: "Notebook",
  PowerShell: "Exécute",
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ?? tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  return label;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 * A command is not here on purpose: it is the body of the card, in full, not a
 * headline cut to one line.
 */
const APPROVAL_FIELDS = [
  "file_path", // Write, Edit, MultiEdit
  "notebook_path", // NotebookEdit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
] as const;

function approvalTargetField(input: Record<string, unknown>): string | null {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) return field;
  }
  return null;
}

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  const field = approvalTargetField(input);
  return field ? `${tool} · ${(input[field] as string).trim()}` : tool;
}

/**
 * The order a human reads the rest of the input in: what runs or what is
 * written first, then what it replaces, then the flags. Anything a tool adds
 * that is not listed — every MCP tool's arguments — follows as it came.
 */
const DETAIL_ORDER = [
  "command", // Bash, PowerShell
  "content", // Write
  "old_string", // Edit
  "new_string",
  "edits", // MultiEdit
  "new_source", // NotebookEdit
  "prompt", // Task
  "description",
] as const;

/**
 * Everything the tool was handed, minus the headline, as labelled sections. A
 * string is shown as it is; anything else (an edits array, a boolean flag, an
 * MCP tool's nested arguments) is pretty-printed JSON, so nothing is ever
 * summarised into something it is not.
 */
function approvalSections(input: Record<string, unknown>): ApprovalSection[] {
  const headline = approvalTargetField(input);
  const known: string[] = DETAIL_ORDER.filter((k) => k in input);
  const rest = Object.keys(input).filter((k) => !known.includes(k));
  const sections: ApprovalSection[] = [];
  for (const key of [...known, ...rest]) {
    if (key === headline) continue;
    const value = input[key];
    if (value == null) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    if (!text.trim()) continue;
    sections.push({ label: key, value: text });
  }
  return sections;
}

/** Characters of monospace text per line on the card, give or take. */
const CODE_COLS = 64;

/**
 * How many lines of text the card needs — the island grows to fit, up to its
 * cap. Fractions stand for the chrome around the text: the body's padding,
 * border and gap, and a label's smaller type plus its margin.
 */
function approvalLines(headline: string, sections: ApprovalSection[]): number {
  const count = (text: string) =>
    text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / CODE_COLS)), 0);
  let lines = count(headline);
  if (sections.length) lines += 1.4;
  for (const s of sections) {
    // Each label is a line of its own once there is more than one section.
    lines += count(s.value) + (sections.length > 1 ? 1.25 : 0);
  }
  return lines;
}

function upsert(taskId: string, projectName: string, cwd: string) {
  const t = State.tasks.find((x) => x.id === taskId);
  if (!t) return;
  t.name = projectName;
  if (cwd) t.sessionCwd = cwd;
}

function clearSession(taskId: string) {
  const t = State.tasks.find((x) => x.id === taskId);
  if (!t) return;
  t.steps = [];
  t.transcript = [];
  t.stepIndex = 0;
  t.name = INTEGRATION_AGENTS.find((x) => x.id === taskId)?.name ?? t.name;
  t.pillBadge = null;
}

export function registerHookHandlers(island: Island) {
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
  // In a plain browser there is no relay. `coucouHook({...})` in the console
  // plays one event, so a card can be looked at with `npm run dev` alone.
  if (!IS_TAURI) {
    (window as unknown as { coucouHook: (p: HookPayload) => void }).coucouHook = (p) =>
      handleHook(island, p);
  }
}

function handleHook(island: Island, payload: HookPayload) {
  if (State.paused) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  const name = payload.hook_event_name ?? "";
  const cwd = payload.cwd ?? "";
  const raw = lastPathComponent(cwd);
  const projectName = aliasProjectName(raw || "Session");
  const CLAUDE_ID = taskFor(payload, projectName, cwd);
  const focused = State.focusId === CLAUDE_ID;
  const own = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (own) own.lastEvent = performance.now();
  // A shut island's Mochi follows whoever is busy, so work is visible.
  State.followActivity(CLAUDE_ID);

  /**
   * Alerts force the island open; work events only reveal the compact island
   * — and keep it there while they keep coming.
   */
  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (State.mode === "expanded") {
      if (isAlert) island.setView(view);
    } else if (isAlert) {
      island.alert(view);
    } else {
      island.reveal();
    }
  };

  switch (name) {
    case "SessionStart":
      upsert(CLAUDE_ID, projectName, cwd);
      surface("overview", false);
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      upsert(CLAUDE_ID, projectName, cwd);
      State.updateTask(CLAUDE_ID, "thinking");
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = payload.prompt ?? payload.message;
      if (asked) {
        State.appendStep(CLAUDE_ID, asked.slice(0, 60));
        State.appendTranscript(CLAUDE_ID, { role: "user", text: asked });
      }
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      upsert(CLAUDE_ID, projectName, cwd);
      State.updateTask(CLAUDE_ID, "working");
      const tool = payload.tool_name ?? "Tool";
      const label = stepLabel(tool, payload.tool_input ?? {});
      State.appendStep(CLAUDE_ID, label);
      State.appendTranscript(CLAUDE_ID, { role: "tool", text: label });
      surface("overview", false);
      break;
    }

    case "PostToolUse":
      State.updateTask(CLAUDE_ID, "working");
      break;

    case "PostToolUseFailure":
      State.updateTask(CLAUDE_ID, "working");
      State.appendStep(CLAUDE_ID, "⚠ failed");
      break;

    // Copilot only has the lowercase spelling.
    case "Notification":
    case "notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        State.updateTask(CLAUDE_ID, "ratelimit");
        Sound.play("rate");
      } else if (message.endsWith("?")) {
        State.updateTask(CLAUDE_ID, "question");
        State.appendStep(CLAUDE_ID, message);
      }
      break;
    }

    case "Stop": {
      State.updateTask(CLAUDE_ID, "finished");
      // What the agent said, on one line for the ticker; the finished card
      // shows the same text with room to wrap.
      const full = (payload.last_reply ?? payload.message ?? "").trim();
      const said = full.replace(/\s+/g, " ");
      if (said) {
        State.appendStep(CLAUDE_ID, said.length > 240 ? `${said.slice(0, 240)}…` : said);
        State.appendTranscript(CLAUDE_ID, { role: "assistant", text: full });
      }
      Sound.play("finish");
      if (!focused) {
        // Another pill has the screen. This one stays "unread" — badge, glow,
        // finished pose, a card of its own — until it is looked at. A badge
        // that faded in five seconds was gone before anyone saw it.
        const t = State.tasks.find((x) => x.id === CLAUDE_ID);
        if (t) t.unread = true;
        State.setPillBadge(CLAUDE_ID, "finished");
      }
      // Finished or not, nothing takes the whole island: the overview shows
      // every session side by side, and a card opens the full conversation.
      // Someone typing in the chat, or reading a session, is not yanked away;
      // the island just makes sure it is on screen.
      if (State.mode === "expanded" && (State.view === "prompt" || State.view === "session")) {
        island.reveal();
      } else {
        island.alert("overview");
      }
      window.setTimeout(() => {
        const t = State.tasks.find((x) => x.id === CLAUDE_ID);
        if (!t || t.unread) return;
        State.updateTask(CLAUDE_ID, "idle");
        State.setPillBadge(CLAUDE_ID, null);
      }, 5200);
      break;
    }

    // ErrorOccurred is Copilot's name for the same thing.
    case "StopFailure":
    case "ErrorOccurred":
      State.updateTask(CLAUDE_ID, "error");
      Sound.play("error");
      if (focused) surface("error", true);
      else State.setPillBadge(CLAUDE_ID, "error");
      break;

    case "SessionEnd":
      State.updateTask(CLAUDE_ID, "idle");
      if (CLAUDE_ID.startsWith("session:")) {
        // The pill was the session; the standing one comes back if it was the last.
        if (State.pendingApproval?.taskId === CLAUDE_ID) State.pendingApproval = null;
        if (State.view === "session" && State.focusId === CLAUDE_ID) island.setView(State.defaultView());
        State.endSession(CLAUDE_ID);
      } else {
        clearSession(CLAUDE_ID);
      }
      break;

    case "SubagentStart":
      State.appendStep(CLAUDE_ID, "+ subagent");
      break;

    case "SubagentStop":
      State.appendStep(CLAUDE_ID, "• subagent done");
      break;

    case "PermissionRequest": {
      const requestId = payload.request_id ?? "";
      // One card, one request. A second one must never quietly replace the first
      // — that would leave a human staring at request B while request A waits for
      // a decision nobody can give. Hand it straight back to the terminal.
      if (State.pendingApproval && State.pendingApproval.requestId !== requestId) {
        if (requestId) void Bridge.approvalDecline(requestId);
        break;
      }
      upsert(CLAUDE_ID, projectName, cwd);
      if (pendingTimeout != null) window.clearTimeout(pendingTimeout);
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      const command = approvalTarget(tool, input);
      const sections = approvalSections(input);
      State.pendingApproval = {
        requestId,
        sessionId: payload.session_id ?? "",
        taskId: CLAUDE_ID,
        tool,
        command,
        sections,
        lines: approvalLines(command, sections),
        truncated: payload.coucou_truncated === true,
      };
      // The relay's short ack window closes in 800 ms; everything below this
      // line is synchronous, so the card really is up by the time it lands.
      if (requestId) void Bridge.approvalAck(requestId);
      State.updateTask(CLAUDE_ID, "approval");
      State.isPinned = true;
      Sound.play("approval");
      if (focused) {
        island.alert("approval");
      } else {
        // Another agent holds the view, so the card would yank it away. The badge
        // is the signal instead — but it has to be on screen for that to mean
        // anything, hence the reveal. We just told the relay a human can act.
        State.setPillBadge(CLAUDE_ID, "approval");
        island.reveal();
      }
      // Coucou answers within 108 s or not at all; after that the terminal has
      // taken over and the card would be lying.
      pendingTimeout = window.setTimeout(() => {
        pendingTimeout = null;
        if (!State.pendingApproval) return;
        State.pendingApproval = null;
        State.isPinned = false;
        island.dropPin();
        State.updateTask(CLAUDE_ID, "working");
        State.setPillBadge(CLAUDE_ID, null);
        if (State.view === "approval") island.setView(State.defaultView());
        State.notify();
      }, 110_000);
      break;
    }

    default:
      break;
  }
  State.notify();
}
