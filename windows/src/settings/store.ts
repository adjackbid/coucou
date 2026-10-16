// The settings window's copy of the preferences, and what it has read about
// this PC (hook files, installed CLIs, saved keys). Every page reads and writes
// these; Rust echoes each save back as `settings-changed`, which replaces
// `settings` (see `live()` in the provider and agent cards).

import { applyTheme } from "../core/theme";
import { Bridge, IS_TAURI, type CliInfo, type HookAgent } from "../core/bridge";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import type { TeamAgentsView } from "../team/types";
import { HOOK_AGENTS, agentKey, providerKey, type HookRead, type StatusInput } from "./status";

export let settings: Settings = { ...DEFAULT_SETTINGS };
export let version = "";

export function replaceSettings(next: Settings) {
  settings = next;
  applyTheme(settings.theme);
  changed();
}

export function setVersion(v: string) {
  version = v;
}

export async function save() {
  await Bridge.saveSettings(settings);
  changed();
}

// ── What has been read ───────────────────────────────────────────────────────

/** Which Credential Manager keys hold something. */
export const present: Record<string, boolean> = {};

export const hooks: Partial<Record<HookAgent, HookRead>> = {};

export let clis: CliInfo[] | null = null;
export let clisChecking = false;
export let hotkeyError: string | null = null;
export let teamAgents: TeamAgentsView | null = null;

/** The pills' keys, filled in by the Integrations page's definitions. */
export const integrationKeys: StatusInput["integrations"] = [];

export function statusInput(): StatusInput {
  return { hooks, clis, settings, present, hotkeyError, integrations: integrationKeys };
}

const listeners = new Set<() => void>();
let pending = false;

/** Runs `fn` (once per tick) whenever something above changes. */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function changed() {
  if (pending) return;
  pending = true;
  queueMicrotask(() => {
    pending = false;
    for (const fn of [...listeners]) fn();
  });
}

/** Re-reads one hook agent's file: its status, and the diff a reinstall would make. */
export async function refreshHook(agent: HookAgent) {
  const status = (await Bridge.hooksStatus(agent)) ?? (IS_TAURI ? null : demoHook(agent));
  let diff: string | null = null;
  let error: string | null = null;
  if (status && IS_TAURI) {
    try {
      diff = (await Bridge.hooksPreview(agent, true))?.diff ?? null;
    } catch (err) {
      error = String(err).replace(/^Error:\s*/, "");
    }
  } else if (status) {
    diff = "No change."; // i18n-ok: what Rust answers, compared, never shown
  }
  hooks[agent] = { status, diff, error };
  changed();
}

export async function refreshHooks() {
  await Promise.all(HOOK_AGENTS.map(refreshHook));
}

/** Finds the installed CLIs (runs each one's --version: slow, so in the background). */
export async function refreshClis() {
  clisChecking = true;
  if (!clis) clis = (await Bridge.cliList()) ?? null;
  changed();
  const found = await Bridge.cliStatus();
  clis = found ?? clis ?? (IS_TAURI ? [] : DEMO_CLIS);
  clisChecking = false;
  changed();
}

/**
 * After a language change: the CLIs' purposes and notes again, in the new
 * language (Rust writes them), keeping what was found on this PC.
 */
export async function relabelClis() {
  if (!clis) return;
  const defs = await Bridge.cliList();
  if (!defs) return;
  const before = clis;
  clis = defs.map((c) => ({ ...c, found: before.find((o) => o.id === c.id)?.found ?? null, version: before.find((o) => o.id === c.id)?.version ?? null }));
  changed();
}

export function setClis(next: CliInfo[]) {
  clis = next;
  changed();
}

export async function refreshHotkey() {
  hotkeyError = (await Bridge.hotkeyStatus()) ?? null;
  changed();
}

export async function refreshTeamAgents() {
  try {
    teamAgents = await Bridge.teamAgentsLoad();
  } catch {
    teamAgents = null;
  }
  changed();
}

export const INTEGRATION_SECRET_KEYS = [
  "stripe-api-key", "github-token", "vercel-token",
  "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
];

/** Which keys are saved: the pills', every provider's and every agent's. */
export async function refreshPresent() {
  const keys = [...INTEGRATION_SECRET_KEYS];
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;
  for (const p of settings.providers) {
    let has = (await Bridge.secretPresent(providerKey(p))) ?? false;
    // The default Claude entry still honours the key saved before providers existed.
    if (!has && p.id === "anthropic") has = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
    present[providerKey(p)] = has;
  }
  for (const a of settings.agents) present[agentKey(a)] = (await Bridge.secretPresent(agentKey(a))) ?? false;
  changed();
}

export function setPresent(key: string, value: boolean) {
  present[key] = value;
  changed();
}

// ── The page in a plain browser (no app behind it) ───────────────────────────

const demo = new URLSearchParams(typeof location !== "undefined" ? location.search : "");

/** `?demo=fresh` shows a PC with nothing connected; the default, Steven's. */
function demoHook(agent: HookAgent) {
  const fresh = demo.get("demo") === "fresh";
  const installed = !fresh && agent !== "claude";
  const base = "C:\\Users\\you";
  return {
    installed,
    settingsPath:
      agent === "claude" ? `${base}\\.claude\\settings.json`
      : agent === "copilot" ? `${base}\\.copilot\\hooks\\coucou.json`
      : `${base}\\.gemini\\config\\hooks.json`,
    hookPath: `${base}\\AppData\\Local\\Coucou\\bin\\coucou-hook.exe`,
    hookReady: demo.get("demo") !== "norelay",
  };
}

const DEMO_CLIS: CliInfo[] = [
  { id: "claude", name: "Claude Code", command: "claude", purpose: "Anthropic's coding agent.", docs: "https://code.claude.com/docs/en/setup", found: "C:\\Users\\you\\.local\\bin\\claude.exe", version: "2.1.211 (Claude Code)", methods: [{ label: "PowerShell", command: "irm https://claude.ai/install.ps1 | iex", note: "Recommended.", source: "confirmed" }, { label: "WinGet", command: "winget install Anthropic.ClaudeCode", note: "Does not update itself.", source: "built-in" }] }, // i18n-ok: demo data, mirrors cli_install.rs
  { id: "codex", name: "Codex CLI", command: "codex", purpose: "OpenAI's coding agent.", docs: "https://github.com/openai/codex", found: null, version: null, methods: [{ label: "PowerShell", command: "irm https://chatgpt.com/codex/install.ps1 | iex", note: "Official Windows installer.", source: "built-in" }, { label: "npm", command: "npm install -g @openai/codex", note: "Needs Node.js.", source: "built-in" }] }, // i18n-ok: demo data, mirrors cli_install.rs
  { id: "copilot", name: "Copilot CLI", command: "copilot", purpose: "GitHub's coding agent.", docs: "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli", found: "C:\\Users\\you\\AppData\\Roaming\\npm\\copilot.cmd", version: "1.0.92", methods: [{ label: "WinGet", command: "winget install GitHub.Copilot", note: "", source: "built-in" }] }, // i18n-ok: demo data, mirrors cli_install.rs
  { id: "agy", name: "Antigravity CLI (agy)", command: "agy", purpose: "Google Antigravity's agent.", docs: "https://antigravity.google/docs/getting-started?tab=cli", found: demo.get("demo") === "fresh" ? null : "C:\\Users\\you\\AppData\\Local\\agy\\bin\\agy.exe", version: "1.3.1", methods: [{ label: "PowerShell", command: "irm https://antigravity.google/cli/install.ps1 | iex", note: "Official Windows installer.", source: "unconfirmed" }] }, // i18n-ok: demo data, mirrors cli_install.rs
  { id: "gemini", name: "Gemini CLI", command: "gemini", purpose: "Google's open-source CLI agent.", docs: "https://github.com/google-gemini/gemini-cli", found: null, version: null, methods: [{ label: "npm", command: "npm install -g @google/gemini-cli", note: "Needs Node.js.", source: "built-in" }] }, // i18n-ok: demo data, mirrors cli_install.rs
  { id: "node", name: "Node.js", command: "node", purpose: "Needed by the npm installers.", docs: "https://nodejs.org/en/download", found: "C:\\Program Files\\nodejs\\node.exe", version: "v22.23.3", methods: [{ label: "WinGet", command: "winget install OpenJS.NodeJS.LTS", note: "", source: "built-in" }] }, // i18n-ok: demo data, mirrors cli_install.rs
  { id: "git", name: "Git", command: "git", purpose: "Recommended for Claude Code.", docs: "https://git-scm.com/downloads/win", found: "C:\\Program Files\\Git\\cmd\\git.exe", version: "2.56.0", methods: [{ label: "WinGet", command: "winget install --id Git.Git -e --source winget", note: "", source: "built-in" }] }, // i18n-ok: demo data, mirrors cli_install.rs
];
