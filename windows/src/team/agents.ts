// Agent 設定: agents of the person's own making for their teams. Each is built
// on a native agent of Settings → Agents — its command, environment and key —
// and adds a name, a model, a system prompt, MCP servers, skills, and a
// description the secretary reads to pick members. What a base's protocol
// cannot take is said here rather than dropped quietly (team_agents.rs).
//
// The secretary's switch lives with them: new teams — the secretary's and the
// ones made by hand — take their agents from Settings → Agents (the default)
// or from these only. Teams already set up run as they are either way.

import "./agents.css";
import { Bridge, IS_TAURI } from "../core/bridge";
import { tr, trf } from "../core/i18n";
import type { AgentProfile, ModelChoice } from "../core/state";
import { h } from "../views/dom";
import { CHEVRON, dropdown, refreshSuggestions, suggest } from "./ui";
import type { TeamAgent, TeamAgentMcp, TeamAgents, TeamAgentSource, TeamAgentSupport, TeamAgentSupports } from "./types";

export interface AgentsHost {
  render(): void;
  /** Settings → Agents. */
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
let problem = "";
/** The agent whose 刪除 has been pressed once. */
let deleting: string | null = null;

/** The browser preview's agents, in the language of the moment they are first read. */
const demoAgents = (): TeamAgents => ({
  source: "native",
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
    },
  ],
});

function demoSupports(protocol: AgentProfile["protocol"]): TeamAgentSupports {
  if (protocol === "claude" || protocol === "codex") return { systemPrompt: "native", mcp: "native", skills: "brief" };
  if (protocol === "agy") return { systemPrompt: "brief", mcp: "no", skills: "brief" };
  return { systemPrompt: "brief", mcp: "native", skills: "brief" };
}

/** Reads them once (or again, `force`); draws when they arrive. */
export async function loadTeamAgents(render: () => void, natives: AgentProfile[] = [], force = false) {
  if ((doc && !force) || loading) return;
  loading = true;
  try {
    if (IS_TAURI) {
      const view = await Bridge.teamAgentsLoad();
      doc = view.doc;
      supports = view.supports;
    } else {
      doc = doc ?? demoAgents();
      supports = Object.fromEntries(natives.map((a) => [a.id, demoSupports(a.protocol)]));
    }
  } catch (err) {
    state = "unreadable";
    stateError = String(err instanceof Error ? err.message : err);
    doc = doc ?? { source: "native", agents: [] };
  }
  loading = false;
  render();
}

export function teamAgents(): TeamAgent[] {
  return doc?.agents ?? [];
}

/** How a member's agent is shown: a team agent by its name (its id is Coucou's own), a native one by its id. */
export function agentLabel(id: string): string {
  return teamAgents().find((a) => a.id === id)?.name || id;
}

export function agentSource(): TeamAgentSource {
  return doc?.source ?? "native";
}

/**
 * The team agents as profiles, for names and default models: each its base's,
 * under its own id. One whose base is gone is left out.
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

/** The secretary's switch: new teams from the native agents, or from the team agents only. */
export async function setAgentSource(source: TeamAgentSource, render: () => void) {
  if (!doc || doc.source === source) return;
  await persist({ ...doc, source }, render);
}

/** The switch as two buttons, for the secretary's settings and this page. */
export function sourceSwitch(render: () => void): HTMLElement {
  const current = agentSource();
  const item = (v: TeamAgentSource, label: string) =>
    h("button", { type: "button", class: current === v ? "on" : "", "aria-pressed": String(current === v), onClick: () => void setAgentSource(v, render) }, label);
  return h("div", { class: "segmented", role: "group", "aria-label": tr("團隊使用哪種 Agent", "Which agents teams use") }, item("native", tr("原生 Agent", "Native agents")), item("team", tr("團隊定義的 Agent", "Team agents")));
}

function supportText(s: TeamAgentSupport): string {
  switch (s) {
    case "native": return tr("原生支援", "Supported");
    case "brief": return tr("寫進成員的開場說明", "Added to the member's brief");
    case "no": return tr("此 agent 類型不支援", "Not supported by this agent type");
  }
}

function badge(s: TeamAgentSupport | undefined): HTMLElement | null {
  if (!s) return null;
  return h("span", { class: `ta-support ${s}`, text: supportText(s) });
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

/**
 * The model, typed or picked from what the base agent offers. The list is
 * asked for the first time the field is used: a handshake with the base, with
 * its own key, nothing spent.
 */
function modelField(a: TeamAgent, base: AgentProfile | undefined): HTMLElement {
  const input = field("ta-model", a.model, (v) => (a.model = v.trim()), {
    placeholder: base?.model ? trf("留空用基底的:{model}", "Leave empty for the base's: {model}", { model: base.model }) : tr("留空用基底 Agent 的預設", "Leave empty for the base agent's default"),
    autocomplete: "off",
    class: "field ta-model-input",
  }) as HTMLInputElement;
  suggest(input, () => {
    if (!base) return tr("先選基底 Agent", "Pick a base agent first");
    const got = modelLists.get(base.id);
    if (got === undefined) return tr("讀取這個 Agent 提供的模型…", "Reading the models this agent offers…");
    if (got === null) return tr("載入中…", "Loading…");
    if (Array.isArray(got) && !got.length) return tr("這個 Agent 沒有列出模型,直接輸入名稱", "This agent lists no models: type a name");
    return Array.isArray(got) ? got.map((c) => ({ value: c.id, label: c.id, hint: c.label !== c.id ? c.label : undefined })) : got;
  });
  input.addEventListener("focus", () => {
    if (!base || modelLists.has(base.id)) return;
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
    h("button", { type: "button", class: "ta-model-open", tabindex: "-1", "aria-label": tr("列出模型", "List models"), title: tr("列出基底 Agent 提供的模型", "List the models the base agent offers"), html: CHEVRON, onMousedown: (e: Event) => e.preventDefault(), onClick: () => (document.activeElement === input ? input.dispatchEvent(new Event("refresh-suggestions")) : input.focus()) }),
  );
}

/** What keeps a team agent from being saved, in the person's words (team_agents.rs checks the same). */
function problemsOf(a: TeamAgent, natives: AgentProfile[]): string[] {
  const out: string[] = [];
  if (!a.name.trim()) out.push(tr("請填名稱。", "Enter a name."));
  if (!a.base) out.push(tr("請選基底 Agent。", "Pick a base agent."));
  else if (!natives.some((n) => n.id === a.base)) out.push(trf("基底「{base}」不在 設定 → Agents 裡,請改選一個。", "The base “{base}” is not in Settings → Agents: pick another one.", { base: a.base }));
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

function editor(host: AgentsHost, a: TeamAgent): HTMLElement {
  const natives = host.natives();
  const base = natives.find((n) => n.id === a.base);
  const can = supports[a.base];
  const choices = natives.map((n) => ({ value: n.id, label: n.name, hint: n.protocol === "codex" ? "Codex" : n.protocol === "claude" ? "Claude Code" : n.protocol === "agy" ? "Antigravity" : n.command }));
  if (a.base && !base) choices.unshift({ value: a.base, label: trf("{base}(不存在)", "{base} (missing)", { base: a.base }), hint: tr("不在 設定 → Agents 裡", "Not in Settings → Agents") });
  const mcpOff = can?.mcp === "no";
  return h(
    "section",
    { class: "panel form ta-editor" }, // i18n-ok: CSS classes
    h("div", { class: "panel-head" }, h("h2", { text: draftIsNew ? tr("新增團隊 Agent", "New team agent") : trf("編輯「{name}」", "Edit “{name}”", { name: a.name || tr("未命名", "unnamed") }) })),
    h(
      "div",
      { class: "ta-grid" },
      h("label", { text: tr("名稱", "Name") }),
      field("ta-name", a.name, (v) => (a.name = v), { placeholder: tr("例如:嚴格審查員", "e.g. Strict reviewer") }),
      h("label", { text: tr("基底 Agent", "Base agent") }),
      h(
        "div",
        { class: "row nowrap" },
        dropdown({ value: a.base, choices, placeholder: tr("選擇原生 Agent…", "Choose a native agent…"), title: tr("用哪個原生 Agent 的指令、環境變數與金鑰執行", "Whose command, environment variables and key it runs with"), onChange: (v) => { a.base = v; host.render(); } }),
        h("span", { class: "hint" }, tr("來自 ", "From "), h("button", { class: "link", type: "button", onClick: () => host.openSettings() }, tr("設定 → Agents", "Settings → Agents")), tr(";金鑰沿用它的,不另外存。", "; it uses that agent's key, nothing is stored again.")),
      ),
      h("label", { text: tr("模型", "Model") }),
      modelField(a, base),
      h("label", { text: tr("說明(給秘書看)", "Description (for the secretary)") }),
      field("ta-desc", a.description, (v) => (a.description = v), { rows: "2", placeholder: tr("適合做什麼、擅長什麼。秘書開團隊時照這段話挑人。", "What it is good at. The secretary picks members by this when it sets up a team.") }, "textarea"),
      h("label", {}, "System prompt ", badge(can?.systemPrompt)), // i18n-ok: the same in both
      field("ta-prompt", a.systemPrompt, (v) => (a.systemPrompt = v), { rows: "6", placeholder: tr("這個 Agent 一直要遵守的指示、口吻、做事方式", "Instructions, tone and ways of working this agent always keeps to") }, "textarea"),
      h("label", {}, "MCP server ", badge(can?.mcp)), // i18n-ok: the same in both
      h(
        "div",
        { class: "ta-mcps" },
        mcpOff ? h("p", { class: "problem", text: tr("這個基底 Agent 的類型不支援個別成員的 MCP server(Antigravity 只讀工作資料夾的設定,會變成全隊共用),存了也不會帶給它。", "This base agent's type doesn't support MCP servers per member (Antigravity only reads the work folder's settings, which the whole team shares), so these are saved but not given to it.") }) : null,
        ...a.mcp.map((m, i) => mcpRow(host, a, m, i, mcpOff)),
        h("button", { type: "button", class: "add", onClick: () => { a.mcp.push({ name: "", command: "", args: [], url: "" }); host.render(); } }, tr("＋ 新增 MCP server", "＋ Add MCP server")),
        h("p", { class: "hint", text: tr("啟動指令(stdio)或網址(HTTP)。不能填金鑰:需要金鑰的 MCP 請用它自己的登入方式。這些工具每次使用都會照一般規則問你,不像團隊工具自動放行。", "A start command (stdio) or an address (HTTP). No keys here: an MCP that needs one signs in its own way. These tools ask you each time under the usual rules; unlike the team tools, they are not let through on their own.") }),
      ),
      h("label", {}, "Skill ", badge(can?.skills)), // i18n-ok: the same in both
      h(
        "div",
        {},
        field("ta-skills", a.skills.join("\n"), (v) => (a.skills = v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)), { rows: "3", placeholder: tr("一行一個:含 SKILL.md 的資料夾完整路徑,或 skill 名稱(會到 ~/.claude/skills 等常見位置找)", "One per line: the full path of a folder with a SKILL.md, or a skill name (looked for in ~/.claude/skills and other usual places)"), class: "field mono" }, "textarea"),
        h("p", { class: "hint", text: tr("成員開工時會被告知每個 skill 的 SKILL.md 在哪、適合做什麼,需要時自己讀。", "When a member starts it is told where each skill's SKILL.md is and what it is for, and reads it when it needs to.") }),
      ),
    ),
    problem ? h("p", { class: "problem", text: problem }) : null,
    h(
      "div",
      { class: "row end" },
      h("button", { type: "button", class: "btn plain", onClick: () => { draft = null; problem = ""; host.render(); } }, tr("取消", "Cancel")),
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
            const clean: TeamAgent = { ...a, name: a.name.trim(), mcp: a.mcp.filter((m) => m.name || m.command || m.url) };
            if (at < 0) all.push(clean);
            else all.splice(at, 0, clean);
            void persist({ source: agentSource(), agents: all }, host.render).then((ok) => {
              if (ok) draft = null;
              host.render();
            });
          },
        },
        tr("儲存", "Save"),
      ),
    ),
  );
}

/** Each team agent's Mochi, by its place in the list: neighbours never share a colour. */
const FACES = ["#6F93FF", "#34D399", "#A78BFA", "#F5A524", "#F472B6", "#22D3EE", "#84CC16", "#FB7185"];

/** What kind of agent a base is, in a word and a colour. */
function kindOf(base: AgentProfile | undefined): { label: string; tone: string } {
  if (!base) return { label: tr("不存在", "Missing"), tone: "gone" };
  if (base.protocol === "claude") return { label: "Claude Code", tone: "claude" };
  if (base.protocol === "codex") return { label: "Codex", tone: "codex" };
  if (base.protocol === "agy") return { label: "Antigravity", tone: "agy" };
  return { label: /copilot/i.test(base.command) ? "Copilot" : "ACP", tone: "acp" };
}

const ICON_EDIT = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg>';
const ICON_DELETE = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';

/** Opens the form for `a`, scrolled into view: the list may be far below it. */
function edit(host: AgentsHost, a: TeamAgent) {
  draft = structuredClone(a);
  draftIsNew = false;
  problem = "";
  deleting = null;
  host.render();
  requestAnimationFrame(() => document.querySelector(".ta-editor")?.scrollIntoView({ block: "start", behavior: "smooth" }));
}

function card(host: AgentsHost, a: TeamAgent, at: number): HTMLElement {
  const face = FACES[at % FACES.length];
  const natives = host.natives();
  const base = natives.find((n) => n.id === a.base);
  const kind = kindOf(base);
  const used = host.usedBy(a.id);
  const model = a.model || base?.model || "";
  const arming = deleting === a.id;
  const tags = [
    a.systemPrompt.trim() ? h("span", { class: "ta-tag", title: a.systemPrompt.trim().slice(0, 300) }, "System prompt") : null, // i18n-ok: the same in both
    a.mcp.length ? h("span", { class: "ta-tag", title: a.mcp.map((m) => m.name).join(tr("、", ", ")) }, `MCP ${a.mcp.length}`) : null,
    a.skills.length ? h("span", { class: "ta-tag", title: a.skills.join("\n") }, `Skill ${a.skills.length}`) : null, // i18n-ok: the same in both
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
      h("div", { class: "ta-card-title" }, h("b", { text: a.name || a.id, title: a.name || a.id }), h("small", { text: base ? kind.label : tr("基底不存在", "Base missing") })),
      h(
        "div",
        { class: "ta-card-actions" },
        h("button", { type: "button", class: "ta-icon", title: tr("編輯", "Edit"), "aria-label": trf("編輯 {name}", "Edit {name}", { name: a.name }), html: ICON_EDIT, onClick: () => edit(host, a) }),
        h(
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
              void persist({ source: agentSource(), agents: teamAgents().filter((x) => x.id !== a.id) }, host.render);
            },
          },
          arming ? tr("確定刪除?", "Delete?") : null,
        ),
      ),
    ),
    h(
      "div",
      { class: "ta-card-kind" },
      h("span", { class: `ta-kind ${kind.tone}`, title: base ? trf("基底 Agent:{name}({kind})", "Base agent: {name} ({kind})", { name: base.name, kind: kind.label }) : trf("基底「{base}」不在 設定 → Agents 裡", "The base “{base}” is not in Settings → Agents", { base: a.base }) }, h("span", { text: base ? base.name : trf("{base}(不存在)", "{base} (missing)", { base: a.base }) })),
      h("span", { class: "ta-model-name", title: a.model ? trf("模型:{model}", "Model: {model}", { model: a.model }) : tr("沒有指定,用基底的模型", "None set: the base's model") }, model ? `${model}${a.model ? "" : tr("(基底)", " (base)")}` : tr("基底預設模型", "Base's default model")),
    ),
    h("p", { class: `ta-desc${a.description ? "" : " empty"}`, text: a.description || tr("還沒有說明:秘書不知道它適合做什麼", "No description yet: the secretary doesn't know what it is good for") }),
    h(
      "footer",
      { class: "ta-card-foot" },
      tags.length ? h("div", { class: "ta-tags" }, ...tags) : h("span", { class: "ta-plain", text: tr("只換名稱與模型", "Only a name and a model") }),
      h(
        "span",
        { class: `ta-used${used.length ? " on" : ""}`, title: used.length ? used.join("\n") : "" },
        used.length ? (used.length === 1 ? used[0] : trf("{n} 個團隊", "{n} teams", { n: used.length })) : tr("還沒有團隊使用", "No team uses it yet"),
      ),
    ),
  );
}

/** The tile that starts a new team agent, at the end of the grid. */
function addTile(host: AgentsHost): HTMLElement {
  const natives = host.natives();
  return h(
    "button",
    {
      type: "button",
      class: "ta-card ta-add",
      disabled: !natives.length,
      title: natives.length ? "" : tr("先到 設定 → Agents 建立原生 Agent", "First add a native agent in Settings → Agents"),
      onClick: () => {
        draft = { id: `ta-${Date.now().toString(36)}`, name: "", base: natives[0]?.id ?? "", model: "", systemPrompt: "", mcp: [], skills: [], description: "" };
        draftIsNew = true;
        problem = "";
        host.render();
        requestAnimationFrame(() => document.querySelector(".ta-editor")?.scrollIntoView({ block: "start", behavior: "smooth" }));
      },
    },
    h("span", { class: "ta-add-plus", text: "+" }),
    h("span", { text: tr("新增團隊 Agent", "New team agent") }),
  );
}

export function agentsPage(host: AgentsHost): HTMLElement {
  void loadTeamAgents(host.render, host.natives());
  if (!doc) return h("div", { class: "ta" }, h("p", { class: "dim", text: tr("讀取中…", "Loading…") }));
  return h(
    "div",
    { class: "ta" },
    h(
      "section",
      { class: "panel" },
      h("p", {}, tr("以 設定 → Agents 裡的原生 Agent 為基底,做出團隊專用的 Agent:自己的名稱、模型、system prompt、MCP 與 skill,再寫一段說明讓秘書知道它適合做什麼。執行時沿用基底的指令、環境變數與金鑰。", "Build agents for your teams on a native agent from Settings → Agents: their own name, model, system prompt, MCP servers and skills, plus a description that tells the secretary what each is good for. They run with the base's command, environment variables and key.")),
      h("div", { class: "row" }, h("b", { text: tr("新團隊使用", "New teams use") }), sourceSwitch(host.render)),
      h("p", { class: "hint", text: agentSource() === "team" ? tr("現在秘書開團隊、你在「團隊設定」新增成員時,Agent 下拉只列這裡的團隊 Agent。已經設定好的團隊照舊能啟動。", "When the secretary sets up a team, or you add a member in Team setup, the agent list now shows only the team agents here. Teams already set up still start as before.") : tr("現在秘書與新增成員用的是原生 Agent;切到「團隊定義的 Agent」後只列這裡的。這個開關也在秘書的設定裡。", "The secretary and new members now use native agents; switch to Team agents to list only the ones here. This switch is in the secretary's settings too.") }),
      state ? h("p", { class: "hint", role: "status", text: stateText() }) : null,
    ),
    // On the native agents the team agents are put away, not deleted: nobody
    // reading the page should think they are what new teams are made of.
    agentSource() === "team" && draft ? editor(host, draft) : null,
    agentSource() === "team"
      ? h(
          "section",
          { class: "panel" },
          h("div", { class: "panel-head" }, h("h2", {}, tr("團隊 Agent", "Team agents"), h("span", { class: "count", text: String(teamAgents().length) })), h("span", { class: "dim", text: tr("按兩下卡片也可以編輯", "You can also double-click a card to edit it") })),
          !draft && problem ? h("p", { class: "problem", text: problem }) : null,
          h("div", { class: "ta-grid-list" }, ...teamAgents().map((a, i) => card(host, a, i)), addTile(host)),
        )
      : h(
          "section",
          { class: "panel ta-away" },
          h("b", { text: teamAgents().length ? trf("團隊 Agent 已收起({n} 個,都還在)", "Team agents put away ({n}, all still there)", { n: teamAgents().length }) : tr("團隊 Agent 已收起", "Team agents put away") }),
          h("p", { class: "hint", text: tr("現在用的是原生 Agent,所以這裡不顯示團隊 Agent,免得誤會;資料沒有刪除。切到上方的「團隊定義的 Agent」就會再出現,也能新增與編輯。已經設定好、用到團隊 Agent 的團隊照樣能啟動。", "Native agents are in use now, so the team agents are not shown here, to avoid confusion; nothing was deleted. Switch to Team agents above to see them again and to add or edit them. Teams already set up with team agents still start as before.") }),

        ),
  );
}
