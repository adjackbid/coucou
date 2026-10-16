// Agent Pool: agents of the person's own making for their teams. Each is built
// on a native agent of Settings → Agent Provider — its command (or an n8n node's
// webhook), environment and key — and adds a name, a model, a system prompt,
// MCP servers, skills, and a description Agent Center reads to pick
// members. What a base's protocol cannot take is said here rather than
// dropped quietly (team_agents.rs).
//
// New teams — Agent Center's and the ones made by hand — take their agents
// from here only. The page lists them as Cloud Agents and Local Agents, as
// their bases are (views/agent-kind.ts).

import "./agents.css";
import { Bridge, IS_TAURI } from "../core/bridge";
import { tr, trf } from "../core/i18n";
import { locationOf, type AgentLocation, type AgentProfile, type ModelChoice } from "../core/state";
import { kindIcon, markColor, markHint, markName, markOf, type KindMark } from "../views/agent-kind";
import { capsView, forgetCaps } from "../views/caps";
import { h } from "../views/dom";
import { CHEVRON, dropdown, refreshSuggestions, suggest, type Choice } from "./ui";
import type { TeamAgent, TeamAgentMcp, TeamAgents, TeamAgentSupport, TeamAgentSupports } from "./types";

export interface AgentsHost {
  render(): void;
  /** Settings → Agent Provider. */
  natives(): AgentProfile[];
  /** The teams whose members run as this agent, by name. */
  usedBy(id: string): string[];
  openSettings(): void;
}

let doc: TeamAgents | null = null;
let supports: Record<string, TeamAgentSupports> = {};
let loading = false;
/** What the last load or save said; the words are picked when drawn. */
let state: "" | "saved" | "unreadable" = "";
let stateError = "";
/** The agent being edited (a copy), and whether it is new. */
let draft: TeamAgent | null = null;
let draftIsNew = false;
/** A new agent's section: its base is picked among that kind only. */
let draftWhere: AgentLocation | null = null;
let problem = "";
/** The agent whose 刪除 has been pressed once. */
let deleting: string | null = null;
/** The category the page is narrowed to: null for all of them, "" for the agents with none. */
let only: string | null = null;
/** Cards in their Cloud and Local panels, or every agent on rings around Agent Center; kept per person. */
let view: PoolView = readView();
/** When the ring view was opened: its agents fly out from the centre for a moment. */
let unfoldAt = 0;

type PoolView = "cards" | "ring";

function readView(): PoolView {
  try {
    return localStorage.getItem("coucou.agentPool.view") === "ring" ? "ring" : "cards";
  } catch {
    return "cards";
  }
}

function setView(next: PoolView, render: () => void) {
  view = next;
  if (next === "ring") unfoldAt = performance.now();
  try {
    localStorage.setItem("coucou.agentPool.view", next);
  } catch {
    // Not kept: the page still works, with the cards next time.
  }
  render();
}

/** The categories offered before any is typed; the person may write any other. */
const presetCategories = () => [tr("程式開發", "Coding"), tr("文案製作", "Copywriting"), tr("圖片影音", "Images & video"), tr("研究分析", "Research"), tr("規劃審查", "Planning & review")];

/** Every category in use: the offered ones first, in their order, then the rest by name. */
function categoriesInUse(): string[] {
  const used = new Set(teamAgents().map((a) => a.category.trim()).filter(Boolean));
  const offered = presetCategories().filter((c) => used.has(c));
  return [...offered, ...[...used].filter((c) => !offered.includes(c)).sort((a, b) => a.localeCompare(b))];
}

/** Same category together, in the order of categoriesInUse(), the ones with none last; otherwise as added. */
function byCategory<T extends { a: TeamAgent }>(list: T[]): T[] {
  const cats = categoriesInUse();
  const rank = (a: TeamAgent) => (a.category.trim() ? cats.indexOf(a.category.trim()) : cats.length);
  return [...list].sort((x, y) => rank(x.a) - rank(y.a));
}

/** The browser preview's agents, in the language of the moment they are first read. */
const demoAgents = (): TeamAgents => ({
  agents: [
    {
      id: "ta-reviewer",
      name: tr("嚴格審查員", "Strict reviewer"),
      base: "claude",
      model: "",
      systemPrompt: tr("你是一位嚴格的程式碼審查者。每次審查都要列出風險、測試缺口與可以更簡單的寫法。", "You are a strict code reviewer. Every review lists the risks, the missing tests and simpler ways to write it."),
      mcp: [{ name: "docs", command: "", args: [], url: "https://docs.example.com/mcp" }],
      skills: ["code-review"],
      description: tr("審查程式碼、找出風險與缺少的測試;適合當 Leader 或最後把關。", "Reviews code and finds risks and missing tests; a good Leader or final check."),
      category: tr("程式開發", "Coding"),
      effort: "high",
    },
    {
      id: "ta-designer",
      name: tr("介面設計師", "UI designer"),
      base: "agy",
      model: "",
      systemPrompt: "",
      mcp: [],
      skills: [],
      description: tr("畫介面、做圖片與排版。", "Draws interfaces, makes images and lays out pages."),
      category: tr("圖片影音", "Images & video"),
      effort: "",
    },
    {
      id: "ta-joker",
      name: tr("笑話專家", "Joke expert"),
      base: "cg",
      model: "deepseek-v4-flash",
      systemPrompt: "",
      mcp: [],
      skills: [],
      description: tr("專門用來講笑話的,不適合規劃,但要省錢寫 Code 時可以用", "Made for telling jokes. Not for planning, but fine for writing code on a budget"),
      category: "",
      effort: "low",
    },
    {
      id: "ta-painter",
      name: tr("畫圖專家", "Drawing expert"),
      base: "codex",
      model: "gpt-6.1-sol",
      systemPrompt: tr("畫圖前先確認尺寸與風格。", "Check the size and style before you draw."),
      mcp: [],
      skills: [],
      description: tr("適合拿來畫圖、生成 UI SVG,也可以寫 Code,但品質高的代價是很貴", "Good for drawing and making UI SVGs; it writes code too, but the quality comes at a high price"),
      category: tr("圖片影音", "Images & video"),
      effort: "",
    },
    {
      id: "ta-local-coder",
      name: tr("本機寫手", "Local coder"),
      base: "ollama",
      model: "",
      systemPrompt: "",
      mcp: [],
      skills: [],
      description: tr("在本機模型上寫程式;資料不出公司,適合處理機密的程式碼。", "Writes code on a local model; nothing leaves the company, so it suits confidential code."),
      category: tr("程式開發", "Coding"),
      effort: "",
    },
    {
      id: "ta-weekly",
      name: tr("週報流程", "Weekly report flow"),
      base: "n8n-report",
      model: "",
      systemPrompt: tr("用條列寫,最多 10 行。", "Use bullet points, 10 lines at most."),
      mcp: [],
      skills: [],
      description: tr("n8n 工作流程:彙整本週的工單與提交,產出一份週報。", "An n8n workflow: gathers the week's tickets and commits into a weekly report."),
      category: tr("文案製作", "Copywriting"),
      effort: "",
    },
  ],
});

function demoSupports(protocol: AgentProfile["protocol"]): TeamAgentSupports {
  if (protocol === "claude" || protocol === "codex") return { systemPrompt: "native", mcp: "native", skills: "brief", effort: "native" };
  if (protocol === "agy") return { systemPrompt: "brief", mcp: "no", skills: "brief", effort: "native" };
  if (protocol === "n8n") return { systemPrompt: "native", mcp: "no", skills: "no", effort: "native" };
  return { systemPrompt: "brief", mcp: "native", skills: "brief", effort: "native" };
}

/** Reads them once (or again, `force`); draws when they arrive. */
export async function loadTeamAgents(render: () => void, natives: AgentProfile[] = [], force = false) {
  if ((doc && !force) || loading) return;
  loading = true;
  try {
    if (IS_TAURI) {
      const view = await Bridge.teamAgentsLoad();
      // A file from before categories has none.
      doc = { agents: view.doc.agents.map((a) => ({ ...a, category: a.category ?? "", effort: a.effort ?? "" })) };
      supports = view.supports;
    } else {
      doc = doc ?? demoAgents();
      supports = Object.fromEntries(natives.map((a) => [a.id, demoSupports(a.protocol)]));
    }
  } catch (err) {
    state = "unreadable";
    stateError = String(err instanceof Error ? err.message : err);
    doc = doc ?? { agents: [] };
  }
  loading = false;
  render();
}

export function teamAgents(): TeamAgent[] {
  return doc?.agents ?? [];
}

/** How a member's agent is shown: a team agent by its name (its id is Agent Center's own), a native one by its id. */
export function agentLabel(id: string): string {
  return teamAgents().find((a) => a.id === id)?.name || id;
}

/**
 * The team agents as profiles, for names, default models, kinds and marks:
 * each its base's, under its own id. One whose base is gone is left out.
 */
export function teamProfiles(natives: AgentProfile[]): AgentProfile[] {
  return teamAgents().flatMap((a) => {
    const base = natives.find((n) => n.id === a.base);
    return base ? [{ ...base, id: a.id, name: a.name || a.id, model: a.model || base.model }] : [];
  });
}

/** The native agent a member's agent runs on: itself, or a team agent's base. */
export function baseOf(id: string, natives: AgentProfile[]): AgentProfile | undefined {
  return natives.find((n) => n.id === id) ?? natives.find((n) => n.id === teamAgents().find((a) => a.id === id)?.base);
}

/** How many team agents are Cloud and how many Local, for the sidebar. */
export function teamAgentCounts(natives: AgentProfile[]): Record<AgentLocation, number> {
  const out = { cloud: 0, local: 0 };
  for (const p of teamProfiles(natives)) out[locationOf(p)]++;
  return out;
}

/**
 * The agents a member may be given, as dropdown choices: the team agents,
 * Cloud first, then Local, each under its heading and with its mark. A
 * leader is never an n8n node. `keep` is the member's agent now: a native
 * agent from a team set up earlier stays on the list, said to be one.
 */
export function memberChoices(natives: AgentProfile[], keep: string, leader: boolean, hintOf: (p: AgentProfile) => string | undefined): Choice[] {
  const out: Choice[] = [];
  for (const where of ["cloud", "local"] as const) {
    for (const p of teamProfiles(natives).filter((p) => locationOf(p) === where)) {
      if (leader && p.protocol === "n8n" && p.id !== keep) continue;
      out.push({
        value: p.id,
        label: p.name,
        hint: p.protocol === "n8n" && leader ? tr("n8n 節點不能當 Leader", "An n8n node cannot lead") : hintOf(p),
        group: markName(where),
        groupIcon: () => kindIcon(where, 14),
        icon: () => kindIcon(markOf(p), 14),
      });
    }
  }
  const old = natives.find((n) => n.id === keep);
  if (old && !out.some((c) => c.value === keep)) {
    out.push({ value: old.id, label: old.name, hint: tr("直接用 Provider(舊設定,照樣能跑)", "A provider directly (set up earlier, still runs)"), group: "Agent Provider", icon: () => kindIcon(markOf(old), 14) });
  }
  return out;
}

async function persist(next: TeamAgents, render: () => void): Promise<boolean> {
  try {
    if (IS_TAURI) await Bridge.teamAgentsSave(next);
    doc = next;
    state = "saved";
    problem = "";
    return true;
  } catch (err) {
    problem = String(err instanceof Error ? err.message : err).replace(/^Error:\s*/, "");
    return false;
  } finally {
    render();
  }
}

function stateText(): string {
  if (state === "saved") return tr("已儲存 · 下次啟動的團隊就照新的設定", "Saved · teams started from now on use the new settings");
  if (state === "unreadable") return trf("讀不到:{why}", "Can't read them: {why}", { why: stateError });
  return "";
}

function supportText(s: TeamAgentSupport, node: boolean): string {
  if (node) return s === "no" ? tr("n8n 節點不支援", "Not for an n8n node") : tr("放進送給 n8n 的資料", "Sent to n8n with each call");
  switch (s) {
    case "native": return tr("原生支援", "Supported");
    case "brief": return tr("寫進成員的開場說明", "Added to the member's brief");
    case "no": return tr("此 agent 類型不支援", "Not supported by this agent type");
  }
}

function badge(s: TeamAgentSupport | undefined, node: boolean): HTMLElement | null {
  if (!s) return null;
  return h("span", { class: `ta-support ${s}`, text: supportText(s, node) });
}

/** `a "b c" d` → [a, b c, d]. */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2]);
  return out;
}

function joinArgs(args: string[]): string {
  return args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
}

function field(key: string, value: string, set: (v: string) => void, attrs: Record<string, string> = {}, tag: "input" | "textarea" = "input"): HTMLElement {
  const el = h(tag, { class: "field", "data-key": key, spellcheck: "false", ...attrs }) as HTMLInputElement | HTMLTextAreaElement;
  el.value = value;
  el.addEventListener("input", () => set(el.value));
  return el;
}

function mcpRow(host: AgentsHost, a: TeamAgent, m: TeamAgentMcp, at: number, off: boolean): HTMLElement {
  const remote = m.url !== "";
  const kind = h(
    "div",
    { class: "segmented small", role: "group" },
    h("button", { type: "button", class: remote ? "" : "on", onClick: () => { m.url = ""; host.render(); } }, tr("指令", "Command")),
    h("button", { type: "button", class: remote ? "on" : "", onClick: () => { m.command = ""; m.args = []; m.url = m.url || "https://"; host.render(); } }, "URL"), // i18n-ok: the same in both
  );
  return h(
    "div",
    { class: `ta-mcp${off ? " off" : ""}` },
    field(`ta-mcp-name-${at}`, m.name, (v) => (m.name = v.trim()), { placeholder: tr("名稱,例如 github", "Name, e.g. github"), class: "field ta-mcp-name" }),
    kind,
    remote
      ? field(`ta-mcp-url-${at}`, m.url, (v) => (m.url = v.trim()), { placeholder: "https://…/mcp", class: "field mono ta-mcp-main" }) // i18n-ok: CSS classes
      : h(
          "div",
          { class: "ta-mcp-main row nowrap" }, // i18n-ok: CSS classes
          field(`ta-mcp-cmd-${at}`, m.command, (v) => (m.command = v.trim()), { placeholder: tr("指令,例如 npx", "Command, e.g. npx"), class: "field mono" }),
          field(`ta-mcp-args-${at}`, joinArgs(m.args), (v) => (m.args = splitArgs(v)), { placeholder: tr("參數,以空白分隔,例如 -y @modelcontextprotocol/server-github", "Arguments, separated by spaces, e.g. -y @modelcontextprotocol/server-github"), class: "field mono" }),
        ),
    h("button", { type: "button", class: "link quiet-danger", onClick: () => { a.mcp.splice(at, 1); host.render(); } }, tr("移除", "Remove")),
  );
}

/** The models each base agent offers, asked once per window: base id → list, why not, or null while asked. */
const modelLists = new Map<string, ModelChoice[] | string | null>();

/** The efforts a provider takes, lightest first; "" leaves it to the provider. */
const EFFORTS = ["", "low", "medium", "high", "xhigh", "max"] as const;

function effortName(e: string): string {
  switch (e) {
    case "low": return tr("低", "Low");
    case "medium": return tr("中", "Medium");
    case "high": return tr("高", "High");
    case "xhigh": return tr("很高", "Very high");
    case "max": return tr("最高", "Max");
    default: return tr("預設", "Default");
  }
}

/** How hard it thinks: the provider's default, or one of its levels. Lower answers sooner and costs less. */
function effortField(host: AgentsHost, a: TeamAgent, off: boolean): HTMLElement {
  return h(
    "div",
    {},
    h(
      "div",
      { class: "segmented wrap ta-effort", role: "radiogroup", "aria-label": "Effort" }, // i18n-ok: CSS classes
      ...EFFORTS.map((e) =>
        h("button", { type: "button", role: "radio", class: (a.effort || "") === e ? "on" : "", "aria-checked": String((a.effort || "") === e), disabled: off && e !== "", onClick: () => { a.effort = e; host.render(); } }, effortName(e)),
      ),
    ),
    h("p", {
      class: "hint",
      text: off
        ? tr("這個 Provider 沒有 Effort 可以調,照它自己的預設。", "This provider has no effort to set: it keeps its own default.")
        : tr("想得越深越久、越貴;寫程式、改小東西用低或中通常就夠。預設是 Provider 自己決定。", "The harder it thinks, the longer and costlier each turn; low or medium is usually enough for code and small changes. Default leaves it to the provider."),
    }),
  );
}

/** The category, typed or picked from the ones in use and the offered ones. */
function categoryField(a: TeamAgent): HTMLElement {
  const input = field("ta-category", a.category, (v) => (a.category = v), { placeholder: tr("例如:程式開發、文案製作、圖片影音", "e.g. Coding, Copywriting, Images & video"), autocomplete: "off", class: "field ta-model-input" }) as HTMLInputElement;
  suggest(input, () => [...new Set([...categoriesInUse(), ...presetCategories()])].map((c) => ({ value: c, label: c })));
  return h(
    "div",
    { class: "ta-model" },
    input,
    h("button", { type: "button", class: "ta-model-open", tabindex: "-1", "aria-label": tr("列出分類", "List categories"), title: tr("列出分類", "List categories"), html: CHEVRON, onMousedown: (e: Event) => e.preventDefault(), onClick: () => (document.activeElement === input ? input.dispatchEvent(new Event("refresh-suggestions")) : input.focus()) }),
  );
}

/**
 * The model, typed or picked from what the base agent offers. The list is
 * asked for the first time the field is used: a handshake with the base, with
 * its own key, nothing spent. An n8n node lists none: what is typed is sent
 * to the workflow as `model`.
 */
function modelField(a: TeamAgent, base: AgentProfile | undefined): HTMLElement {
  const node = base?.protocol === "n8n";
  const input = field("ta-model", a.model, (v) => (a.model = v.trim()), {
    placeholder: node
      ? tr("可留空;填了會放進送給 n8n 的 model 欄位", "May be empty; sent to n8n as `model` when set")
      : base?.model || base?.env?.COPILOT_MODEL
        ? trf("留空用 Provider 的:{model}", "Leave empty for the provider's: {model}", { model: base.model || base.env.COPILOT_MODEL })
        : tr("留空用 Provider 的預設", "Leave empty for the provider's default"),
    autocomplete: "off",
    class: "field ta-model-input",
  }) as HTMLInputElement;
  suggest(input, () => {
    if (!base) return tr("先選 Provider", "Pick a provider first");
    if (node) return tr("n8n 節點沒有模型清單,直接輸入名稱", "An n8n node lists no models: type a name");
    const got = modelLists.get(base.id);
    if (got === undefined) return tr("讀取這個 Agent 提供的模型…", "Reading the models this agent offers…");
    if (got === null) return tr("載入中…", "Loading…");
    if (Array.isArray(got) && !got.length) return tr("這個 Agent 沒有列出模型,直接輸入名稱", "This agent lists no models: type a name");
    return Array.isArray(got) ? got.map((c) => ({ value: c.id, label: c.id, hint: c.label !== c.id ? c.label : undefined })) : got;
  });
  input.addEventListener("focus", () => {
    if (!base || node || modelLists.has(base.id)) return;
    if (!IS_TAURI) {
      modelLists.set(base.id, (base.protocol === "codex" ? ["gpt-5.6-sol", "gpt-5.6-luna"] : base.protocol === "claude" ? ["opus", "sonnet", "haiku"] : ["deepseek-v4-flash", "glm-5.3-flash"]).map((id) => ({ id, label: id })));
      refreshSuggestions(input);
      return;
    }
    modelLists.set(base.id, null);
    Bridge.agentModels(base)
      .then((found) => modelLists.set(base.id, found))
      .catch((err) => modelLists.set(base.id, String(err).replace(/^Error:\s*/, "")))
      .finally(() => refreshSuggestions(input));
  });
  return h(
    "div",
    { class: "ta-model" },
    input,
    h("button", { type: "button", class: "ta-model-open", tabindex: "-1", "aria-label": tr("列出模型", "List models"), title: tr("列出 Provider 提供的模型", "List the models the provider offers"), html: CHEVRON, onMousedown: (e: Event) => e.preventDefault(), onClick: () => (document.activeElement === input ? input.dispatchEvent(new Event("refresh-suggestions")) : input.focus()) }),
  );
}

/** What keeps a team agent from being saved, in the person's words (team_agents.rs checks the same). */
function problemsOf(a: TeamAgent, natives: AgentProfile[]): string[] {
  const out: string[] = [];
  if (!a.name.trim()) out.push(tr("請填名稱。", "Enter a name."));
  if (!a.base) out.push(tr("請選 Provider。", "Pick a provider."));
  else if (!natives.some((n) => n.id === a.base)) out.push(trf("Provider「{base}」不在 設定 → Agent Provider 裡,請改選一個。", "The provider “{base}” is not in Settings → Agent Provider: pick another one.", { base: a.base }));
  const seen = new Set<string>();
  for (const m of a.mcp.filter((m) => m.name || m.command || m.url)) {
    const label = m.name || tr("(未命名)", "(unnamed)");
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(m.name) || m.name === "coucou-team") out.push(trf("MCP「{name}」的名稱只能用英數字、- 與 _。", "The MCP “{name}” can only be named with letters, digits, - and _.", { name: label }));
    else if (seen.has(m.name)) out.push(trf("有兩個 MCP 都叫「{name}」。", "Two MCPs are both named “{name}”.", { name: m.name }));
    seen.add(m.name);
    if (!m.url && !m.command) out.push(trf("MCP「{name}」要填啟動指令或網址。", "The MCP “{name}” needs a command or an address.", { name: label }));
    if (m.url && !/^https?:\/\/\S+/.test(m.url)) out.push(trf("MCP「{name}」的網址要以 http:// 或 https:// 開頭。", "The MCP “{name}” address must start with http:// or https://.", { name: label }));
  }
  return out;
}

/** What kind of agent a base is, in a word, a colour and a mark. */
function kindOf(base: AgentProfile | undefined): { label: string; tone: string } {
  if (!base) return { label: tr("不存在", "Missing"), tone: "gone" };
  if (base.protocol === "claude") return { label: "Claude Code", tone: "claude" };
  if (base.protocol === "codex") return { label: "Codex", tone: "codex" };
  if (base.protocol === "agy") return { label: "Antigravity", tone: "agy" };
  if (base.protocol === "n8n") return { label: "n8n Webhook", tone: "n8n" }; // i18n-ok: a product name
  return { label: /copilot/i.test(base.command) ? "Copilot" : "ACP", tone: "acp" };
}

/** The bases a team agent may run on, Cloud first then Local, each under its heading. */
function baseChoices(natives: AgentProfile[], only: AgentLocation | null): Choice[] {
  const out: Choice[] = [];
  for (const where of ["cloud", "local"] as const) {
    if (only && only !== where) continue;
    for (const n of natives.filter((n) => locationOf(n) === where)) {
      out.push({ value: n.id, label: n.name, hint: kindOf(n).label, group: markName(where), groupIcon: () => kindIcon(where, 14), icon: () => kindIcon(markOf(n), 14) });
    }
  }
  return out;
}

/** Closes the form, whatever was typed in it. */
function closeDraft(host: AgentsHost) {
  draft = null;
  draftWhere = null;
  problem = "";
  host.render();
}

/** The form; `pinned`: its 取消 / 儲存 in its head, which stays put while the form scrolls (the ring's drawer). */
function editor(host: AgentsHost, a: TeamAgent, pinned = false): HTMLElement {
  const natives = host.natives();
  const base = natives.find((n) => n.id === a.base);
  const node = base?.protocol === "n8n";
  const can = supports[a.base];
  const choices = baseChoices(natives, draftIsNew ? draftWhere : null);
  if (a.base && !base) choices.unshift({ value: a.base, label: trf("{base}(不存在)", "{base} (missing)", { base: a.base }), hint: tr("不在 設定 → Agent Provider 裡", "Not in Settings → Agent Provider") });
  const mcpOff = can?.mcp === "no";
  const skillsOff = can?.skills === "no";
  const where = base ? locationOf(base) : draftWhere;
  const actions = h(
    "div",
    { class: "row end" },
    h("button", { type: "button", class: "btn plain", onClick: () => closeDraft(host) }, tr("取消", "Cancel")),
    h(
      "button",
      {
        type: "button",
        class: "btn primary",
        // Checked when pressed, not when drawn: the fields change without a redraw.
        onClick: () => {
          const why = problemsOf(a, host.natives());
          if (why.length) {
            problem = why.join("\n");
            host.render();
            return;
          }
          const all = teamAgents().filter((x) => x.id !== a.id);
          const at = teamAgents().findIndex((x) => x.id === a.id);
          const clean: TeamAgent = { ...a, name: a.name.trim(), category: a.category.trim(), mcp: a.mcp.filter((m) => m.name || m.command || m.url) };
          if (at < 0) all.push(clean);
          else all.splice(at, 0, clean);
          void persist({ agents: all }, host.render).then((ok) => {
            if (ok) {
              draft = null;
              draftWhere = null;
            }
            host.render();
          });
        },
      },
      tr("儲存", "Save"),
    ),
  );
  return h(
    "section",
    { class: `panel form ta-editor${pinned ? " pinned" : ""}` }, // i18n-ok: CSS classes
    h(
      "div",
      { class: "panel-head" },
      h("h2", { class: "ta-editor-title" }, where ? kindIcon(where, 20) : null, draftIsNew ? (where === "local" ? tr("新增 Local Agent", "New Local Agent") : where === "cloud" ? tr("新增 Cloud Agent", "New Cloud Agent") : tr("新增團隊 Agent", "New team agent")) : trf("編輯「{name}」", "Edit “{name}”", { name: a.name || tr("未命名", "unnamed") })),
      pinned ? actions : null,
      pinned && problem ? h("p", { class: "problem", text: problem }) : null,
    ),
    h(
      "div",
      { class: "ta-grid" },
      h("label", { text: tr("名稱", "Name") }),
      field("ta-name", a.name, (v) => (a.name = v), { placeholder: tr("例如:嚴格審查員", "e.g. Strict reviewer") }),
      h("label", { text: tr("分類", "Category") }),
      categoryField(a),
      h("label", { text: "Provider" }), // i18n-ok: the same in both
      h(
        "div",
        { class: "row nowrap" },
        dropdown({ value: a.base, choices, placeholder: tr("選擇 設定 → Agent Provider 裡的 Agent…", "Choose an agent from Settings → Agent Provider…"), title: tr("用哪個 Agent 的指令(或 Webhook)、環境變數與金鑰執行", "Whose command (or webhook), environment variables and key it runs with"), onChange: (v) => { a.base = v; host.render(); } }),
        h("span", { class: "hint" }, tr("來自 ", "From "), h("button", { class: "link", type: "button", onClick: () => host.openSettings() }, tr("設定 → Agent Provider", "Settings → Agent Provider")), tr(";金鑰沿用它的,不另外存。", "; it uses that agent's key, nothing is stored again.")),
      ),
      h("label", { text: tr("模型", "Model") }),
      h("div", { class: "ta-model-wrap" }, modelField(a, base), base ? capsView({ ...base, id: `draft-${a.id}`, model: a.model || base.model }) : null),
      h("label", {}, "Effort ", badge(can?.effort, node)), // i18n-ok: the same in both
      effortField(host, a, can?.effort === "no"),
      h("label", { text: tr("說明", "Description") }),
      field("ta-desc", a.description, (v) => (a.description = v), { rows: "2", placeholder: tr("適合做什麼、擅長什麼。", "What it is good at.") }, "textarea"),
      h("label", {}, "System prompt ", badge(can?.systemPrompt, node)), // i18n-ok: the same in both
      field("ta-prompt", a.systemPrompt, (v) => (a.systemPrompt = v), { rows: "6", placeholder: node ? tr("每次呼叫都放在 systemPrompt 欄位送給工作流程", "Sent to the workflow as systemPrompt with every call") : tr("這個 Agent 一直要遵守的指示、口吻、做事方式", "Instructions, tone and ways of working this agent always keeps to") }, "textarea"),
      h("label", {}, "MCP server ", badge(can?.mcp, node)), // i18n-ok: the same in both
      h(
        "div",
        { class: "ta-mcps" },
        mcpOff
          ? h("p", { class: node && !a.mcp.length ? "hint" : "problem", text: node ? (a.mcp.length ? tr("n8n 節點用的是工作流程自己的工具,不接 MCP server;這裡存了也不會帶給它。", "An n8n node uses its workflow's own tools, not MCP servers: these are saved but not given to it.") : tr("n8n 節點用的是工作流程自己的工具,不接 MCP server。", "An n8n node uses its workflow's own tools, not MCP servers.")) : tr("這個 Provider 的類型不支援個別成員的 MCP server(Antigravity 只讀工作資料夾的設定,會變成全隊共用),存了也不會帶給它。", "This provider's type doesn't support MCP servers per member (Antigravity only reads the work folder's settings, which the whole team shares), so these are saved but not given to it.") })
          : null,
        ...a.mcp.map((m, i) => mcpRow(host, a, m, i, mcpOff)),
        node && !a.mcp.length ? null : h("button", { type: "button", class: "add", onClick: () => { a.mcp.push({ name: "", command: "", args: [], url: "" }); host.render(); } }, tr("＋ 新增 MCP server", "＋ Add MCP server")),
        node ? null : h("p", { class: "hint", text: tr("啟動指令(stdio)或網址(HTTP)。不能填金鑰:需要金鑰的 MCP 請用它自己的登入方式。這些工具每次使用都會照一般規則問你,不像團隊工具自動放行。", "A start command (stdio) or an address (HTTP). No keys here: an MCP that needs one signs in its own way. These tools ask you each time under the usual rules; unlike the team tools, they are not let through on their own.") }),
      ),
      h("label", {}, "Skill ", badge(can?.skills, node)), // i18n-ok: the same in both
      h(
        "div",
        {},
        field("ta-skills", a.skills.join("\n"), (v) => (a.skills = v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)), { rows: "3", placeholder: tr("一行一個:含 SKILL.md 的資料夾完整路徑,或 skill 名稱(會到 ~/.claude/skills 等常見位置找)", "One per line: the full path of a folder with a SKILL.md, or a skill name (looked for in ~/.claude/skills and other usual places)"), class: "field mono", ...(skillsOff && !a.skills.length ? { disabled: "" } : {}) }, "textarea"),
        h("p", { class: "hint", text: skillsOff ? tr("n8n 節點不讀 skill;工作流程該做什麼,在 n8n 裡設定。", "An n8n node reads no skills: what the workflow does is set up in n8n.") : tr("成員開工時會被告知每個 skill 的 SKILL.md 在哪、適合做什麼,需要時自己讀。", "When a member starts it is told where each skill's SKILL.md is and what it is for, and reads it when it needs to.") }),
      ),
    ),
    node ? h("p", { class: "hint ta-node-note" }, kindIcon("n8n", 14), h("span", { text: markHint("n8n") })) : null,
    pinned ? null : problem ? h("p", { class: "problem", text: problem }) : null,
    pinned ? null : actions,
  );
}

/** Each team agent's Mochi, by its place in the list: neighbours never share a colour. */
const FACES = ["#6F93FF", "#34D399", "#A78BFA", "#F5A524", "#F472B6", "#22D3EE", "#84CC16", "#FB7185"];

const ICON_EDIT = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg>';
const ICON_DELETE = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';

/** Opens the form for `a`, slid in from the right. */
function edit(host: AgentsHost, a: TeamAgent) {
  draft = structuredClone(a);
  drawerScroll = 0;
  drawerAt = performance.now();
  draftIsNew = false;
  draftWhere = null;
  problem = "";
  deleting = null;
  host.render();
}

/** 刪除, pressed twice: the first press arms it and says so. */
function deleteButton(host: AgentsHost, a: TeamAgent): HTMLElement {
  const arming = deleting === a.id;
  const used = host.usedBy(a.id);
  return h(
    "button",
    {
      type: "button",
      class: `ta-icon danger${arming ? " armed" : ""}`,
      title: arming ? tr("再按一次刪除", "Click again to delete") : used.length ? trf("刪除({teams} 用到它,刪掉後要改選別的 Agent)", "Delete ({teams} use it and will need another agent)", { teams: used.join(tr("、", ", ")) }) : tr("刪除", "Delete"),
      "aria-label": arming ? tr("確定刪除", "Confirm delete") : trf("刪除 {name}", "Delete {name}", { name: a.name }),
      html: arming ? "" : ICON_DELETE,
      onClick: () => {
        if (!arming) {
          deleting = a.id;
          host.render();
          return;
        }
        deleting = null;
        void persist({ agents: teamAgents().filter((x) => x.id !== a.id) }, host.render);
      },
    },
    arming ? tr("確定刪除?", "Delete?") : null,
  );
}

function card(host: AgentsHost, a: TeamAgent, at: number): HTMLElement {
  const face = FACES[at % FACES.length];
  const natives = host.natives();
  const base = natives.find((n) => n.id === a.base);
  const kind = kindOf(base);
  const used = host.usedBy(a.id);
  const model = a.model || base?.model || "";
  const tags = [
    a.systemPrompt.trim() ? h("span", { class: "ta-tag", title: a.systemPrompt.trim().slice(0, 300) }, "System prompt") : null, // i18n-ok: the same in both
    a.mcp.length ? h("span", { class: "ta-tag", title: a.mcp.map((m) => m.name).join(tr("、", ", ")) }, `MCP ${a.mcp.length}`) : null,
    a.skills.length ? h("span", { class: "ta-tag", title: a.skills.join("\n") }, `Skill ${a.skills.length}`) : null, // i18n-ok: the same in both
    a.effort ? h("span", { class: "ta-tag", title: tr("想得多深(Effort)", "How hard it thinks (effort)") }, `Effort ${effortName(a.effort)}`) : null, // i18n-ok: the same in both
  ].filter(Boolean) as HTMLElement[];
  return h(
    "article",
    {
      class: `ta-card${base ? "" : " broken"}${draft?.id === a.id ? " editing" : ""}`,
      style: `--c:${face}`,
      tabindex: "0",
      title: tr("按兩下編輯", "Double-click to edit"),
      onDblclick: () => edit(host, a),
    },
    h(
      "header",
      { class: "ta-card-head" },
      h("i", { class: "blob", style: `--c:${face};--s:34px`, "aria-hidden": "true" }),
      h("div", { class: "ta-card-title" }, h("b", { title: a.name || a.id }, base ? kindIcon(locationOf(base), 15) : null, h("span", { text: a.name || a.id })), h("small", { text: base ? kind.label : tr("Provider 不存在", "Provider missing") })),
      h(
        "div",
        { class: "ta-card-actions" },
        h("button", { type: "button", class: "ta-icon", title: tr("編輯", "Edit"), "aria-label": trf("編輯 {name}", "Edit {name}", { name: a.name }), html: ICON_EDIT, onClick: () => edit(host, a) }),
        deleteButton(host, a),
      ),
    ),
    h(
      "div",
      { class: "ta-card-kind" },
      a.category.trim() ? h("span", { class: "ta-cat", title: tr("分類", "Category"), text: a.category.trim() }) : null,
      h("span", { class: `ta-kind ${kind.tone}`, title: base ? trf("Provider:{name}({kind})", "Provider: {name} ({kind})", { name: base.name, kind: kind.label }) : trf("Provider「{base}」不在 設定 → Agent Provider 裡", "The provider “{base}” is not in Settings → Agent Provider", { base: a.base }) }, base?.protocol === "n8n" ? kindIcon("n8n", 13) : null, h("span", { text: base ? base.name : trf("{base}(不存在)", "{base} (missing)", { base: a.base }) })),
      h("span", { class: "ta-model-name", title: a.model ? trf("模型:{model}", "Model: {model}", { model: a.model }) : tr("沒有指定,用 Provider 的模型", "None set: the provider's model") }, model ? `${model}${a.model ? "" : tr("(預設)", " (default)")}` : base?.protocol === "n8n" ? tr("由工作流程決定", "Up to the workflow") : tr("預設模型", "Default model")),
    ),
    base ? capsView({ ...base, id: a.id, model: a.model || base.model }) : null,
    h("p", { class: `ta-desc${a.description ? "" : " empty"}`, text: a.description || tr("還沒有說明:Agent Center 不知道它適合做什麼", "No description yet: Agent Center doesn't know what it is good for") }),
    h(
      "footer",
      { class: "ta-card-foot" },
      tags.length ? h("div", { class: "ta-tags" }, ...tags) : h("span"),
      h(
        "span",
        { class: `ta-used${used.length ? " on" : ""}`, title: used.length ? used.join("\n") : "" },
        used.length ? (used.length === 1 ? used[0] : trf("{n} 個團隊", "{n} teams", { n: used.length })) : tr("還沒有團隊使用", "No team uses it yet"),
      ),
    ),
  );
}

/** Opens the form for a new agent of one kind, in the category the page is narrowed to. */
function startNew(host: AgentsHost, where: AgentLocation) {
  const bases = host.natives().filter((n) => locationOf(n) === where);
  draft = { id: `ta-${Date.now().toString(36)}`, name: "", base: bases[0]?.id ?? "", model: "", systemPrompt: "", mcp: [], skills: [], description: "", category: only ?? "", effort: "" };
  drawerScroll = 0;
  drawerAt = performance.now();
  draftIsNew = true;
  draftWhere = where;
  problem = "";
  deleting = null;
  host.render();
}

/** Why a kind cannot have a new agent yet, or its hint. */
function addHint(where: AgentLocation, can: boolean): string {
  if (can) return markHint(where);
  return where === "local" ? tr("先到 設定 → Agent Provider 新增 Local Agent(本機模型或 n8n 節點)", "First add a Local Agent (a local model or an n8n node) in Settings → Agent Provider") : tr("先到 設定 → Agent Provider 新增 Cloud Agent", "First add a Cloud Agent in Settings → Agent Provider");
}

/** The tile that starts a new team agent of one kind, at the end of its grid. */
function addTile(host: AgentsHost, where: AgentLocation): HTMLElement {
  const bases = host.natives().filter((n) => locationOf(n) === where);
  return h(
    "button",
    {
      type: "button",
      class: `ta-card ta-add ${where}`,
      disabled: !bases.length,
      title: addHint(where, !!bases.length),
      onClick: () => startNew(host, where),
    },
    h("span", { class: "ta-add-plus", text: "+" }),
    h("span", { text: where === "local" ? tr("新增 Local Agent", "New Local Agent") : tr("新增 Cloud Agent", "New Cloud Agent") }),
  );
}

/** One kind's panel: its mark, its team agents and a tile for one more. */
function section(host: AgentsHost, where: AgentLocation): HTMLElement {
  const natives = host.natives();
  // A team agent whose base is gone is shown with the Cloud ones, marked broken.
  const whereOf = (a: TeamAgent) => {
    const base = natives.find((n) => n.id === a.base);
    return base ? locationOf(base) : "cloud";
  };
  const mine = byCategory(
    teamAgents()
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => whereOf(a) === where && (only === null || a.category.trim() === only)),
  );
  const noBase = !natives.some((n) => locationOf(n) === where);
  return h(
    "section",
    { class: `panel ta-section ${where}` },
    h(
      "div",
      { class: "panel-head" },
      h("h2", { class: "ta-section-title" }, kindIcon(where, 22), h("span", { text: markName(where) }), h("span", { class: "count", text: String(mine.length) })),
      h("span", { class: "dim", text: markHint(where) }),
    ),
    noBase
      ? h("p", { class: "hint" }, where === "local" ? tr("設定 → Agent Provider 裡還沒有 Local Agent。先到 ", "Settings → Agent Provider has no Local Agent yet. Add a local model or an n8n node in ") : tr("設定 → Agent Provider 裡還沒有 Cloud Agent。先到 ", "Settings → Agent Provider has no Cloud Agent yet. Add one in "), h("button", { class: "link", type: "button", onClick: () => host.openSettings() }, tr("設定 → Agent Provider", "Settings → Agent Provider")), where === "local" ? tr(" 新增本機模型或 n8n 節點。", " first.") : tr(" 新增一個。", " first."))
      : null,
    h("div", { class: "ta-grid-list" }, ...mine.map(({ a, i }) => card(host, a, i)), addTile(host, where)),
  );
}

/**
 * Above the sections: a chip per category — the cards narrow to it, the
 * ring lights it — what the last save said, and cards or ring.
 */
function toolbar(host: AgentsHost): HTMLElement {
  const agents = teamAgents();
  const cats = categoriesInUse();
  const none = agents.filter((a) => !a.category.trim()).length;
  if (only !== null && (only ? !cats.includes(only) : !none)) only = null;
  const chip = (value: string | null, label: string, n: number) =>
    h(
      "button",
      { type: "button", class: `ta-filter${only === value ? " on" : ""}`, "aria-pressed": String(only === value), onClick: () => { only = only === value ? null : value; host.render(); } },
      h("span", { text: label }),
      h("span", { class: "count", text: String(n) }),
    );
  return h(
    "div",
    { class: "ta-bar" },
    cats.length
      ? h(
          "div",
          { class: "ta-filters", role: "group", "aria-label": tr("依分類篩選", "Filter by category") },
          chip(null, tr("全部", "All"), agents.length),
          ...cats.map((c) => chip(c, c, agents.filter((a) => a.category.trim() === c).length)),
          none ? chip("", tr("未分類", "Uncategorized"), none) : null,
        )
      : h("span", { class: "dim ta-bar-hint", text: tr("在 Agent 的「分類」填上程式開發、文案製作…,同一類就會排在一起。", "Give agents a Category (Coding, Copywriting…) and the same kind sit together.") }),
    h(
      "div",
      { class: "ta-bar-end" },
      state ? h("span", { class: "ta-state", role: "status", text: stateText() }) : null,
      h(
        "div",
        { class: "segmented small ta-views", role: "group", "aria-label": tr("顯示方式", "View") }, // i18n-ok: CSS classes
        h("button", { type: "button", class: view === "cards" ? "on" : "", "aria-pressed": String(view === "cards"), onClick: () => setView("cards", host.render) }, tr("卡片", "Cards")),
        h("button", { type: "button", class: view === "ring" ? "on" : "", "aria-pressed": String(view === "ring"), onClick: () => setView("ring", host.render) }, tr("環狀", "Ring")),
      ),
    ),
  );
}

/** How far down the form was scrolled: a redraw puts it back there. */
let drawerScroll = 0;
/** When the form was opened: it slides in once, not on every redraw. */
let drawerAt = 0;

/**
 * The form, over the page's right side whether cards or ring: it scrolls on
 * its own, keeps its place when the window is drawn again, and slides in
 * when opened (a redraw on the way carries on from where it was).
 */
function drawer(form: HTMLElement): HTMLElement {
  const since = performance.now() - drawerAt;
  const el = h("div", { class: `ta-drawer${since < 260 ? " opening" : ""}`, style: `--t:${-since}ms`, onScroll: () => (drawerScroll = el.scrollTop) }, form);
  // Once the page it belongs to is on screen (render appends it right after).
  queueMicrotask(() => (el.scrollTop = drawerScroll));
  return el;
}

/** Agent Center at the ring's centre: a hexagon around a small orbit. */
const HUB =
  '<svg viewBox="0 0 64 64" width="46" height="46" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"><path d="M32 5 55.4 18.5v27L32 59 8.6 45.5v-27Z"/><circle cx="32" cy="32" r="11.5" stroke-width="1.6" opacity=".7"/><circle cx="32" cy="32" r="4.6" fill="currentColor" stroke="none"/><circle cx="32" cy="20.5" r="2.1" fill="currentColor" stroke="none"/><circle cx="42" cy="37.8" r="2.1" fill="currentColor" stroke="none"/><circle cx="22" cy="37.8" r="2.1" fill="currentColor" stroke="none"/></svg>';

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** One agent on the ring: its Mochi in a circle of its kind's colour, its name, its category. */
function ringNode(host: AgentsHost, x: RingPlace, focus: string | null, unfold: number | null): HTMLElement {
  const { a, base } = x;
  const mark = base ? markOf(base) : "cloud";
  const face = FACES[x.i % FACES.length];
  const lit = focus !== null && a.category.trim() === focus;
  const model = a.model || base?.model || "";
  const tip = [
    a.name || a.id,
    `${base ? `${markName(mark)} · ${kindOf(base).label}` : tr("Provider 不存在", "Provider missing")}${model ? ` · ${model}` : ""}`,
    a.description,
    tr("按一下編輯", "Click to edit"),
  ].filter(Boolean).join("\n");
  return h(
    "button",
    {
      type: "button",
      class: `ta-node${base ? "" : " broken"}${lit ? " lit" : focus !== null ? " dim" : ""}${draft?.id === a.id ? " editing" : ""}${unfold !== null ? " unfold" : ""}`,
      style: `left:${x.left}%;top:${x.top}%;--c:${face};--m:${markColor(mark)};--dx:${x.dx}px;--dy:${x.dy}px;--d:${unfold ?? 0}ms`,
      title: tip,
      "aria-label": trf("編輯 {name}", "Edit {name}", { name: a.name || a.id }),
      onClick: () => edit(host, a),
    },
    h("span", { class: "ta-node-ring" }, h("i", { class: "blob", style: `--c:${face};--s:26px`, "aria-hidden": "true" })),
    h("span", { class: "ta-node-name" }, kindIcon(mark, 12), h("span", { text: a.name || a.id })),
    h("span", { class: `ta-node-cat${a.category.trim() ? "" : " none"}`, text: a.category.trim() || tr("未分類", "Uncategorized") }),
  );
}

interface RingPlace {
  a: TeamAgent;
  i: number;
  base: AgentProfile | undefined;
  /** Where on the stage, in % of its width and height. */
  left: number;
  top: number;
  /** From it to the centre, in stage units: where it flies out from. */
  dx: number;
  dy: number;
  /** Where round the ring, in radians from the right, clockwise. */
  angle: number;
}

/**
 * Every team agent on rings around Agent Center: the Local Agents — inside
 * the company — on the inner ring, the Cloud Agents — outside it — on the
 * outer one, each ring going round by category. A category picked above
 * lights its agents, draws them to the centre and lists them; the others
 * dim. A click on an agent edits it; the form opens over the ring's right.
 */
function ringView(host: AgentsHost, entered: boolean): HTMLElement {
  const natives = host.natives();
  const all = teamAgents().map((a, i) => ({ a, i, base: natives.find((n) => n.id === a.base) }));
  const placeOf = (x: { base: AgentProfile | undefined }) => (x.base ? locationOf(x.base) : "cloud");
  const rings = (["local", "cloud"] as const).map((where) => ({ where, list: byCategory(all.filter((x) => placeOf(x) === where)) })).filter((r) => r.list.length);
  // Inside the company — the user's machine or network — a disc round Agent Center with the Local
  // Agents on it; its edge is the boundary; the Cloud Agents go round outside it. Each ring is far
  // enough out for its agents' names to sit side by side.
  const room = (n: number) => (n * 104) / (2 * Math.PI);
  const local = rings.find((r) => r.where === "local");
  const cloud = rings.find((r) => r.where === "cloud");
  const radii = rings.map(() => 0);
  const rLocal = local ? Math.max(170, room(local.list.length)) : 0;
  const edge = local ? rLocal + 70 : 120;
  const rCloud = cloud ? Math.max(edge + 90, 240, room(cloud.list.length)) : 0;
  rings.forEach((r, k) => (radii[k] = r.where === "local" ? rLocal : rCloud));
  const R = Math.max(edge, rCloud);
  // A square field, so the rings stay round however wide the window is; names hang under the agents.
  const S = 2 * R + 190;
  const cx = S / 2;
  const cy = S / 2 - 8;
  const focus = only;

  if (entered) unfoldAt = performance.now();
  const since = performance.now() - unfoldAt;
  const places: RingPlace[] = [];
  // The outer ring starts at the top; the inner one is turned to stand as far as it can from the outer agents.
  const turns = rings.map(() => 0);
  if (rings.length > 1) {
    const outer = rings[1].list.map((_, j) => (j * 2 * Math.PI) / rings[1].list.length);
    const step = (2 * Math.PI) / rings[0].list.length;
    const gap = (turn: number) =>
      Math.min(...rings[0].list.flatMap((_, j) => outer.map((o) => {
        const d = Math.abs((((j * step + turn - o) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI));
        return Math.min(d, 2 * Math.PI - d);
      })));
    let best = 0;
    for (let n = 0; n < 24; n++) {
      const turn = (n / 24) * step;
      if (gap(turn) > gap(best) + 1e-6) best = turn;
    }
    turns[0] = best;
  }
  rings.forEach((r, k) => {
    const step = (2 * Math.PI) / r.list.length;
    r.list.forEach((x, j) => {
      const t = -Math.PI / 2 + j * step + turns[k];
      const px = cx + radii[k] * Math.cos(t);
      const py = cy + radii[k] * Math.sin(t);
      places.push({ ...x, left: (px / S) * 100, top: (py / S) * 100, dx: cx - px, dy: cy - py, angle: t });
    });
  });
  // The words for inside and outside go where the rings are emptiest.
  const angles = places.map((x) => x.angle).sort((a, b) => a - b);
  let label = -Math.PI / 2;
  if (angles.length) {
    let widest = -1;
    angles.forEach((a, k) => {
      const next = k + 1 < angles.length ? angles[k + 1] : angles[0] + 2 * Math.PI;
      if (next - a > widest) {
        widest = next - a;
        label = (a + next) / 2;
      }
    });
  }
  const at = (r: number) => `left:${((cx + r * Math.cos(label)) / S) * 100}%;top:${((cy + r * Math.sin(label)) / S) * 100}%`;

  const lines = svgEl("svg", { class: "ta-ring-lines", viewBox: `0 0 ${S} ${S}`, "aria-hidden": "true" });
  lines.append(svgEl("circle", { class: "ta-ring-inside", cx, cy, r: edge }));
  rings.forEach((r, k) => lines.append(svgEl("circle", { class: `ta-ring-orbit ${r.where}`, cx, cy, r: radii[k] })));
  const litPlaces = focus === null ? [] : places.filter((x) => x.a.category.trim() === focus);
  for (const x of litPlaces) {
    const px = (x.left / 100) * S;
    const py = (x.top / 100) * S;
    lines.append(svgEl("line", { class: "ta-ring-link", x1: cx, y1: cy, x2: px, y2: py }));
    lines.append(svgEl("circle", { class: "ta-ring-knot", cx: (cx + px) / 2, cy: (cy + py) / 2, r: 4 }));
  }

  const canAdd = (where: AgentLocation) => natives.some((n) => locationOf(n) === where);
  const addButton = (where: AgentLocation) =>
    h(
      "button",
      { type: "button", class: "ta-ring-add-btn", disabled: !canAdd(where), title: addHint(where, canAdd(where)), onClick: () => startNew(host, where) },
      kindIcon(where, 16),
      h("span", { text: where === "local" ? tr("新增 Local Agent", "New Local Agent") : tr("新增 Cloud Agent", "New Cloud Agent") }),
    );
  const legendRow = (mark: KindMark, label: string) => h("div", { class: "ta-ring-legend-row", title: markHint(mark) }, kindIcon(mark, 16), h("span", { text: label }));
  // A late redraw keeps flying from where it was, not from the start.
  const unfold = (n: number) => (since < 1400 ? n * 45 - since : null);

  return h(
    "section",
    { class: "ta-ring" },
    h(
      "div",
      { class: "ta-ring-stage" },
      h(
        "div",
        { class: "ta-ring-field" },
        lines,
        h("div", { class: `ta-ring-hub${focus !== null ? " on" : ""}`, style: `left:${(cx / S) * 100}%;top:${(cy / S) * 100}%` }, h("span", { class: "ta-ring-core", html: HUB }), h("b", { text: "Agent Center" })),
        h("span", { class: "ta-ring-zone local", style: at(edge), title: markHint("local") }, kindIcon("local", 14), h("span", { text: tr("內部 · 地端服務", "Inside · on-premises") })),
        cloud ? h("span", { class: "ta-ring-zone cloud", style: at(rCloud), title: markHint("cloud") }, kindIcon("cloud", 14), h("span", { text: tr("外部 · 雲端服務", "Outside · cloud services") })) : null,
        ...places.map((x, n) => ringNode(host, x, focus, unfold(n))),
        all.length ? null : h("p", { class: "ta-ring-empty", text: tr("還沒有 Agent。按左下角新增第一個。", "No agents yet. Add the first one at the bottom left.") }),
      ),
      h(
        "div",
        { class: "ta-ring-legend" },
        h("b", { text: tr("內部或外部", "Inside or outside") }),
        legendRow("cloud", tr("外部 · Cloud Agent", "Outside · Cloud Agent")),
        legendRow("local", tr("內部 · Local Agent", "Inside · Local Agent")),
        legendRow("n8n", tr("內部 · n8n 節點", "Inside · n8n node")),
      ),
      focus !== null && !draft
        ? h(
            "aside",
            { class: "ta-ring-list" },
            h("div", { class: "ta-ring-list-head" }, h("b", { text: focus || tr("未分類", "Uncategorized") }), h("span", { class: "count", text: `${litPlaces.length} / ${all.length}` })),
            ...litPlaces.map((x) => {
              const face = FACES[x.i % FACES.length];
              const model = x.a.model || x.base?.model || "";
              return h(
                "div",
                { class: "ta-ring-row", style: `--c:${face}` },
                h("i", { class: "blob", style: `--c:${face};--s:22px`, "aria-hidden": "true" }),
                h("div", { class: "ta-ring-row-text" }, h("b", {}, x.base ? kindIcon(markOf(x.base), 13) : null, h("span", { text: x.a.name || x.a.id })), h("small", { text: [x.base ? kindOf(x.base).label : tr("Provider 不存在", "Provider missing"), model].filter(Boolean).join(" · ") })),
                h("button", { type: "button", class: "ta-icon", title: tr("編輯", "Edit"), "aria-label": trf("編輯 {name}", "Edit {name}", { name: x.a.name }), html: ICON_EDIT, onClick: () => edit(host, x.a) }),
                deleteButton(host, x.a),
              );
            }),
            litPlaces.length ? null : h("p", { class: "dim", text: tr("這一類還沒有 Agent。", "No agent in this category yet.") }),
          )
        : null,
      h("div", { class: "ta-ring-add" }, addButton("cloud"), addButton("local")),
    ),
  );
}

/** The page; `entered` when it was not on screen the last time the window was drawn. */
export function agentsPage(host: AgentsHost, entered = false): HTMLElement {
  void loadTeamAgents(host.render, host.natives());
  if (!doc) return h("div", { class: "ta" }, h("p", { class: "dim", text: tr("讀取中…", "Loading…") }));
  // Coming back to the page: abilities asked afresh (the price list may be newer), a form left open put away.
  if (entered) forgetCaps();
  if (entered && draft) {
    draft = null;
    draftWhere = null;
    problem = "";
  }
  return h(
    "div",
    {
      class: "ta",
      // The form floats over the page: a click anywhere else on it puts the form away. An
      // agent, its ✎ or 新增 opens its own form instead; menus hang from the window, outside the page.
      onClick: (e: Event) => {
        if (!draft) return;
        const at = e.target as Element | null;
        if (!at?.isConnected || at.closest(".ta-drawer, .ta-node, .ta-ring-add-btn, .ta-ring-list, .ta-icon, .ta-add")) return;
        closeDraft(host);
      },
    },
    toolbar(host),
    !draft && problem ? h("p", { class: "problem", text: problem }) : null,
    ...(view === "ring" ? [ringView(host, entered)] : [section(host, "cloud"), section(host, "local")]),
    draft ? drawer(editor(host, draft, true)) : null,
  );
}
