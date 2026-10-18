// What is set up and what is left: pure functions over what the settings
// window has read (hook files, installed CLIs, keys, settings). The overview,
// the sidebar badges and the setup guide all draw from these.

import type { CliInfo, HookAgent, HookStatus } from "../core/bridge";
import type { AgentProfile, Provider, Settings } from "../core/state";

export const HOOK_AGENTS: HookAgent[] = ["claude", "copilot", "antigravity"];

/** The CLI (cli_install.rs id) each hook agent belongs to. */
export const HOOK_CLI: Record<HookAgent, string> = { claude: "claude", copilot: "copilot", antigravity: "agy" };

export const HOOK_NAME: Record<HookAgent, string> = { claude: "Claude Code", copilot: "Copilot CLI", antigravity: "Antigravity" };

export type LinkState =
  | "checking"    // not read yet
  | "relay"       // coucou-hook.exe is missing: nothing can be connected
  | "unreadable"  // the tool's own settings file cannot be read
  | "update"      // connected, but the hooks differ from what this Agent Center writes
  | "connected"
  | "unconnected" // the CLI may be there; the hooks are not
  | "nocli";      // the CLI is not installed: nothing to connect yet

export type Badge = "ok" | "todo" | "update" | "missing" | "off" | "checking";

export interface HookRead {
  status: HookStatus | null;
  /** The diff `hooksPreview(agent, true)` returned; "No change." when up to date. */
  diff: string | null;
  /** Why the preview failed — the file cannot be read or is not valid JSON. */
  error: string | null;
}

/** The connection state of one hook agent. */
export function agentLink(read: HookRead | undefined, clis: CliInfo[] | null, agent: HookAgent): LinkState {
  const status = read?.status;
  if (!status) return "checking";
  if (!status.hookReady) return "relay";
  if (read?.error) return "unreadable";
  if (status.installed) {
    return read?.diff != null && read.diff.trim() !== "No change." ? "update" : "connected";
  }
  const cli = clis?.find((c) => c.id === HOOK_CLI[agent]);
  if (clis && cli && !cli.found) return "nocli";
  return "unconnected";
}

export function linkBadge(state: LinkState): Badge {
  switch (state) {
    case "checking": return "checking";
    case "connected": return "ok";
    case "update": return "update";
    case "nocli": return "missing";
    default: return "todo";
  }
}

/** Whether the CLI of `agent` was found on this PC (null while still looking). */
export function cliFound(clis: CliInfo[] | null, agent: HookAgent): boolean | null {
  if (!clis) return null;
  const cli = clis.find((c) => c.id === HOOK_CLI[agent]);
  return cli ? !!cli.found : null;
}

// ── Keys ─────────────────────────────────────────────────────────────────────

export function providerKey(p: Provider): string {
  return `provider:${p.id}`;
}

export function agentKey(a: AgentProfile): string {
  return `agent:${a.id}`;
}

/** True when the provider sends no key at all. */
export function providerNeedsNoKey(p: Provider): boolean {
  return p.auth === "none";
}

/** A provider the chat can call: an endpoint, a model, and a key unless it takes none. */
export function providerUsable(p: Provider, present: Record<string, boolean>): boolean {
  if (!p.baseUrl.trim() || !p.model.trim()) return false;
  return providerNeedsNoKey(p) || !!present[providerKey(p)];
}

/** An agent whose environment names {secret} needs the key saved for it. */
export function agentNeedsKey(a: AgentProfile): boolean {
  if (a.protocol === "n8n") return !!a.headerName?.trim();
  return Object.values(a.env ?? {}).some((v) => v.includes("{secret}"));
}

// ── What is left ─────────────────────────────────────────────────────────────

export type PageId =
  | "overview" | "connect" | "install" | "chat" | "agents" | "skills" | "integrations" | "island" | "team" | "general";

export type TodoKind =
  | "relay"                 // name: —
  | "agent-unreadable"      // name: agent
  | "agent-update"
  | "agent-unconnected"
  | "chat-no-provider"      // name: provider name ("" when there is none)
  | "chat-no-key"
  | "chat-incomplete"
  | "agent-profile-no-key"  // name: agent profile name
  | "agent-profile-no-command"
  | "agent-profile-no-url"  // an n8n node without its webhook
  | "hotkey";               // name: the hotkey

export interface Todo {
  kind: TodoKind;
  page: PageId;
  /** `data-anchor` of the card it is about. */
  anchor: string;
  name: string;
  /** Needs attention (counts) vs. an update (amber). */
  level: "todo" | "update";
  agent?: HookAgent;
}

export interface StatusInput {
  hooks: Partial<Record<HookAgent, HookRead>>;
  clis: CliInfo[] | null;
  settings: Settings;
  present: Record<string, boolean>;
  hotkeyError: string | null;
  /** Integration id → its name and the Credential Manager keys it needs (not counted; see todoList). */
  integrations: { id: string; name: string; keys: string[] }[];
}

export function todoList(input: StatusInput): Todo[] {
  const out: Todo[] = [];
  const { settings, present } = input;

  // Hooks. A missing relay blocks all three: said once.
  const reads = HOOK_AGENTS.map((a) => [a, agentLink(input.hooks[a], input.clis, a)] as const);
  if (reads.some(([, s]) => s === "relay")) {
    out.push({ kind: "relay", page: "connect", anchor: "agent-claude", name: "", level: "todo" });
  }
  for (const [agent, state] of reads) {
    const base = { page: "connect" as const, anchor: `agent-${agent}`, name: HOOK_NAME[agent], agent };
    if (state === "unreadable") out.push({ ...base, kind: "agent-unreadable", level: "todo" });
    else if (state === "update") out.push({ ...base, kind: "agent-update", level: "update" });
    // Only a CLI that is really there is worth a reminder: someone who does
    // not use Antigravity should not be told to connect it.
    else if (state === "unconnected" && cliFound(input.clis, agent) === true) {
      out.push({ ...base, kind: "agent-unconnected", level: "todo" });
    }
  }

  // The chat (and Agent Center) need one provider that can answer.
  const active = settings.providers.find((p) => p.id === settings.activeProvider);
  if (!settings.providers.length) {
    out.push({ kind: "chat-no-provider", page: "chat", anchor: "chat-add", name: "", level: "todo" });
  } else if (active) {
    if (!active.baseUrl.trim() || !active.model.trim()) {
      out.push({ kind: "chat-incomplete", page: "chat", anchor: `provider-${active.id}`, name: active.name, level: "todo" });
    } else if (!providerNeedsNoKey(active) && !present[providerKey(active)]) {
      out.push({ kind: "chat-no-key", page: "chat", anchor: `provider-${active.id}`, name: active.name, level: "todo" });
    }
  } else if (!settings.providers.some((p) => providerUsable(p, present))) {
    // The chat bar talks to an agent; Agent Center still needs a provider.
    const first = settings.providers[0];
    out.push({ kind: "chat-no-key", page: "chat", anchor: `provider-${first.id}`, name: first.name, level: "todo" });
  }

  for (const a of settings.agents) {
    if (a.protocol === "n8n" ? !a.url?.trim() : !a.command.trim()) {
      out.push({ kind: a.protocol === "n8n" ? "agent-profile-no-url" : "agent-profile-no-command", page: "agents", anchor: `agent-profile-${a.id}`, name: a.name, level: "todo" });
    } else if (agentNeedsKey(a) && !present[agentKey(a)]) {
      out.push({ kind: "agent-profile-no-key", page: "agents", anchor: `agent-profile-${a.id}`, name: a.name, level: "todo" });
    }
  }

  // A pill that is on without its key is not counted: four are on by default,
  // so it would greet everyone with four chores they never asked for. The
  // Integrations page says "Needs a key" on each.

  if (input.hotkeyError) {
    out.push({ kind: "hotkey", page: "island", anchor: "hotkey", name: settings.hotkey, level: "todo" });
  }
  return out;
}

export interface PageBadge {
  /** Things to do on this page (red number). */
  todo: number;
  /** Only updates are left (amber "!"). */
  update: boolean;
  /** Everything on it is set up (green ✓). */
  ok: boolean;
}

/** The sidebar badge of each page. */
export function pageBadges(input: StatusInput, todos: Todo[] = todoList(input)): Record<PageId, PageBadge> {
  const pages: PageId[] = ["overview", "connect", "install", "chat", "agents", "skills", "integrations", "island", "team", "general"];
  const out = {} as Record<PageId, PageBadge>;
  for (const p of pages) {
    const mine = p === "overview" ? todos : todos.filter((t) => t.page === p);
    out[p] = {
      todo: mine.filter((t) => t.level === "todo").length,
      update: mine.some((t) => t.level === "update"),
      ok: false,
    };
  }
  const connected = HOOK_AGENTS.some((a) => agentLink(input.hooks[a], input.clis, a) === "connected");
  out.connect.ok = connected && out.connect.todo === 0 && !out.connect.update;
  out.chat.ok = out.chat.todo === 0 && input.settings.providers.length > 0;
  return out;
}

/** Count shown as "N things left": every to-do and every update. */
export function leftCount(todos: Todo[]): number {
  return todos.length;
}

/**
 * The setup guide opens by itself only for someone who has not set anything
 * up: never dismissed or finished, and none of the three agents connected.
 * Until all three hook files have been read it waits.
 */
export function shouldAutoShowGuide(flag: string | null, hooks: Partial<Record<HookAgent, HookRead>>): boolean {
  if (flag === "done" || flag === "later") return false;
  const statuses = HOOK_AGENTS.map((a) => hooks[a]?.status);
  if (statuses.some((s) => !s)) return false;
  return statuses.every((s) => !s!.installed);
}
