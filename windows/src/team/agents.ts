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
let state = "";
/** The agent being edited (a copy), and whether it is new. */
let draft: TeamAgent | null = null;
let draftIsNew = false;
let problem = "";
/** The agent whose 刪除 has been pressed once. */
let deleting: string | null = null;

const DEMO: TeamAgents = {
  source: "native",
  agents: [
    {
      id: "ta-reviewer",
      name: "嚴格審查員",
      base: "claude",
      model: "",
      systemPrompt: "你是一位嚴格的程式碼審查者。每次審查都要列出風險、測試缺口與可以更簡單的寫法。",
      mcp: [{ name: "docs", command: "", args: [], url: "https://docs.example.com/mcp" }],
      skills: ["code-review"],
      description: "審查程式碼、找出風險與缺少的測試;適合當 Leader 或最後把關。",
    },
    {
      id: "ta-designer",
      name: "介面設計師",
      base: "agy",
      model: "",
      systemPrompt: "",
      mcp: [],
      skills: [],
      description: "畫介面、做圖片與排版。",
    },
  ],
};

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
      doc = doc ?? structuredClone(DEMO);
      supports = Object.fromEntries(natives.map((a) => [a.id, demoSupports(a.protocol)]));
    }
  } catch (err) {
    state = `讀不到:${String(err instanceof Error ? err.message : err)}`;
    doc = doc ?? { source: "native", agents: [] };
  }
  loading = false;
  render();
}

export function teamAgents(): TeamAgent[] {
  return doc?.agents ?? [];
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
    state = "已儲存 · 下次啟動的團隊就照新的設定";
    problem = "";
    return true;
  } catch (err) {
    problem = String(err instanceof Error ? err.message : err).replace(/^Error:\s*/, "");
    return false;
  } finally {
    render();
  }
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
  return h("div", { class: "segmented", role: "group", "aria-label": "團隊使用哪種 Agent" }, item("native", "原生 Agent"), item("team", "團隊定義的 Agent"));
}

const SUPPORT_TEXT: Record<TeamAgentSupport, string> = {
  native: "原生支援",
  brief: "寫進成員的開場說明",
  no: "此 agent 類型不支援",
};

function badge(s: TeamAgentSupport | undefined): HTMLElement | null {
  if (!s) return null;
  return h("span", { class: `ta-support ${s}`, text: SUPPORT_TEXT[s] });
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
    h("button", { type: "button", class: remote ? "" : "on", onClick: () => { m.url = ""; host.render(); } }, "指令"),
    h("button", { type: "button", class: remote ? "on" : "", onClick: () => { m.command = ""; m.args = []; m.url = m.url || "https://"; host.render(); } }, "URL"),
  );
  return h(
    "div",
    { class: `ta-mcp${off ? " off" : ""}` },
    field(`ta-mcp-name-${at}`, m.name, (v) => (m.name = v.trim()), { placeholder: "名稱,例如 github", class: "field ta-mcp-name" }),
    kind,
    remote
      ? field(`ta-mcp-url-${at}`, m.url, (v) => (m.url = v.trim()), { placeholder: "https://…/mcp", class: "field mono ta-mcp-main" })
      : h(
          "div",
          { class: "ta-mcp-main row nowrap" },
          field(`ta-mcp-cmd-${at}`, m.command, (v) => (m.command = v.trim()), { placeholder: "指令,例如 npx", class: "field mono" }),
          field(`ta-mcp-args-${at}`, joinArgs(m.args), (v) => (m.args = splitArgs(v)), { placeholder: "參數,以空白分隔,例如 -y @modelcontextprotocol/server-github", class: "field mono" }),
        ),
    h("button", { type: "button", class: "link quiet-danger", onClick: () => { a.mcp.splice(at, 1); host.render(); } }, "移除"),
  );
}

/** The models each base agent offers, asked once per window: base id → list (or why not). */
const modelLists = new Map<string, ModelChoice[] | string>();

/**
 * The model, typed or picked from what the base agent offers. The list is
 * asked for the first time the field is used: a handshake with the base, with
 * its own key, nothing spent.
 */
function modelField(a: TeamAgent, base: AgentProfile | undefined): HTMLElement {
  const input = field("ta-model", a.model, (v) => (a.model = v.trim()), {
    placeholder: base?.model ? `留空用基底的:${base.model}` : "留空用基底 Agent 的預設",
    autocomplete: "off",
    class: "field ta-model-input",
  }) as HTMLInputElement;
  suggest(input, () => {
    if (!base) return "先選基底 Agent";
    const got = modelLists.get(base.id);
    if (got === undefined) return "讀取這個 Agent 提供的模型…";
    return Array.isArray(got) ? got.map((c) => ({ value: c.id, label: c.id, hint: c.label !== c.id ? c.label : undefined })) : got;
  });
  input.addEventListener("focus", () => {
    if (!base || modelLists.has(base.id)) return;
    if (!IS_TAURI) {
      modelLists.set(base.id, (base.protocol === "codex" ? ["gpt-5.6-sol", "gpt-5.6-luna"] : base.protocol === "claude" ? ["opus", "sonnet", "haiku"] : ["deepseek-v4-flash", "glm-5.3-flash"]).map((id) => ({ id, label: id })));
      refreshSuggestions(input);
      return;
    }
    modelLists.set(base.id, "載入中…");
    Bridge.agentModels(base)
      .then((found) => modelLists.set(base.id, found.length ? found : "這個 Agent 沒有列出模型,直接輸入名稱"))
      .catch((err) => modelLists.set(base.id, String(err).replace(/^Error:\s*/, "")))
      .finally(() => refreshSuggestions(input));
  });
  return h(
    "div",
    { class: "ta-model" },
    input,
    h("button", { type: "button", class: "ta-model-open", tabindex: "-1", "aria-label": "列出模型", title: "列出基底 Agent 提供的模型", html: CHEVRON, onMousedown: (e: Event) => e.preventDefault(), onClick: () => (document.activeElement === input ? input.dispatchEvent(new Event("refresh-suggestions")) : input.focus()) }),
  );
}

function editor(host: AgentsHost, a: TeamAgent): HTMLElement {
  const natives = host.natives();
  const base = natives.find((n) => n.id === a.base);
  const can = supports[a.base];
  const choices = natives.map((n) => ({ value: n.id, label: n.name, hint: n.protocol === "codex" ? "Codex" : n.protocol === "claude" ? "Claude Code" : n.protocol === "agy" ? "Antigravity" : n.command }));
  if (a.base && !base) choices.unshift({ value: a.base, label: `${a.base}(不存在)`, hint: "不在 設定 → Agents 裡" });
  const mcpOff = can?.mcp === "no";
  return h(
    "section",
    { class: "panel form ta-editor" },
    h("div", { class: "panel-head" }, h("h2", { text: draftIsNew ? "新增團隊 Agent" : `編輯「${a.name || "未命名"}」` })),
    h(
      "div",
      { class: "ta-grid" },
      h("label", { text: "名稱" }),
      field("ta-name", a.name, (v) => (a.name = v), { placeholder: "例如:嚴格審查員" }),
      h("label", { text: "基底 Agent" }),
      h(
        "div",
        { class: "row nowrap" },
        dropdown({ value: a.base, choices, placeholder: "選擇原生 Agent…", title: "用哪個原生 Agent 的指令、環境變數與金鑰執行", onChange: (v) => { a.base = v; host.render(); } }),
        h("span", { class: "hint" }, "來自 ", h("button", { class: "link", type: "button", onClick: () => host.openSettings() }, "設定 → Agents"), ";金鑰沿用它的,不另外存。"),
      ),
      h("label", { text: "模型" }),
      modelField(a, base),
      h("label", { text: "說明(給秘書看)" }),
      field("ta-desc", a.description, (v) => (a.description = v), { rows: "2", placeholder: "適合做什麼、擅長什麼。秘書開團隊時照這段話挑人。" }, "textarea"),
      h("label", {}, "System prompt ", badge(can?.systemPrompt)),
      field("ta-prompt", a.systemPrompt, (v) => (a.systemPrompt = v), { rows: "6", placeholder: "這個 Agent 一直要遵守的指示、口吻、做事方式" }, "textarea"),
      h("label", {}, "MCP server ", badge(can?.mcp)),
      h(
        "div",
        { class: "ta-mcps" },
        mcpOff ? h("p", { class: "problem", text: "這個基底 Agent 的類型不支援個別成員的 MCP server(Antigravity 只讀工作資料夾的設定,會變成全隊共用),存了也不會帶給它。" }) : null,
        ...a.mcp.map((m, i) => mcpRow(host, a, m, i, mcpOff)),
        h("button", { type: "button", class: "add", onClick: () => { a.mcp.push({ name: "", command: "", args: [], url: "" }); host.render(); } }, "＋ 新增 MCP server"),
        h("p", { class: "hint", text: "啟動指令(stdio)或網址(HTTP)。不能填金鑰:需要金鑰的 MCP 請用它自己的登入方式。這些工具每次使用都會照一般規則問你,不像團隊工具自動放行。" }),
      ),
      h("label", {}, "Skill ", badge(can?.skills)),
      h(
        "div",
        {},
        field("ta-skills", a.skills.join("\n"), (v) => (a.skills = v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)), { rows: "3", placeholder: "一行一個:含 SKILL.md 的資料夾完整路徑,或 skill 名稱(會到 ~/.claude/skills 等常見位置找)", class: "field mono" }, "textarea"),
        h("p", { class: "hint", text: "成員開工時會被告知每個 skill 的 SKILL.md 在哪、適合做什麼,需要時自己讀。" }),
      ),
    ),
    problem ? h("p", { class: "problem", text: problem }) : null,
    h(
      "div",
      { class: "row end" },
      h("button", { type: "button", class: "btn plain", onClick: () => { draft = null; problem = ""; host.render(); } }, "取消"),
      h(
        "button",
        {
          type: "button",
          class: "btn primary",
          disabled: !a.name.trim() || !a.base,
          onClick: () => {
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
        "儲存",
      ),
    ),
  );
}

function card(host: AgentsHost, a: TeamAgent): HTMLElement {
  const natives = host.natives();
  const base = natives.find((n) => n.id === a.base);
  const used = host.usedBy(a.id);
  const facts = [
    base ? `基底:${base.name}` : `基底「${a.base}」不在 設定 → Agents 裡`,
    `模型:${a.model || (base?.model ? `${base.model}(基底)` : "基底預設")}`,
    a.systemPrompt.trim() ? "有 system prompt" : "",
    a.mcp.length ? `MCP:${a.mcp.map((m) => m.name).join("、")}` : "",
    a.skills.length ? `Skill:${a.skills.length} 個` : "",
  ].filter(Boolean);
  return h(
    "div",
    { class: `ta-card${base ? "" : " broken"}` },
    h(
      "div",
      { class: "ta-card-main" },
      h("b", { text: a.name || a.id }),
      h("p", { class: "ta-desc", text: a.description || "(沒有說明:秘書不知道它適合做什麼)" }),
      h("p", { class: "hint", text: facts.join(" · ") }),
      used.length ? h("p", { class: "hint", text: `使用中:${used.join("、")}` }) : null,
    ),
    h(
      "div",
      { class: "ta-card-side" },
      h("button", { type: "button", class: "btn plain", onClick: () => { draft = structuredClone(a); draftIsNew = false; problem = ""; deleting = null; host.render(); } }, "編輯"),
      h(
        "button",
        {
          type: "button",
          class: "link quiet-danger",
          title: used.length ? `${used.join("、")} 用到它:刪掉後這些團隊要改選別的 Agent 才能啟動` : "",
          onClick: () => {
            if (deleting !== a.id) {
              deleting = a.id;
              host.render();
              return;
            }
            deleting = null;
            void persist({ source: agentSource(), agents: teamAgents().filter((x) => x.id !== a.id) }, host.render);
          },
        },
        deleting === a.id ? (used.length ? `確定刪除?${used.length} 個團隊用到它` : "確定刪除?") : "刪除",
      ),
    ),
  );
}

export function agentsPage(host: AgentsHost): HTMLElement {
  void loadTeamAgents(host.render, host.natives());
  if (!doc) return h("div", { class: "ta" }, h("p", { class: "dim", text: "讀取中…" }));
  const natives = host.natives();
  return h(
    "div",
    { class: "ta" },
    h(
      "section",
      { class: "panel" },
      h("p", {}, "以 設定 → Agents 裡的原生 Agent 為基底,做出團隊專用的 Agent:自己的名稱、模型、system prompt、MCP 與 skill,再寫一段說明讓秘書知道它適合做什麼。執行時沿用基底的指令、環境變數與金鑰。"),
      h("div", { class: "row" }, h("b", { text: "新團隊使用" }), sourceSwitch(host.render)),
      h("p", { class: "hint", text: agentSource() === "team" ? "現在秘書開團隊、你在「團隊設定」新增成員時,Agent 下拉只列這裡的團隊 Agent。已經設定好的團隊照舊能啟動。" : "現在秘書與新增成員用的是原生 Agent;切到「團隊定義的 Agent」後只列這裡的。這個開關也在秘書的設定裡。" }),
      state ? h("p", { class: "hint", role: "status", text: state }) : null,
    ),
    draft ? editor(host, draft) : null,
    h(
      "section",
      { class: "panel" },
      h("div", { class: "panel-head" }, h("h2", {}, "團隊 Agent", h("span", { class: "count", text: String(teamAgents().length) }))),
      teamAgents().length ? h("div", { class: "ta-list" }, ...teamAgents().map((a) => card(host, a))) : h("p", { class: "dim", text: "還沒有。按下面新增第一個。" }),
      !draft && problem ? h("p", { class: "problem", text: problem }) : null,
      h(
        "button",
        {
          type: "button",
          class: "add",
          disabled: !natives.length,
          title: natives.length ? "" : "先到 設定 → Agents 建立原生 Agent",
          onClick: () => {
            draft = { id: `ta-${Date.now().toString(36)}`, name: "", base: natives[0]?.id ?? "", model: "", systemPrompt: "", mcp: [], skills: [], description: "" };
            draftIsNew = true;
            problem = "";
            host.render();
          },
        },
        "＋ 新增團隊 Agent",
      ),
    ),
  );
}
