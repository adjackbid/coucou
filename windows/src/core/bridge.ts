// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { AgentProfile, ModelChoice, Provider, Settings } from "./state";
import type { Constitution, ConstitutionLevel, Found, KeySpend, PastRun, PricingChoices, SecretaryProposal, SecretaryReply, Snapshot, TeamConfig, TeamFile, UsageReport } from "../team/types";

export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.error(`[coucou] ${cmd} failed`, err);
    return null;
  }
}

export interface BootInfo {
  settings: Settings;
  /** Logical screen rect of the monitor the island lives on. */
  screen: { x: number; y: number; width: number; height: number; scale: number };
  version: string;
  hookPath: string;
}

export const Bridge = {
  boot: () => call<BootInfo>("boot"),

  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),

  /** Shrink the window down to the invisible wake strip (hidden) or back to full. */
  setCollapsed: (collapsed: boolean) => call<void>("set_collapsed", { collapsed }),

  /**
   * Pushes the island shape in window coordinates. Rust flips click-through from
   * its own cursor poll, so the flag is never a frame behind a click.
   */
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    call<void>("set_island_rect", { x, y, width, height }),

  /** Give the window keyboard focus (chat field) and take it away again. */
  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),

  reposition: () => call<void>("reposition"),

  openUrl: (url: string) => call<void>("open_url", { url }),

  /** "Open terminal" → opens the folder in VS Code when `code` is on PATH. */
  openInVSCode: (path: string | null) => call<boolean>("open_in_vscode", { path }),

  quit: () => call<void>("quit_app"),

  openSettingsWindow: () => call<void>("open_settings_window"),

  /** Writes to %LOCALAPPDATA%\Coucou\coucou.log, next to the Rust lines. */
  log: (message: string) => call<void>("log_line", { message }),

  // ── CLI hooks (Claude Code, Copilot CLI) ──────────────────────────────────
  hooksStatus: (agent: HookAgent) => call<HookStatus>("hooks_status", { agentName: agent }),
  /** Diff to show before anything is written. `install: false` previews removal. */
  hooksPreview: (agent: HookAgent, install: boolean) =>
    callOrThrow<HookPreview>("hooks_preview", { agentName: agent, install }),
  /**
   * Writes the agent's hook file — only ever after an explicit click, and only
   * when the file still matches the preview the user looked at.
   */
  hooksApply: (agent: HookAgent, install: boolean, fingerprint: string) =>
    callOrThrow<string>("hooks_apply", { agentName: agent, install, fingerprint }),

  approvalDecision: (requestId: string, decision: "allow" | "deny") =>
    call<void>("approval_decision", { requestId, decision }),
  /** "The card is up" — until this lands the relay only waits a moment. */
  approvalAck: (requestId: string) => call<void>("approval_ack", { requestId }),
  /** "Nobody can act on this" — Claude Code asks in the terminal right away. */
  approvalDecline: (requestId: string) => call<void>("approval_decline", { requestId }),

  // ── Chat, files, secrets ──────────────────────────────────────────────────
  /** One chat turn. The API key and any file bytes never leave Rust. */
  chatSend: (query: string, context: ChatContext | null) =>
    callOrThrow<{ text: string }>("chat_send", { query, context }),
  chatReset: () => call<void>("chat_reset"),
  /** Copies a dropped file into the inbox. */
  ingestFile: (path: string) => callOrThrow<DroppedFile>("ingest_file", { path }),
  /**
   * Writes a file the page got from an HTML5 drop into the inbox. The bytes go
   * as the raw request body; the name, URL-encoded, in a header.
   */
  ingestBytes: (name: string, bytes: ArrayBuffer) => {
    if (!IS_TAURI) throw new Error("not running inside Coucou");
    return invoke<DroppedFile>("ingest_bytes", new Uint8Array(bytes), {
      headers: { "x-file-name": encodeURIComponent(name) },
    });
  },
  /** Only ever tells you whether a key exists — never its value. */
  secretPresent: (key: string) => call<boolean>("secret_present", { key }),
  secretSet: (key: string, value: string) => callOrThrow<void>("secret_set", { key, value }),
  secretClear: (key: string) => callOrThrow<void>("secret_clear", { key }),

  // ── Integrations ──────────────────────────────────────────────────────────
  refreshIntegration: (id: string) => call<void>("refresh_integration", { id }),
  /** Opens the configured n8n instance in the browser. */
  openN8n: () => call<void>("open_n8n"),

  /** Tray → Pause. Stops the integration pollers, not just the island. */
  setPaused: (paused: boolean) => call<void>("set_paused", { paused }),

  /** Why the global shortcut is not active; null when it is. */
  hotkeyStatus: () => call<string | null>("hotkey_status"),

  /** One tiny round trip to a provider as the form describes it. The key stays in Rust. */
  providerTest: (provider: Provider) => callOrThrow<string>("provider_test", { provider }),
  /** The model ids the endpoint lists (`GET /v1/models`). */
  providerModels: (provider: Provider) => callOrThrow<string[]>("provider_models", { provider }),

  /** Types text into a terminal wrapped by coucou-pty, and submits it. */
  ptySend: (pipe: string, text: string) => callOrThrow<void>("pty_send", { pipe, text }),

  // ── ACP agents ────────────────────────────────────────────────────────────
  /** One prompt to an agent; the reply streams in as `acp-update` events. */
  acpSend: (agentId: string, text: string) =>
    callOrThrow<{ stopReason: string }>("acp_send", { agentId, text }),
  /** The island's answer to the agent's permission request. */
  acpPermission: (agentId: string, requestId: unknown, optionId: string | null) =>
    call<void>("acp_permission", { agentId, requestId, optionId }),
  acpCancel: (agentId: string) => call<void>("acp_cancel", { agentId }),
  /** The next prompt starts a fresh session. */
  acpReset: (agentId: string) => call<void>("acp_reset", { agentId }),
  /** Starts the agent as the form describes it, shakes hands, stops it. */
  acpTest: (profile: AgentProfile) => callOrThrow<string>("acp_test", { profile }),
  /** The models an agent offers (a handshake, no prompt: nothing is spent). */
  agentModels: (profile: AgentProfile) => callOrThrow<ModelChoice[]>("agent_models", { profile }),

  // ── Teams ─────────────────────────────────────────────────────────────────
  openTeamWindow: () => call<void>("open_team_window"),
  /** The team files in %APPDATA%\Coucou\teams, each with what stops it from starting. */
  teamFiles: () => call<{ dir: string; files: TeamFile[] }>("team_files"),
  teamSnapshots: () => call<Snapshot[]>("team_snapshots"),
  /** Starts the team a file describes — only ever from an explicit click. */
  teamStart: (file: string) => callOrThrow<Snapshot>("team_start", { file }),
  /** The person writes to the leader (`to` empty) or to one member. */
  /** A team's earlier runs, newest first; one of them as it ended. */
  teamHistory: (team: string) => callOrThrow<PastRun[]>("team_history", { team }),
  teamPast: (team: string, archivedAt: number) => callOrThrow<Snapshot>("team_past", { team, archivedAt }),
  /** Every team's usage in [from, to) (ms), priced, with who spent it. */
  usageReport: (from: number, to: number) => callOrThrow<UsageReport>("usage_report", { from, to }),
  /** The price each model is charged at now, and the person's currency. */
  pricingQuote: (models: string[]) => call<[Record<string, Found | null>, PricingChoices]>("pricing_quote", { models }),
  pricingSave: (choices: PricingChoices) => callOrThrow<void>("pricing_save", { choices }),
  /** Fetches the public price list (LiteLLM's); how many models it prices. */
  pricingFetchList: () => callOrThrow<number>("pricing_fetch_list"),
  /** Reads the prices an agent's own endpoint gives (a LiteLLM proxy); how many. */
  pricingFromAgent: (agent: string) => callOrThrow<number>("pricing_from_agent", { agent }),
  /** The person's constitution: rules every agent keeps. */
  constitutionLoad: () => callOrThrow<Constitution>("constitution_load"),
  constitutionSave: (constitution: Constitution) => callOrThrow<void>("constitution_save", { constitution }),
  /** Which rule a command falls under, if any, and at what level. */
  constitutionTry: (command: string) => call<[ConstitutionLevel, string] | null>("constitution_try", { command }),
  /** Each agent's own folder (agent id, path), for the team setup. */
  teamAgentFolders: () => call<[string, string][]>("team_agent_folders"),
  /** The chat providers the secretary can think with: (id, name, model). */
  secretaryProviders: () => call<[string, string, string][]>("secretary_providers"),
  /** The person asks the secretary; its steps arrive as `secretary-step` while it works. */
  secretaryAsk: (text: string, provider: string | null, tzMinutes: number, name: string) => callOrThrow<SecretaryReply>("secretary_ask", { text, provider, tzMinutes, name }),
  /** Carries out one of its proposals — only ever from the click on its card. */
  secretaryConfirm: (id: string, tzMinutes: number) => callOrThrow<SecretaryProposal>("secretary_confirm", { id, tzMinutes }),
  secretaryDecline: (id: string) => call<SecretaryProposal | null>("secretary_decline", { id }),
  secretaryReset: () => call<void>("secretary_reset"),
  /** What an agent's own endpoint has billed its key (asked only on a click). */
  endpointSpend: (agent: string) => callOrThrow<KeySpend>("endpoint_spend", { agent }),
  /** A deliverable that is a picture in the team's work folder, as bytes. */
  teamPreview: (team: string, locator: string) => callOrThrow<ArrayBuffer>("team_preview", { team, locator }),
  /** Returns the message's id; the same `request` sent again is not sent twice. */
  teamInstruct: (team: string, to: string, text: string, request?: string) => callOrThrow<string>("team_instruct", { team, to, text, request }),
  /**
   * An image (or any file) for an instruction, from its bytes: copied into the
   * team's folder (.coucou/attachments). Returns its full path there.
   */
  teamAttachBytes: (team: string, name: string, bytes: ArrayBuffer) => {
    if (!IS_TAURI) return Promise.resolve(`D:\\demo\\.coucou\\attachments\\${name}`);
    return invoke<string>("team_attach_bytes", new Uint8Array(bytes), {
      headers: { "x-team": encodeURIComponent(team), "x-file-name": encodeURIComponent(name) },
    });
  },
  /** The same for a file dragged onto the window, by its path. */
  teamAttachPath: (team: string, path: string) => callOrThrow<string>("team_attach_path", { team, path }),
  teamAnswer: (team: string, question: string, text: string) => callOrThrow<void>("team_answer", { team, question, text }),
  /**
   * Answers the oldest request a member's agent is holding with one of its own
   * options — or, with `all`, every request it holds, each the same way.
   */
  teamPermit: (team: string, member: string, optionId: string | null, all = false) =>
    callOrThrow<void>("team_permit", { team, member, optionId, all }),
  teamPause: (team: string) => callOrThrow<void>("team_pause", { team }),
  teamResume: (team: string) => callOrThrow<void>("team_resume", { team }),
  /** Pause, and interrupt every turn under way. */
  teamInterrupt: (team: string) => callOrThrow<void>("team_interrupt", { team }),
  teamRecover: (team: string, member: string) => callOrThrow<void>("team_recover", { team, member }),
  /** More hands: the members the team file has and the running team does not join it now. */
  teamJoin: (file: string) => callOrThrow<string[]>("team_join", { file }),
  /** Interrupts one member's turn — one that has gone quiet; the team carries on. */
  teamInterruptMember: (team: string, member: string) => callOrThrow<void>("team_interrupt_member", { team, member }),
  /** Opens something a member handed in: a URL, or a path in Explorer. */
  teamOpen: (team: string, locator: string) => callOrThrow<void>("team_open", { team, locator }),
  teamOpenConfigs: () => call<void>("team_open_configs"),
  /** Writes a team file from the form; the file is named after the team's id. */
  teamSave: (file: string, config: TeamConfig) => callOrThrow<void>("team_save", { file, config }),
  /** A copy of a team file (same goal and members); returns the new file's name. */
  teamDuplicate: (file: string) => callOrThrow<string>("team_duplicate", { file }),
  /** Takes a team off the list: its file moves to the teams folder's `.deleted`. */
  teamDelete: (file: string) => callOrThrow<void>("team_delete", { file }),
  /** Puts a team away, or takes it out again. */
  teamArchive: (file: string, archived: boolean) => callOrThrow<void>("team_archive", { file, archived }),
  /** A new team file with one member to fill in; returns its name. */
  teamNew: () => callOrThrow<string>("team_new"),
  /** The system's folder dialog; null when cancelled. */
  pickFolder: (start: string, title: string) => callOrThrow<string | null>("pick_folder", { start, title }),
  /** The Teamwork window draws its own title bar: minimize, maximize, drag, close. */
  teamWindow: (action: "minimize" | "maximize" | "drag" | "close") => call<void>("team_window", { action }),
};

/** A `session/update` from an agent. */
export interface AcpUpdate {
  agentId: string;
  update: {
    sessionUpdate: string;
    content?: { type: string; text?: string };
    title?: string;
    kind?: string;
    status?: string;
    toolCallId?: string;
  };
}

/** A `session/request_permission` from an agent. */
export interface AcpPermission {
  agentId: string;
  requestId: unknown;
  title: string;
  kind: string;
  rawInput: unknown;
  options: { optionId: string; name: string; kind: string }[];
  /** The constitution's rule that asks about it, when one does. */
  rule?: string;
}

export interface IntegrationUpdate {
  id: string;
  data: Record<string, unknown>;
  error: string | null;
  event: { success: boolean; label: string; detail: string | null } | null;
}

export type ChatContext =
  | { kind: "file"; name: string; path: string }
  | { kind: "window"; appName: string; title: string; url?: string };

export interface DroppedFile {
  name: string;
  path: string;
  size: number;
}

/** The CLIs whose hooks Coucou can install; same names as `hooks::Agent` in Rust. */
export type HookAgent = "claude" | "copilot" | "antigravity";

export interface HookStatus {
  installed: boolean;
  settingsPath: string;
  hookPath: string;
  hookReady: boolean;
}

export interface HookPreview {
  diff: string;
  backup: string;
  settingsPath: string;
  /** Hand back to hooksApply so only the reviewed diff is ever written. */
  fingerprint: string;
}

/** Same as `call`, but surfaces the error so the UI can show what went wrong. */
async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("not running inside Coucou");
  return invoke<T>(cmd, args);
}

export type BridgeEvent =
  | { name: "cursor"; payload: { x: number; y: number } }
  | { name: "tray"; payload: string }
  | { name: "hook"; payload: Record<string, unknown> }
  | { name: "screen-changed"; payload: null };

export interface DragDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
}

/** Files dragged onto the island. Only reaches us when the window takes the mouse. */
export async function onDragDrop(handler: (e: DragDropPayload) => void) {
  if (!IS_TAURI) return () => {};
  return getCurrentWebview().onDragDropEvent((event) => {
    handler(event.payload as DragDropPayload);
  });
}

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) return () => {};
  return listen<T>(name, (e) => handler(e.payload));
}
