// App state — mirror of AppState.swift (the parts the island needs).

import type { BotEmoteName, BotStateName, IslandMode, IslandViewName } from "./layout";
import type { EyeShape } from "../mochi/engine";

export type AgentSource = "claudeCode" | "copilot" | "antigravity" | "n8n";

/** A pill that stands for a coding agent fed by hooks, rather than a poller. */
export function isAgentSource(source: AgentSource): boolean {
  return source !== "n8n";
}

/** What the "who" line calls each source. */
export const SOURCE_LABELS: Record<AgentSource, string> = {
  claudeCode: "Claude Code",
  copilot: "Copilot CLI",
  antigravity: "Antigravity",
  n8n: "n8n",
};
export type PillBadge = "approval" | "finished" | "error";

/** One line of a session as the island saw it: a prompt, a tool, a reply. */
export interface TranscriptEntry {
  role: "user" | "assistant" | "tool";
  text: string;
}

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  /** One short line per event, for the ticker. */
  steps: string[];
  /**
   * Steps appended since the session started, the dropped ones included.
   * `steps` keeps the last twenty, so its length stops moving: this is what
   * tells the ticker that something new arrived.
   */
  stepCount?: number;
  /** The same events in full, for the session view. */
  transcript: TranscriptEntry[];
  source: AgentSource;
  isIntegration: boolean;
  /** A live CLI session (one pill per session), as opposed to the agent's standing pill. */
  isSession?: boolean;
  /**
   * It finished while another pill had the screen, and nobody has looked at
   * it since. The badge, the glow and the finished pose all stay until then.
   */
  unread?: boolean;
  /** performance.now() of the last hook event, to order cards by recency. */
  lastEvent?: number;
  /**
   * The pipe of the coucou-pty wrapping this session's terminal, when the CLI
   * was started through it: the island can type into that terminal.
   */
  pty?: string | null;
  /**
   * A question the agent put to the person and is waiting on — Copilot's
   * `ask_user`, Claude Code's `AskUserQuestion`. Cleared when the tool returns.
   */
  question?: AgentQuestion | null;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;
}

/** One field of an agent's question: a select list, or a free-text line when it has no choices. */
export interface QuestionField {
  title: string;
  choices: string[];
  required: boolean;
  /** The choice the CLI's list starts on, when the schema names a default. */
  defaultIndex: number | null;
}

/** What the person picked for one field. */
export type QuestionAnswer = { choice: number } | { text: string } | { skip: true };

/**
 * What an agent asked. Copilot's ask_user is a small form: one field per
 * schema property, answered in order in its terminal, so the card walks
 * them in the same order.
 */
export interface AgentQuestion {
  text: string;
  fields: QuestionField[];
  /** The field the terminal is on now. */
  current: number;
  /** Everything was typed into the terminal; the tool has not returned yet. */
  answered?: string | null;
}

/** One field of a tool's input, laid out for reading on the approval card. */
export interface ApprovalSection {
  label: string;
  value: string;
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  /** The pill (agent) the request belongs to. */
  taskId: string;
  tool: string;
  /** One line: the tool and the file, URL or pattern it is aimed at. */
  command: string;
  /**
   * Everything else the tool was handed, in full: a Write's content, an Edit's
   * old and new strings, an MCP tool's arguments. Empty when the headline says
   * it all (a Read of one file).
   */
  sections: ApprovalSection[];
  /** Estimated lines of text on the card, which is what sets its height. */
  lines: number;
  /** The relay cut something: what is on screen is not the whole request. */
  truncated: boolean;
  /**
   * An ACP agent's request rather than a hook's: answered with one of the
   * option ids it offered, through the agent's own connection.
   */
  acp?: { agentId: string; requestId: unknown; allowOption: string | null; denyOption: string | null };
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** A tool the agent ran, shown small; or a reply still streaming in. */
  kind?: "tool" | "streaming";
}

/** A coding agent the island can start and talk to over ACP — mirror of acp::AgentProfile. */
export interface AgentProfile {
  id: string;
  name: string;
  command: string;
  args: string[];
  /** "{secret}" in a value becomes the key from the Credential Manager, in Rust. */
  env: Record<string, string>;
  cwd: string;
}

export const DEFAULT_AGENT: AgentProfile = {
  id: "copilot",
  name: "Copilot CLI",
  command: "copilot",
  args: ["--acp", "--stdio"],
  env: {},
  cwd: "",
};

/** What the chat talks to: a provider id, or `agent:<id>` for an ACP agent. */
export function activeAgentId(settings: Settings): string | null {
  return settings.activeProvider.startsWith("agent:") ? settings.activeProvider.slice(6) : null;
}

export type PromptContext =
  | { kind: "window"; appName: string; title: string; url?: string }
  | { kind: "file"; name: string; path?: string };

export interface ResultItem {
  label: string;
  detail: string;
  url?: string;
}

export interface SearchResult {
  title: string;
  items: ResultItem[];
  note?: string;
}

const task = (
  id: string, name: string, color: string, source: AgentSource,
): AgentTask => ({
  id, name, color, state: "idle", stepIndex: 0, steps: [], transcript: [], source, isIntegration: true,
});

/** How much of a session the island remembers for the session view. */
const MAX_TRANSCRIPT = 60;

/** Pills shown next to the focused card: three rows of two. */
export const MAX_PILLS = 6;

/** The standing pill each hook agent falls back to when it has no session. */
const AGENT_PILLS: Record<string, string> = {
  claudeCode: "integration_claude",
  copilot: "integration_copilot",
  antigravity: "integration_antigravity",
};

/** AgentTask.integrationAgents — same ids, names and colours as macOS. */
export const INTEGRATION_AGENTS: AgentTask[] = [
  task("integration_claude", "VS Code", "#F5F6F8", "claudeCode"),
  task("integration_copilot", "Copilot", "#7EE787", "copilot"),
  task("integration_antigravity", "Antigravity", "#8AB4F8", "antigravity"),
  task("integration_resend", "Resend", "#22C55E", "n8n"),
  task("integration_n8n", "n8n", "#F29B38", "n8n"),
  task("integration_vercel", "Vercel", "#7C5CFF", "n8n"),
  task("integration_github", "GitHub", "#F4505E", "n8n"),
  task("integration_notion", "Notion", "#8C8C8C", "n8n"),
  task("integration_calcom", "Cal.com", "#C9956A", "n8n"),
  task("integration_stripe", "Stripe", "#0570DE", "n8n"),
];

export const TOGGLEABLE_INTEGRATION_IDS = [
  "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  "integration_notion", "integration_calcom", "integration_stripe",
];

/** What an integration poller last reported. */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
}

/** One endpoint the chat can talk to — mirror of llm::Provider in Rust. */
export interface Provider {
  id: string;
  name: string;
  /** "anthropic" (Messages API) or "openai" (Chat Completions / Responses). */
  kind: "anthropic" | "openai";
  baseUrl: string;
  model: string;
  /** OpenAI kind only: "chat" or "responses". */
  wireApi: "chat" | "responses";
  /** "", "bearer", "x-api-key", "none" or "header:<name>". Empty = the kind's default. */
  auth: string;
  headers: Record<string, string>;
  capabilities: { images?: boolean | null; pdf?: boolean | null; webSearch?: boolean | null };
}

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  absenceInterval: number;
  activeIntegrations: string[];
  screen: "primary" | "cursor";
  autostart: boolean;
  hooksInstalled: boolean;
  copilotHooksInstalled: boolean;
  /** Copilot's permission requests come to the island; off keeps that hook out of its file. */
  copilotPermissionCards: boolean;
  antigravityHooksInstalled: boolean;
  /** Pre-provider builds' model; Rust turns it into the first provider. */
  model: string;
  /** Global shortcut that opens and shuts the island; empty disables it. */
  hotkey: string;
  providers: Provider[];
  activeProvider: string;
  /** Sessions shown as cards side by side in the overview (the focused one included), 1–3. */
  maxSessionCards: number;
  /** Never hide: the island stays at least compact at the top of the screen. */
  alwaysVisible: boolean;
  /** Seconds the compact bar stays after the mouse leaves before hiding. */
  hideAfter: number;
  /** Coding agents the island can start and talk to over ACP. */
  agents: AgentProfile[];
  /** Names the person gave to project folders, by `sessionKey(cwd)`. */
  sessionNames: Record<string, string>;
}

/** A folder as a key: no trailing slash, and case-blind like Windows paths. */
export function sessionKey(cwd: string): string {
  return cwd.replace(/[\\/]+$/, "").toLowerCase();
}

export const DEFAULT_PROVIDER: Provider = {
  id: "anthropic",
  name: "Claude",
  kind: "anthropic",
  baseUrl: "https://api.anthropic.com",
  model: "claude-opus-5",
  wireApi: "chat",
  auth: "",
  headers: {},
  capabilities: {},
};

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  absenceInterval: 180,
  activeIntegrations: [
    "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  ],
  screen: "primary",
  autostart: false,
  hooksInstalled: false,
  copilotHooksInstalled: false,
  copilotPermissionCards: true,
  antigravityHooksInstalled: false,
  model: "claude-opus-5",
  hotkey: "Ctrl+Shift+Space",
  providers: [DEFAULT_PROVIDER],
  activeProvider: "anthropic",
  maxSessionCards: 2,
  alwaysVisible: false,
  hideAfter: 60,
  agents: [DEFAULT_AGENT],
  sessionNames: {},
};

type Listener = () => void;

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;

  stateOverride: BotStateName | null = null;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;

  /**
   * CSS zoom on #root that maps the webview's pixels onto window-logical ones
   * (main.ts, fitToWindow). DOM event coordinates arrive unzoomed and are
   * divided by this; everything from Rust is already logical.
   */
  zoom = 1;

  uploadProgress = 0;
  uploadDuration = 2.4;
  fileDragOver = false;

  promptContext: PromptContext | null = null;
  droppedFile: { name: string; path: string } | null = null;
  noteMessage: string | null = null;
  searchResult: SearchResult | null = null;
  chatHistory: ChatMessage[] = [];
  pendingApproval: ApprovalInfo | null = null;

  integrations: Record<string, IntegrationInfo> = {};

  lastActivity = performance.now();

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  get focusTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null;
  }

  get effectiveState(): BotStateName {
    return this.stateOverride ?? this.focusTask?.state ?? "idle";
  }

  get otherTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.id !== this.focusId);
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    this.markRead(t);
    this.notify();
  }

  /**
   * While the island is shut, the compact Mochi follows whichever session is
   * doing something, so "working" is visible without opening anything. An
   * open island is being looked at and keeps its focus.
   */
  followActivity(id: string) {
    if (this.mode === "expanded") return;
    if (this.tasks.some((t) => t.id === id)) this.focusId = id;
  }

  /** Looking at a pill is reading it: badge off, pose back to rest. */
  markRead(t: AgentTask) {
    t.pillBadge = null;
    if (t.unread) {
      t.unread = false;
      if (t.state === "finished") t.state = "idle";
    }
  }

  /** The pills that replied while something else had the screen. */
  get unreadTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.unread);
  }

  /**
   * The unread sessions that get a card of their own beside the focused one,
   * newest first, as many as the setting allows. The rest stay pills.
   */
  get extraCards(): AgentTask[] {
    const room = Math.max(1, Math.min(3, Math.round(this.settings.maxSessionCards || 2))) - 1;
    return this.unreadTasks
      .filter((t) => t.id !== this.focusId)
      .sort((a, b) => (b.lastEvent ?? 0) - (a.lastEvent ?? 0))
      .slice(0, room);
  }

  /** Everything that is neither the focused pill nor shown as a card. */
  get pillTasks(): AgentTask[] {
    const cards = new Set(this.extraCards.map((t) => t.id));
    return this.tasks.filter((t) => t.id !== this.focusId && !cards.has(t.id));
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.steps.push(step);
    if (t.steps.length > 20) t.steps.shift();
    t.stepIndex = t.steps.length - 1;
    t.stepCount = (t.stepCount ?? 0) + 1;
    this.notify();
  }

  appendTranscript(id: string, entry: TranscriptEntry) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.transcript.push(entry);
    if (t.transcript.length > MAX_TRANSCRIPT) t.transcript.shift();
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  /** The live sessions of one agent. */
  sessionsOf(source: AgentSource): AgentTask[] {
    return this.tasks.filter((t) => t.isSession && t.source === source);
  }

  /**
   * loadIntegrationTasks() — the standing VS Code pill while no Claude Code
   * session is live, the standing Copilot pill likewise once its hooks are
   * installed, the integrations opt-in (max 4). Session pills are never
   * touched here; they come and go with their sessions.
   */
  loadIntegrationTasks() {
    for (const proto of INTEGRATION_AGENTS) {
      // A standing agent pill is there only when its hooks are installed and
      // no session of it is live; with nothing installed the island is empty.
      const shouldLoad =
        (proto.id === "integration_claude" && this.settings.hooksInstalled && this.sessionsOf("claudeCode").length === 0) ||
        (proto.id === "integration_copilot" && this.settings.copilotHooksInstalled && this.sessionsOf("copilot").length === 0) ||
        (proto.id === "integration_antigravity" && this.settings.antigravityHooksInstalled && this.sessionsOf("antigravity").length === 0) ||
        this.settings.activeIntegrations.includes(proto.id);
      const idx = this.tasks.findIndex((t) => t.id === proto.id);
      if (shouldLoad && idx < 0) this.tasks.push({ ...proto, steps: [], transcript: [] });
      // A pill that is talking stays, whatever the settings say.
      if (!shouldLoad && idx >= 0 && !this.tasks[idx].steps.length) this.tasks.splice(idx, 1);
    }
    this.sortTasks();
    if (!this.focusId || !this.tasks.some((t) => t.id === this.focusId)) {
      this.focusId = this.tasks[0]?.id ?? "integration_claude";
    }
    this.notify();
  }

  /** Makes sure a standing pill exists for an agent that just sent an event. */
  ensureTask(id: string) {
    if (this.tasks.some((t) => t.id === id)) return;
    const proto = INTEGRATION_AGENTS.find((t) => t.id === id);
    if (!proto) return;
    this.tasks.push({ ...proto, steps: [], transcript: [] });
    this.sortTasks();
  }

  /**
   * One pill per session: the first event from a session creates it, named
   * after the project folder, in the agent's colour. The agent's standing
   * pill steps aside while it has live sessions.
   */
  ensureSessionTask(source: AgentSource, sessionId: string, name: string, cwd: string): string {
    const id = `session:${source}:${sessionId}`;
    if (!this.tasks.some((t) => t.id === id)) {
      const standing = INTEGRATION_AGENTS.find((t) => t.id === AGENT_PILLS[source]);
      this.tasks.push({
        id,
        name,
        color: standing?.color ?? "#F5F6F8",
        state: "idle",
        stepIndex: 0,
        steps: [],
        transcript: [],
        source,
        isIntegration: false,
        isSession: true,
        sessionCwd: cwd || null,
      });
      const standingIdx = this.tasks.findIndex((t) => t.id === AGENT_PILLS[source]);
      if (standingIdx >= 0) {
        if (this.focusId === AGENT_PILLS[source]) this.focusId = id;
        this.tasks.splice(standingIdx, 1);
      }
      this.sortTasks();
      this.notify();
    }
    return id;
  }

  /** The session is over: its pill goes, and the standing pill may return. */
  endSession(id: string) {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const source = this.tasks[idx].source;
    this.tasks.splice(idx, 1);
    if (this.focusId === id) {
      this.focusId = this.sessionsOf(source)[0]?.id ?? null;
    }
    this.loadIntegrationTasks();
  }

  /** Sessions first, in the order they appeared; then the declared pills, so nothing shuffles. */
  private sortTasks() {
    const order = INTEGRATION_AGENTS.map((t) => t.id);
    const rank = (t: AgentTask) => (t.isSession ? -1 : order.indexOf(t.id));
    this.tasks.sort((a, b) => rank(a) - rank(b));
  }

  toggleIntegration(id: string) {
    if (Object.values(AGENT_PILLS).includes(id)) return;
    const active = this.settings.activeIntegrations;
    if (active.includes(id)) {
      this.settings.activeIntegrations = active.filter((x) => x !== id);
      if (this.focusId === id) this.focusId = "integration_claude";
    } else {
      if (active.length >= 4) return;
      this.settings.activeIntegrations = [...active, id];
    }
    this.loadIntegrationTasks();
  }

  defaultView(): IslandViewName {
    if (this.tasks.length === 0) return "empty";
    // A question still waiting on the focused session comes back with the
    // island: shutting it and opening it again must not lose the choices.
    if (this.focusTask?.question) return "question";
    return "overview";
  }
}

export const State = new AppState();
