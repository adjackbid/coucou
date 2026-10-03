// The Teamwork window: which teams there are, how each is set up, and — for
// the one running — who is doing what, who waits on whom and what has been
// handed in.
//
// What the monitor shows comes whole from the team's snapshot as the
// orchestrator sends it (`team-changed`); this page keeps nothing of its own
// beyond what is being typed. The screen is drawn again on every change,
// which is cheap at this size and leaves nothing to fall out of step — except
// the live pieces (live.ts): each member's Mochi, bubble and screen, which
// stream between pictures (`team-screen`) and are moved into each new one.

import "./team.css";
import { Bridge, IS_TAURI, onDragDrop, onEvent } from "../core/bridge";
import type { AgentProfile, ModelChoice } from "../core/state";
import { h, clear } from "../views/dom";
import * as live from "./live";
import { dropdown, menuOpen, onMenuClosed, refreshSuggestions, suggest } from "./ui";
import { linksScreen, logScreen, type Page } from "./screens";
import type { Danger, Deliverable, FeedItem, MemberStatus, MemberView, ScreenPatch, Snapshot, Task, TeamConfig, TeamFile } from "./types";

const root = document.getElementById("team-root")!;

let dir = "";
let files: TeamFile[] = [];
/** The agents of Settings → Agents: what a member can run as. */
let agents: AgentProfile[] = [];
/** The latest snapshot of each team, by team id. */
const runs = new Map<string, Snapshot>();
/** The team file being looked at, and which of its screens. */
let selected: string | null = null;
let tab: "setup" | "links" | "monitor" | "log" = "setup";
/** The form's working copy of the selected team; saved on request. */
let editing: TeamConfig | null = null;
let unsaved = false;
/** The last thing that went wrong, shown until the next action. */
let trouble = "";
/** Who the instruction box writes to: "" is the leader. */
let recipient = "";
/** What is typed in each field, so drawing again does not lose it. */
const drafts = new Map<string, string>();
/** The models each agent offers, asked once per window: agent id → list (or why not). */
const modelLists = new Map<string, ModelChoice[] | string>();
/** The team file whose delete button has been pressed once. */
let confirming: string | null = null;
const ICON_COPY = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';

/** The member whose screen is shown large; null for everyone side by side. */
let focused: string | null = null;

/** A file going out with the next instruction: already in the team's folder. */
interface Attachment {
  path: string;
  name: string;
  /** A thumbnail, for an image whose bytes the page had. */
  preview: string | null;
}
/** What the next instruction carries, per team. */
const attachments = new Map<string, Attachment[]>();
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i;

async function attach(team: string, add: () => Promise<Attachment>) {
  await act(async () => {
    const a = await add();
    attachments.set(team, [...(attachments.get(team) ?? []), a]);
  });
}

function attachBlob(team: string, file: File) {
  const name = file.name || `pasted-${Date.now()}.png`;
  void attach(team, async () => ({ path: await Bridge.teamAttachBytes(team, name, await file.arrayBuffer()), name, preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null }));
}

const YOU = "you";
/** Coucou's own accents, for members that were given no colour. */
const PALETTE = ["#3B9EFF", "#34D399", "#A78BFA", "#F5A524", "#F472B6", "#22D3EE"];

const STATUS: Record<MemberStatus, { label: string; mark: string }> = {
  working: { label: "工作中", mark: "◔" },
  waitingDelivery: { label: "等待交付", mark: "⧖" },
  waitingReply: { label: "等待回覆", mark: "…" },
  waitingYou: { label: "等你處理", mark: "!" },
  idle: { label: "待命", mark: "○" },
  done: { label: "已完成", mark: "✓" },
  lost: { label: "失聯", mark: "×" },
};

const TEAM_STATUS: Record<Snapshot["status"], string> = {
  idle: "尚未啟動",
  running: "執行中",
  paused: "已暫停",
  finished: "已完成",
};

const DANGER: Record<Danger, string> = {
  "deletes-folder": "會刪除資料夾",
  "deletes-many": "會一次刪除多個檔案",
  installs: "會安裝套件或程式",
  downloads: "會從網路下載東西",
  "destructive-git": "這個 git 指令會丟掉變更",
  "sends-out": "會對外發送或發布",
  "outside-work-dir": "會動到工作資料夾以外的地方",
  system: "會變更系統或其他程序",
  opaque: "無法判讀這個指令在做什麼",
};

const PRIORITY: Record<Task["priority"], string> = { high: "高", medium: "中", low: "低" };

// ── Small pieces ──────────────────────────────────────────────────────────────

/**
 * The orchestrator's own sentences, in the window's language. Anything else —
 * an agent's error message, say — is shown as it came.
 */
function said(text: string): string {
  const rules: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^It ended two turns in a row without a word about its open work\.$/, () => "連續兩輪結束時都沒有回報手上的工作"],
    [/^Paused by the user\.$/, () => "由你暫停"],
    [/^The team has used its (\d+) turns\.$/, (m) => `已用完 ${m[1]} 回合的上限`],
    [/^(TASK-\d+) was sent back (\d+) times\.$/, (m) => `${m[1]} 已被退回 ${m[2]} 次`],
    [/^Coucou was closed while the team was running\.$/, () => "團隊執行中時 Coucou 被關閉"],
    [/^interrupted$/, () => "被中斷"],
    // Why a team cannot start.
    [/^The work folder (.+) does not exist\.$/, (m) => `工作資料夾 ${m[1]} 不存在`],
    [/^The work folder must be a full path\.$/, () => "還沒有選擇工作資料夾"],
    [/^(.+) runs as agent '(.*)', which is not in Settings → Agents\.$/, (m) => `${m[1]} 還沒有選擇代理${m[2] ? `(「${m[2]}」不在 設定 → Agents 裡)` : ""}`],
    [/^The leader '(.+)' is not a member\.$/, (m) => `Leader「${m[1]}」不是團隊成員`],
    [/^The team has no goal\.$/, () => "還沒有填寫任務描述"],
    [/^The team has no members\.$/, () => "團隊沒有成員"],
    [/^Two members are called '(.+)'\.$/, (m) => `有兩位成員的 id 都是「${m[1]}」`],
    [/^'(.+)' cannot be a member id\.$/, (m) => `「${m[1]}」不能當成員 id`],
    [/^The team id may only use letters, digits, '-' and '_'\.$/, () => "團隊 id 只能用英數字、- 與 _"],
    [/^A link joins '(.+)' and '(.+)', and one of them is not a member\.$/, (m) => `協作關係連到「${m[1]}」與「${m[2]}」,其中一個不是成員`],
    [/^The team '(.+)' is already running\.$/, (m) => `團隊「${m[1]}」已經在執行中`],
    [/^That is not a member of the team\.$/, () => "這不是團隊成員"],
    [/^This team was loaded from an earlier run\. Press Continue to pick it up\.$/, () => "這是上次執行留下的紀錄:按上方「從中斷處繼續」,它會和其他成員一起重新啟動"],
    [/^The team's record has no setup to pick up\.$/, () => "這份紀錄裡沒有團隊設定,沒辦法接著做;請到「團隊設定」重新開始"],
  ];
  for (const [pattern, to] of rules) {
    const m = text.match(pattern);
    if (m) return to(m);
  }
  // Agents' own errors, wherever they sit in what came back.
  const inside: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/Claude Code is not signed in\./, () => "Claude Code 還沒登入:請在終端機執行 claude,輸入 /login 登入後,再按「重新啟動這位成員」"],
    [/The '(.+?)' model is not supported when using Codex with a ChatGPT account/, (m) => `Codex 的 ChatGPT 帳號不能用「${m[1]}」模型,請在團隊設定替這位成員換一個模型`],
    [/user rejected MCP tool call/, () => "Codex 擋下了團隊工具的呼叫"],
  ];
  for (const [pattern, to] of inside) {
    const m = text.match(pattern);
    if (m) return to(m);
  }
  return text;
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function colorOf(team: { members: { id: string; color: string }[] }, id: string): string {
  const at = team.members.findIndex((m) => m.id === id);
  if (at < 0) return "#9398A1";
  return team.members[at].color || PALETTE[at % PALETTE.length];
}

function nameOf(snap: Snapshot, id: string): string {
  if (id === YOU) return "你";
  if (id === "system") return "Coucou";
  return snap.members.find((m) => m.id === id)?.name ?? id;
}

/** A member's face: a small Mochi in the member's colour. */
function blob(color: string, size = 28): HTMLElement {
  return h("i", { class: "blob", style: `--c:${color};--s:${size}px`, "aria-hidden": "true" });
}

function who(snap: Snapshot, id: string, size = 18): HTMLElement {
  if (id === YOU || id === "system") return h("span", { class: "who", text: nameOf(snap, id) });
  return h("span", { class: "who" }, blob(colorOf(snap, id), size), h("span", { text: nameOf(snap, id) }));
}

function button(label: string, kind: "primary" | "plain" | "danger", onClick: () => void, disabled = false): HTMLElement {
  return h("button", { class: `btn ${kind}`, type: "button", disabled, onClick: () => onClick() }, label);
}

/** A text field that survives the screen being drawn again. */
function field(key: string, placeholder: string, onSubmit: (text: string) => void): HTMLInputElement {
  const input = h("input", { type: "text", class: "field", placeholder, "data-key": key, spellcheck: "false" }) as HTMLInputElement;
  input.value = drafts.get(key) ?? "";
  input.addEventListener("input", () => drafts.set(key, input.value));
  input.addEventListener("keydown", (e) => {
    // What was typed stays until it has really been sent.
    if (e.key === "Enter" && !e.isComposing && input.value.trim()) onSubmit(input.value.trim());
  });
  return input;
}

/** Runs something the person clicked, and shows what went wrong if it did. */
async function act(what: () => Promise<unknown>, after?: () => void) {
  trouble = "";
  try {
    await what();
    after?.();
  } catch (err) {
    trouble = String(err instanceof Error ? err.message : err);
  }
  render();
}

// ── Sidebar: the teams ────────────────────────────────────────────────────────

function select(file: string) {
  selected = file;
  trouble = "";
  const picked = files.find((f) => f.file === file);
  editing = picked?.config ? structuredClone(picked.config) : null;
  unsaved = false;
  const run = picked?.config ? runs.get(picked.config.id) : undefined;
  tab = run && run.status !== "idle" ? "monitor" : "setup";
}

function sidebar(): HTMLElement {
  const list = h("div", { class: "team-list" });
  for (const file of files) {
    const run = file.config ? runs.get(file.config.id) : undefined;
    const state = run ? TEAM_STATUS[run.status] : file.problems.length ? "尚未設定完成" : "可以啟動";
    const needsYou = run?.members.some((m) => m.status === "waitingYou" || m.status === "lost") ?? false;
    list.append(
      h(
        "div",
        { class: `team-row${file.file === selected ? " on" : ""}` },
        h(
          "button",
          {
            class: `team-item${file.file === selected ? " on" : ""}`,
            type: "button",
            onClick: () => {
              select(file.file);
              render();
            },
          },
          h("span", { class: "team-item-name", text: file.config?.name || "未命名的團隊" }),
          h("span", { class: `team-item-state${run?.status === "running" ? " live" : ""}${needsYou ? " you" : ""}`, text: needsYou ? `${state} · 等你` : state }),
        ),
        h(
          "span",
          { class: "team-actions" },
          h("button", {
            class: "icon-btn",
            type: "button",
            title: "複製這個團隊",
            "aria-label": "複製這個團隊",
            html: ICON_COPY,
            onClick: () =>
              void act(async () => {
                const copy = await Bridge.teamDuplicate(file.file);
                await load();
                select(copy);
              }),
          }),
          // Deleting asks twice, right here: the first click arms it.
          confirming === file.file
            ? h("button", {
                class: "icon-btn armed",
                type: "button",
                title: "再按一次刪除(檔案會移到 .deleted,可以找回)",
                onClick: () =>
                  void act(async () => {
                    confirming = null;
                    await Bridge.teamDelete(file.file);
                    if (selected === file.file) selected = null;
                    await load();
                  }),
              }, "刪除?")
            : h("button", {
                class: "icon-btn",
                type: "button",
                title: run && run.status !== "finished" && !run.detached ? "團隊執行中,先停下才能刪除" : "刪除這個團隊",
                "aria-label": "刪除這個團隊",
                disabled: !!run && run.status !== "finished" && !run.detached,
                html: ICON_TRASH,
                onClick: () => {
                  confirming = file.file;
                  render();
                  window.setTimeout(() => {
                    if (confirming === file.file) {
                      confirming = null;
                      render();
                    }
                  }, 4000);
                },
              }),
        ),
      ),
    );
  }
  if (!files.length) list.append(h("p", { class: "hint", text: "還沒有團隊。" }));

  return h(
    "aside",
    { class: "sidebar pane" },
    h("div", { class: "brand", "data-drag": "" }, teamMark(30), h("span", { text: "Teamwork" })),
    h("div", { class: "side-title", text: "團隊" }),
    list,
    h(
      "div",
      { class: "side-foot" },
      button("＋ 新增團隊", "plain", () =>
        void act(async () => {
          const file = await Bridge.teamNew();
          await load();
          select(file);
        }),
      ),
      h("button", { class: "link", type: "button", title: dir, onClick: () => void Bridge.teamOpenConfigs() }, "開啟團隊檔案的資料夾"),
    ),
  );
}

/** Three small Mochis side by side: the Teamwork mark, as on the island. */
function teamMark(size: number): HTMLElement {
  const el = h("span", { class: "team-mark", style: `--s:${size}px`, "aria-hidden": "true" });
  el.append(blob("#34D399", size * 0.62), blob("#A78BFA", size * 0.78), blob("#F5A524", size * 0.62));
  return el;
}

// ── Team setup ────────────────────────────────────────────────────────────────

/** An input bound to the form's working copy. Typing does not redraw. */
function bound<K extends "input" | "textarea">(tag: K, key: string, value: string, set: (v: string) => void, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const el = h(tag, { class: "field", "data-key": key, spellcheck: "false", ...attrs }) as HTMLInputElement | HTMLTextAreaElement;
  el.value = value;
  el.addEventListener("input", () => {
    set(el.value);
    touched();
  });
  return el as HTMLElementTagNameMap[K];
}

/** Something in the form changed: the save button says so, without a redraw. */
function touched() {
  unsaved = true;
  root.querySelector(".save")?.classList.add("due");
}

function nextMemberId(config: TeamConfig): string {
  for (let n = 1; ; n++) if (!config.members.some((m) => m.id === `ai${n}`)) return `ai${n}`;
}

/** A new member row in the form, to fill in. */
function addMember(config: TeamConfig) {
  const id = nextMemberId(config);
  config.members.push({ id, name: `AI ${id.slice(2)}`, role: "", duty: "", agent: agents[0]?.id ?? "", color: "" });
  unsaved = true;
}

async function save(): Promise<boolean> {
  if (!selected || !editing) return false;
  await Bridge.teamSave(selected, editing);
  unsaved = false;
  // The file is read back, with whatever still stops it from starting.
  const listed = await Bridge.teamFiles();
  files = listed?.files ?? files;
  return true;
}

function setup(file: TeamFile): HTMLElement {
  const config = editing;
  if (!config) {
    return h("section", { class: "panel" }, h("h2", { text: file.file }), h("p", { class: "problem", text: file.problems.map(said).join("\n") }));
  }
  const run = runs.get(config.id);
  // Agents still behind it: the form waits for the next start. A record from
  // an earlier run, or a finished team, can be started again from scratch.
  const running = run?.status === "running" || (run?.status === "paused" && !run.detached);
  const again = !!run && !running;
  // Members added to the form while the team runs: they can join it now.
  const newcomers = running && run ? config.members.filter((m) => !run.members.some((x) => x.id === m.id)) : [];

  // ── Left: what the team is for ──
  const folder = bound("input", "workDir", config.workDir, (v) => (config.workDir = v), { placeholder: "選擇所有成員一起工作的資料夾" });
  const goal = h(
    "section",
    { class: "panel form" },
    h("h2", { text: "任務目標" }),
    h("label", { text: "團隊名稱" }),
    bound("input", "name", config.name, (v) => (config.name = v), { placeholder: "例如:購物網站團隊" }),
    h("label", { text: "任務描述" }),
    bound("textarea", "goal", config.goal, (v) => (config.goal = v), { rows: "5", placeholder: "要完成什麼、包含哪些功能、最後要交付什麼" }),
    h("label", { text: "任務範圍(以逗號分隔)" }),
    bound("input", "scope", config.scope.join("、"), (v) => (config.scope = v.split(/[,,、]/).map((x) => x.trim()).filter(Boolean)), { placeholder: "商品目錄、購物車、會員登入" }),
    h("label", { text: "工作資料夾" }),
    h(
      "div",
      { class: "row nowrap" },
      folder,
      button("選擇資料夾…", "plain", () =>
        void act(async () => {
          const picked = await Bridge.pickFolder(config.workDir, "選擇團隊的工作資料夾");
          if (picked) {
            config.workDir = picked;
            unsaved = true;
          }
        }),
      ),
    ),
    h("p", { class: "hint", text: "所有成員都在這個資料夾裡工作,交付的成果也放在這裡。" }),
    h("label", { text: "工作模式" }),
    h(
      "div",
      { class: "segmented" },
      h("button", { type: "button", class: config.autoApprove ? "on" : "", onClick: () => ((config.autoApprove = true), (unsaved = true), render()) }, "自主協作"),
      h("button", { type: "button", class: config.autoApprove ? "" : "on", onClick: () => ((config.autoApprove = false), (unsaved = true), render()) }, "逐步確認"),
    ),
    h("p", {
      class: "hint",
      text: config.autoApprove
        ? "成員改檔、建置、跑測試不會問你;刪資料夾、安裝東西、對外發送等危險動作仍然會問。"
        : "成員的每一個權限請求都會問你。",
    }),
    h("label", { text: "回合上限" }),
    h("div", { class: "row nowrap" }, bound("input", "maxTurns", String(config.maxTurns), (v) => (config.maxTurns = Math.max(1, Math.min(500, Number(v) || 60))), { type: "number", min: "1", max: "500", class: "field narrow" }), h("span", { class: "hint", text: "整個團隊用完這麼多回合後會暫停,等你決定要不要繼續。" })),
  );

  // ── Right: who is in it ──
  const members = h("div", { class: "member-rows" });
  config.members.forEach((m, at) => {
    const kindOf = (a: AgentProfile) => (a.protocol === "codex" ? "Codex" : a.protocol === "claude" ? "Claude Code" : a.command);
    const agentChoices = agents.map((a) => ({ value: a.id, label: a.name, hint: kindOf(a) !== a.name ? kindOf(a) : undefined }));
    if (m.agent && !agents.some((a) => a.id === m.agent)) agentChoices.unshift({ value: m.agent, label: `${m.agent}(不存在)`, hint: "不在 設定 → Agents 裡" });
    const agent = dropdown({
      value: m.agent,
      choices: agentChoices,
      placeholder: "選擇代理…",
      title: "這位成員用哪個代理執行",
      onChange: (v) => {
        m.agent = v;
        unsaved = true;
        render();
      },
    });
    const isLeader = config.leader === m.id;
    const profile = agents.find((a) => a.id === m.agent);
    const known = modelLists.get(m.agent);
    const model = bound("input", `m${at}.model`, m.model ?? "", (v) => (m.model = v.trim()), {
      placeholder: profile?.model ? `模型:${profile.model}(代理預設)` : "模型:代理預設",
      title: typeof known === "string" ? known : "留空就用代理自己的預設模型",
      autocomplete: "off",
    });
    suggest(model, () => {
      const got = modelLists.get(m.agent);
      if (got === undefined) return "讀取這個代理提供的模型…";
      return Array.isArray(got) ? got.map((c) => ({ value: c.id, label: c.id, hint: c.label !== c.id ? c.label : undefined })) : got;
    });
    // The list is asked for the first time the field is used: a handshake
    // with the agent, nothing spent.
    model.addEventListener("focus", () => {
      if (!profile || modelLists.has(profile.id)) return;
      modelLists.set(profile.id, "載入中…");
      Bridge.agentModels(profile)
        .then((found) => modelLists.set(profile.id, found))
        .catch((err) => modelLists.set(profile.id, String(err).replace(/^Error:\s*/, "")))
        .finally(() => refreshSuggestions(model));
    });
    members.append(
      h(
        "div",
        { class: `member-row${isLeader ? " leader" : ""}` },
        blob(colorOf(config, m.id), 34),
        h(
          "div",
          { class: "member-fields" },
          h(
            "div",
            { class: "row nowrap" },
            bound("input", `m${at}.name`, m.name, (v) => (m.name = v), { placeholder: "名稱", class: "field name" }),
            bound("input", `m${at}.role`, m.role, (v) => (m.role = v), { placeholder: "角色,例如:網站開發" }),
            agent,
          ),
          h("div", { class: "row nowrap" }, model),
          bound("input", `m${at}.duty`, m.duty, (v) => (m.duty = v), { placeholder: "職責:這位成員負責什麼" }),
        ),
        h(
          "div",
          { class: "member-side" },
          h(
            "button",
            { type: "button", class: `chip pick${isLeader ? " leader" : ""}`, title: "Leader 負責拆解需求、指派任務與審核成果", onClick: () => ((config.leader = m.id), (unsaved = true), render()) },
            isLeader ? "♛ Leader" : "設為 Leader",
          ),
          h(
            "button",
            {
              type: "button",
              class: "link quiet-danger",
              disabled: config.members.length <= 1,
              onClick: () => {
                config.members.splice(at, 1);
                if (config.leader === m.id) config.leader = config.members[0].id;
                unsaved = true;
                render();
              },
            },
            "移除",
          ),
        ),
      ),
    );
  });

  const team = h(
    "section",
    { class: "panel form" },
    h("h2", {}, "團隊成員", h("span", { class: "count", text: String(config.members.length) })),
    members,
    h(
      "button",
      {
        type: "button",
        class: "add",
        onClick: () => {
          addMember(config);
          render();
        },
      },
      "＋ 加入成員",
    ),
    agents.length
      ? h("p", { class: "hint" }, "代理在 ", h("button", { class: "link", type: "button", onClick: () => void Bridge.openSettingsWindow() }, "設定 → Agents"), " 裡新增與修改。")
      : h("p", { class: "problem" }, "還沒有任何代理。請先到 ", h("button", { class: "link", type: "button", onClick: () => void Bridge.openSettingsWindow() }, "設定 → Agents"), " 建立。"),
  );

  const stops = unsaved ? [] : file.problems;
  return h(
    "div",
    { class: "setup" },
    h("div", { class: "setup-grid" }, goal, team),
    stops.length ? h("div", { class: "problem" }, h("strong", { text: "啟動前還需要:" }), ...stops.map((p) => h("div", { text: `• ${said(p)}` }))) : null,
    h(
      "div",
      { class: "row end bar" },
      running
        ? h("span", { class: "hint", text: newcomers.length ? `${newcomers.map((m) => m.name).join("、")} 可以馬上加入;其他修改下次啟動才會套用。` : "這個團隊正在執行;這裡的修改下次啟動才會套用。" })
        : null,
      running && newcomers.length
        ? button(`讓 ${newcomers.length} 位新成員加入 →`, "primary", () =>
            void act(async () => {
              if (!(await save())) return;
              const again = files.find((f) => f.file === selected);
              const theirs = again?.problems.filter((p) => newcomers.some((m) => p.startsWith(`${m.name} `))) ?? [];
              if (theirs.length) throw new Error(theirs.join("\n"));
              await Bridge.teamJoin(file.file);
              tab = "monitor";
            }),
          )
        : null,
      again ? h("span", { class: "hint", text: "重新開始會從頭跑一次;上一次的紀錄會保留在團隊紀錄資料夾。" }) : null,
      h("button", { class: `btn plain save${unsaved ? " due" : ""}`, type: "button", onClick: () => void act(save) }, "儲存"),
      button(
        again ? "重新開始 →" : "啟動 Teamwork →",
        "primary",
        () =>
          void act(async () => {
            await save();
            const again = files.find((f) => f.file === selected);
            if (again?.problems.length) throw new Error(again.problems.join("\n"));
            runs.set(config.id, await Bridge.teamStart(file.file));
            tab = "monitor";
          }),
        running,
      ),
    ),
  );
}

// ── The monitor ───────────────────────────────────────────────────────────────

const CROWN = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#F5A524" stroke="#0b0c0e" stroke-width="1.2" stroke-linejoin="round" d="M3.5 8.5l4.6 3.6L12 5l3.9 7.1 4.6-3.6-1.9 10H5.4z"/></svg>';

/**
 * A member at its desk: its Mochi, what it says right now, what waits for
 * the person, and its live screen.
 */
function desk(snap: Snapshot, m: MemberView): HTMLElement {
  const status = STATUS[m.status];
  const task = m.task ? snap.tasks.find((t) => t.id === m.task) : undefined;
  const { avatar, bubble, screen, pulse } = live.parts(snap, m);
  const big = focused === m.id;
  const el = h("article", { class: `desk ${m.status}${big ? " focused" : ""}`, style: `--c:${colorOf(snap, m.id)}` });
  el.append(
    h(
      "header",
      { class: "desk-top" },
      h("span", { class: "seat" }, avatar, m.isLeader ? h("i", { class: "crown", title: "Leader", html: CROWN }) : null),
      h(
        "div",
        { class: "member-head" },
        h("div", { class: "member-name" }, h("span", { class: "name", text: m.name }), h("span", { class: `badge ${m.status}` }, h("b", { text: status.mark }), status.label)),
        h("div", { class: "member-role", title: m.duty, text: m.isLeader ? `Leader · ${m.role}` : m.role }),
      ),
      h(
        "button",
        {
          class: "zoom",
          type: "button",
          title: big ? "縮回" : "放大這位成員的畫面",
          "aria-label": big ? "縮回" : "放大這位成員的畫面",
          onClick: () => {
            focused = big ? null : m.id;
            render();
          },
        },
        big ? "⤡" : "⤢",
      ),
    ),
    bubble,
  );

  // The three things that wait for the person, answered right on the card.
  if (m.permission) {
    const p = m.permission;
    const input = p.rawInput && typeof p.rawInput === "object" ? (p.rawInput as Record<string, unknown>) : {};
    const command = typeof input.command === "string" ? input.command : "";
    const allow = p.options.find((o) => o.kind === "allow_once") ?? p.options.find((o) => o.kind === "allow_always");
    const reject = p.options.find((o) => o.kind === "reject_once") ?? p.options.find((o) => o.kind === "reject_always");
    // Several at once (Codex runs steps side by side): every one is listed,
    // and they can be answered together.
    const more = m.morePermissions;
    const commandOf = (x: typeof p) => {
      const raw = x.rawInput && typeof x.rawInput === "object" ? (x.rawInput as Record<string, unknown>) : {};
      return typeof raw.command === "string" ? raw.command : x.title;
    };
    el.append(
      h(
        "div",
        { class: "ask" },
        h("div", { class: "ask-why", text: p.danger ? `要你批准:${DANGER[p.danger]}` : "要你批准" }),
        h("div", { class: "ask-what mono", text: command || p.title }),
        more.length
          ? h(
              "details",
              { class: "ask-more" },
              h("summary", { text: `還有 ${more.length} 個請求在排隊` }),
              ...more.map((x) => h("div", { class: "ask-what mono", text: commandOf(x) })),
            )
          : null,
        h(
          "div",
          { class: "row" },
          button("允許這一次", "primary", () => void act(() => Bridge.teamPermit(snap.id, m.id, allow?.optionId ?? null)), !allow),
          button("拒絕", "plain", () => void act(() => Bridge.teamPermit(snap.id, m.id, reject?.optionId ?? null))),
          more.length ? button(`全部允許(${more.length + 1})`, "plain", () => void act(() => Bridge.teamPermit(snap.id, m.id, allow?.optionId ?? null, true)), !allow) : null,
          more.length ? button("全部拒絕", "plain", () => void act(() => Bridge.teamPermit(snap.id, m.id, reject?.optionId ?? null, true))) : null,
        ),
      ),
    );
  }
  const question = snap.questions.find((q) => q.by === m.id && q.answer === null);
  if (question) {
    el.append(
      h(
        "div",
        { class: "ask" },
        h("div", { class: "ask-why", text: "問你" }),
        h("div", { class: "ask-what", text: question.question }),
        field(`answer:${snap.id}:${question.id}`, "輸入回覆後按 Enter", (text) =>
          void act(
            () => Bridge.teamAnswer(snap.id, question.id, text),
            () => drafts.delete(`answer:${snap.id}:${question.id}`),
          ),
        ),
      ),
    );
  }
  if (m.status === "lost" && snap.detached) {
    el.append(h("div", { class: "hint", text: "按上方「從中斷處繼續」,它會和其他成員一起重新啟動。" }));
  } else if (m.status === "lost") {
    el.append(h("div", { class: "row" }, button("重新啟動這位成員", "primary", () => void act(() => Bridge.teamRecover(snap.id, m.id)))));
  }

  // Whether it is alive: its last sign of life, and — when it has gone quiet
  // in the middle of a turn — a way to interrupt just this turn.
  el.append(
    h(
      "div",
      { class: "pulse-row" },
      pulse,
      m.status === "working"
        ? h("button", { class: "btn plain stall", type: "button", title: "停掉它這一輪;它下一輪會被提醒手上的工作", onClick: () => void act(() => Bridge.teamInterruptMember(snap.id, m.id)) }, "打斷這一輪")
        : null,
    ),
  );
  el.append(
    screen,
    h(
      "footer",
      { class: "desk-foot" },
      task ? h("span", { class: "chip task", title: task.detail || task.title, text: `${task.id} · ${task.title}` }) : h("span", { class: "chip", title: m.duty, text: "沒有進行中的任務" }),
      h("span", { class: "chip agent", title: `使用的代理與模型 · 已進行的回合數\n${m.agent}${m.model ? ` · ${m.model}` : ""} · ${m.turns} 回合`, text: `${m.agent}${m.model ? ` · ${m.model}` : ""} · ${m.turns} 回合` }),
    ),
  );
  return el;
}

/** Everyone at their desks: the leader first, then as the team lists them. */
function stage(snap: Snapshot): HTMLElement {
  if (focused && !snap.members.some((m) => m.id === focused)) focused = null;
  const members = [...snap.members].sort((a, b) => Number(b.isLeader) - Number(a.isLeader));
  return h(
    "section",
    { class: `stage${focused ? " has-focus" : ""}` },
    h(
      "div",
      { class: "stage-head" },
      h("h2", { text: "團隊現場" }),
      snap.status !== "finished" && !snap.detached
        ? h(
            "button",
            {
              class: "btn plain more-hands",
              type: "button",
              title: "人手不夠時,加一位成員到這個執行中的團隊",
              onClick: () => {
                if (!editing) return;
                addMember(editing);
                tab = "setup";
                render();
                root.querySelector(".member-row:last-of-type")?.scrollIntoView({ block: "center", behavior: "smooth" });
              },
            },
            "＋ 加人手",
          )
        : null,
      h("span", { class: "hint", text: "每位成員說的話、跑的指令和結果都即時出現在它的畫面上;隊友之間的交辦、訊息與交付會從一位飛到另一位。" }),
    ),
    h("div", { class: "desks" }, ...members.map((m) => desk(snap, m))),
  );
}

function taskCard(snap: Snapshot, t: Task): HTMLElement {
  const met = t.criteria.filter((c) => c.claimed).length;
  const waitsFor = t.status === "todo" ? t.dependsOn.map((d) => snap.tasks.find((x) => x.id === d)).filter((d) => d && d.status !== "delivered" && d.status !== "done") : [];
  const card = h("article", { class: `task${t.blocked ? " blocked" : ""}`, title: t.detail });
  card.append(h("div", { class: "task-title" }, h("span", { text: t.title }), t.status === "done" ? h("span", { class: "tick", text: "✓", title: "已驗收" }) : null));
  const sub = t.blocked ? `卡住:${t.blocked.reason}(等 ${nameOf(snap, t.blocked.on)})` : waitsFor.length ? `等待${waitsFor.map((d) => d!.title).join("、")}` : t.note || t.detail.split("\n")[0];
  if (sub) card.append(h("div", { class: t.blocked ? "task-sub warn" : "task-sub", text: sub }));
  const marks = h("div", { class: "task-marks" });
  if (t.status === "delivered") marks.append(h("span", { class: "chip pending", text: "已交付,待驗收" }));
  if (t.criteria.length && t.status !== "done") marks.append(h("span", { class: "chip", title: t.criteria.map((c) => `${c.claimed ? "☑" : "☐"} ${c.text}`).join("\n"), text: `完成條件 ${met} / ${t.criteria.length}` }));
  if (t.rejections) marks.append(h("span", { class: "chip warn", text: `退回 ${t.rejections} 次` }));
  card.append(h("div", { class: "task-foot" }, who(snap, t.owner), marks, h("span", { class: `chip prio ${t.priority}`, title: "優先度", text: PRIORITY[t.priority] })));
  return card;
}

function board(snap: Snapshot): HTMLElement {
  const columns: [string, string, Task[]][] = [
    ["待處理", "todo", snap.tasks.filter((t) => t.status === "todo")],
    ["進行中", "doing", snap.tasks.filter((t) => t.status === "doing")],
    ["已完成", "done", snap.tasks.filter((t) => t.status === "delivered" || t.status === "done")],
  ];
  const grid = h("div", { class: "board" });
  for (const [title, kind, tasks] of columns) {
    const col = h("div", { class: `column ${kind}` }, h("div", { class: "column-head" }, h("span", { text: title }), h("span", { class: "count", text: String(tasks.length) })));
    for (const t of tasks) col.append(taskCard(snap, t));
    if (!tasks.length) col.append(h("div", { class: "empty", text: "—" }));
    grid.append(col);
  }
  return h("section", { class: "panel" }, h("h2", { text: "任務看板" }), snap.tasks.length ? grid : h("p", { class: "dim", text: "Leader 還沒有建立任務。" }));
}

const FEED_TITLE: Record<FeedItem["kind"], string> = {
  message: "訊息",
  task: "建立任務",
  delivered: "已交付",
  accepted: "驗收通過",
  rejected: "退回",
  blocked: "被卡住",
  asked: "向你提問",
  answered: "你的回覆",
  lost: "失聯",
  paused: "團隊暫停",
  finished: "團隊完成",
  joined: "加入團隊",
};

function feed(snap: Snapshot): HTMLElement {
  const list = h("div", { class: "feed" });
  const items = [...snap.feed].reverse().slice(0, 40);
  for (const item of items) {
    const task = item.task ? snap.tasks.find((t) => t.id === item.task) : undefined;
    const title = item.kind === "message" || !task ? FEED_TITLE[item.kind] : `${FEED_TITLE[item.kind]} · ${task.title}`;
    list.append(
      h(
        "div",
        { class: `feed-item ${item.kind}${item.to === YOU ? " to-you" : ""}` },
        h("div", { class: "feed-head" }, who(snap, item.from), item.to ? h("span", { class: "arrow", text: "→" }) : null, item.to ? who(snap, item.to) : null, h("time", { text: clock(item.at) })),
        h("div", { class: "feed-title", text: title }),
        item.text && item.kind !== "task" ? h("div", { class: "feed-text", text: said(item.text) }) : null,
      ),
    );
  }
  if (!items.length) list.append(h("p", { class: "dim", text: "還沒有任何協作紀錄。" }));
  return h("section", { class: "panel feed-panel" }, h("h2", { text: "最新協作" }), list);
}

function deliverables(snap: Snapshot): HTMLElement {
  const row = h("div", { class: "deliverables" });
  const icon = (d: Deliverable) => (d.locator.startsWith("http") ? "↗" : /image|圖/.test(d.kind) ? "▣" : /source|code|原始/.test(d.kind) ? "</>" : "▤");
  for (const d of [...snap.deliverables].reverse()) {
    const task = snap.tasks.find((t) => t.id === d.task);
    row.append(
      h(
        "button",
        { class: "deliverable", type: "button", title: `開啟 ${d.locator}`, onClick: () => void act(() => Bridge.teamOpen(snap.id, d.locator)) },
        h("span", { class: "deliverable-icon", text: icon(d) }),
        h(
          "span",
          { class: "deliverable-body" },
          h("span", { class: "deliverable-name", text: task?.title ?? d.task }),
          h("span", { class: "dim mono", text: d.locator }),
          h("span", { class: "dim", text: `${nameOf(snap, d.by)} · ${clock(d.at)} · ${d.summary}` }),
        ),
        h("span", { class: `chip ${d.accepted === true ? "ok" : d.accepted === false ? "warn" : "pending"}`, text: d.accepted === true ? "已驗收" : d.accepted === false ? "已退回" : "待驗收" }),
      ),
    );
  }
  if (!snap.deliverables.length) row.append(h("p", { class: "dim", text: "還沒有成員交付成果。" }));
  return h("section", { class: "panel" }, h("h2", { text: "已產生成果" }), row);
}

function composer(snap: Snapshot): HTMLElement {
  const leader = snap.members.find((m) => m.isLeader);
  const to = dropdown({
    value: recipient,
    choices: [
      { value: "", label: "給 Leader", hint: leader?.name },
      ...snap.members.filter((m) => !m.isLeader).map((m) => ({ value: m.id, label: `給 ${m.name}`, hint: m.role })),
    ],
    title: "傳給誰",
    className: "narrow",
    onChange: (v) => {
      recipient = v;
      render();
    },
  });
  const files = attachments.get(snap.id) ?? [];
  // The pictures go as full paths in the message: every agent can open an
  // image file in the team's folder with its own tool.
  const send = (text: string) => {
    if (!text && !files.length) return;
    let body = text || (files.some((f) => IMAGE.test(f.name)) ? "請看附上的圖片。" : "請看附上的檔案。");
    if (files.length) {
      body += `\n\n附上的${files.every((f) => IMAGE.test(f.name)) ? "圖片" : "檔案"}(在團隊資料夾裡,請用你讀檔或看圖片的工具打開):\n${files.map((f) => `- ${f.path}`).join("\n")}`;
    }
    void act(
      () => Bridge.teamInstruct(snap.id, recipient, body),
      () => {
        drafts.delete(`instruct:${snap.id}`);
        for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview);
        attachments.delete(snap.id);
      },
    );
  };
  const input = field(`instruct:${snap.id}`, "傳送新指示…可貼上、拖進或附上圖片(對方這一輪結束後才會讀到)", (t) => send(t));
  // Ctrl+V of a screenshot attaches it.
  input.addEventListener("paste", (e) => {
    const pasted = [...(e.clipboardData?.files ?? [])];
    if (!pasted.length) return;
    e.preventDefault();
    for (const f of pasted) attachBlob(snap.id, f);
  });
  const picker = h("input", { type: "file", accept: "image/*", multiple: true, style: "display:none" }) as HTMLInputElement;
  picker.addEventListener("change", () => {
    for (const f of picker.files ?? []) attachBlob(snap.id, f);
    picker.value = "";
  });
  const clip = h("button", { class: "btn plain clip", type: "button", title: "附上圖片(也可以直接貼上或拖進視窗)", "aria-label": "附上圖片", onClick: () => picker.click() }, "＋圖");
  const tray = files.length
    ? h(
        "div",
        { class: "attachments" },
        ...files.map((f) =>
          h(
            "span",
            { class: "attachment", title: f.path },
            f.preview ? h("img", { src: f.preview, alt: f.name }) : h("i", { text: IMAGE.test(f.name) ? "▣" : "▤" }),
            h("span", { class: "attachment-name", text: f.name }),
            h("button", {
              type: "button",
              class: "attachment-x",
              title: "拿掉",
              "aria-label": `拿掉 ${f.name}`,
              onClick: () => {
                if (f.preview) URL.revokeObjectURL(f.preview);
                attachments.set(snap.id, files.filter((x) => x !== f));
                render();
              },
            }, "×"),
          ),
        ),
      )
    : null;
  return h(
    "div",
    { class: `composer-wrap${files.length ? " has-files" : ""}` },
    tray,
    h(
      "div",
      { class: "composer" },
      to,
      clip,
      picker,
      input,
      button("送出", "primary", () => send(input.value.trim())),
    ),
  );
}

function monitor(snap: Snapshot): HTMLElement {
  const percent = snap.total ? Math.round((snap.done / snap.total) * 100) : 0;
  const minutes = Math.max(0, Math.floor(((snap.finishedAt || Date.now()) - snap.startedAt) / 60_000));

  return h(
    "div",
    { class: "monitor" },
    h(
      "div",
      { class: "progress" },
      h("span", { class: "progress-label", text: "整體進度" }),
      h("span", { class: "progress-number", text: `${percent}%` }),
      h("div", { class: "meter", role: "progressbar", "aria-valuenow": percent, "aria-valuemin": 0, "aria-valuemax": 100 }, h("i", { style: `width:${percent}%` })),
      h("span", { class: "dim", text: `已驗收 ${snap.done} / ${snap.total} 項任務` }),
      h("span", { class: "dim", text: `${snap.totalTurns} / ${snap.maxTurns} 回合` }),
      h("span", { class: "dim", text: `已執行 ${minutes} 分鐘` }),
    ),
    stage(snap),
    h("div", { class: "split" }, board(snap), feed(snap)),
    deliverables(snap),
    snap.status === "finished" ? null : composer(snap),
  );
}

// ── The page ──────────────────────────────────────────────────────────────────

/** The window has no title bar of its own: these three stand in for it. */
function windowButtons(): HTMLElement {
  const b = (label: string, title: string, action: "minimize" | "maximize" | "close") =>
    h("button", { class: `win ${action}`, type: "button", title, "aria-label": title, onClick: () => void Bridge.teamWindow(action) }, label);
  return h("div", { class: "window-buttons" }, b("–", "最小化", "minimize"), b("▢", "最大化", "maximize"), b("✕", "關閉", "close"));
}

function header(file: TeamFile, snap: Snapshot | undefined): HTMLElement {
  const name = snap?.name || editing?.name || file.config?.name || "未命名的團隊";
  const goal = (snap?.goal ?? editing?.goal ?? "").split("\n")[0];
  const count = snap?.members.length ?? editing?.members.length ?? 0;
  const actions = h("div", { class: "row" });
  if (snap?.status === "running") {
    actions.append(
      h("button", { class: "btn plain", type: "button", title: "不再開始新的回合;正在做的這一輪會做完", onClick: () => void act(() => Bridge.teamPause(snap.id)) }, "暫停"),
      button("全部中斷", "danger", () => void act(() => Bridge.teamInterrupt(snap.id))),
    );
  } else if (snap?.status === "paused") {
    // A team from an earlier run gets its agents back, and its members
    // their work, where it stopped.
    actions.append(button(snap.detached ? "從中斷處繼續" : "繼續", "primary", () => void act(() => Bridge.teamResume(snap.id))));
    // Pausing hands out no new turns; the ones under way run to their end.
    // Whoever is still at it can be stopped now.
    const busy = snap.members.filter((m) => m.status === "working").length;
    if (busy && !snap.detached) {
      actions.append(button(`立刻停下(${busy} 位還在做)`, "danger", () => void act(() => Bridge.teamInterrupt(snap.id))));
    }
  }
  return h(
    "header",
    { class: "top", "data-drag": "" },
    h(
      "div",
      { class: "top-title", "data-drag": "" },
      h("h1", { "data-drag": "" }, name, snap ? h("span", { class: `state ${snap.status}`, text: TEAM_STATUS[snap.status] }) : null),
      h("p", { class: "dim", "data-drag": "", text: goal ? `${goal} · ${count} 位 AI 成員` : `${count} 位 AI 成員` }),
      snap?.status === "paused" && snap.pausedWhy
        ? h("p", {
            class: "paused-why",
            text: snap.detached
              ? `${said(snap.pausedWhy)} · 按「從中斷處繼續」接著做,或到「團隊設定」重新開始`
              : snap.members.some((m) => m.status === "working")
                ? `${said(snap.pausedWhy)} · 不再開始新的回合;還在做的成員會把這一輪做完,要馬上停請按「立刻停下」`
                : said(snap.pausedWhy),
          })
        : null,
    ),
    actions,
    windowButtons(),
  );
}

function tabs(snap: Snapshot | undefined): HTMLElement {
  const item = (label: string, id: typeof tab, enabled: boolean, note = "") =>
    h(
      "button",
      {
        class: `tab${id && tab === id ? " on" : ""}`,
        type: "button",
        disabled: !enabled,
        onClick: () => {
          tab = id;
          render();
        },
      },
      label,
      note ? h("small", { text: note }) : null,
    );
  return h(
    "nav",
    { class: "tabs" },
    item("團隊設定", "setup", true),
    item("協作關係", "links", !!editing),
    item("工作監控", "monitor", !!snap, snap ? "" : "啟動後"),
    item("溝通紀錄", "log", !!snap, snap ? "" : "啟動後"),
  );
}

function main(): HTMLElement {
  const file = files.find((f) => f.file === selected);
  if (!file) {
    return h(
      "main",
      { class: "main pane" },
      h("header", { class: "top", "data-drag": "" }, h("div", { "data-drag": "" }), windowButtons()),
      h("div", { class: "welcome" }, teamMark(64), h("h1", { text: "Teamwork" }), h("p", { class: "dim", text: files.length ? "從左邊選一個團隊。" : "按左下角的「新增團隊」開始。" })),
    );
  }
  const snap = file.config ? runs.get(file.config.id) : undefined;
  // A screen that needs a running team falls back to the setup.
  const view =
    tab === "monitor" && snap ? monitor(snap)
    : tab === "log" && snap && editing ? logScreen(editing, snap, page)
    : tab === "links" && editing ? linksScreen(editing, snap, page)
    : setup(file);
  return h(
    "main",
    { class: "main pane" },
    header(file, snap),
    tabs(snap),
    trouble ? h("div", { class: "problem", role: "alert", text: trouble.split("\n").map(said).join("\n") }) : null,
    h("div", { class: "scroll" }, view),
  );
}

/** What the 協作關係 and 溝通紀錄 screens borrow from the page. */
const page: Page = { render: () => render(), act, save, said, colorOf, blob, composer, touched };

/** Drawing again waits while a menu is open: it hangs from a field that would be replaced. */
let renderWaiting = false;
onMenuClosed(() => {
  if (renderWaiting) {
    renderWaiting = false;
    render();
  }
});

function render() {
  if (menuOpen()) {
    renderWaiting = true;
    return;
  }
  // Drawing again must not take the caret out of a field someone is typing in.
  const active = document.activeElement as HTMLInputElement | null;
  const key = active?.dataset?.key;
  const caret = key && active!.type !== "number" ? [active!.selectionStart, active!.selectionEnd] : null;
  const scroll = root.querySelector(".scroll")?.scrollTop ?? 0;

  clear(root);
  root.append(h("div", { class: "shell" }, sidebar(), main()));

  const scroller = root.querySelector(".scroll");
  if (scroller) scroller.scrollTop = scroll;
  live.afterRender();
  if (key) {
    const again = root.querySelector<HTMLInputElement>(`[data-key="${CSS.escape(key)}"]`);
    if (again) {
      again.focus();
      if (caret) again.setSelectionRange(caret[0], caret[1]);
    }
  }
}

async function load() {
  if (IS_TAURI) {
    const listed = await Bridge.teamFiles();
    dir = listed?.dir ?? "";
    files = listed?.files ?? [];
    agents = (await Bridge.boot())?.settings.agents ?? [];
    for (const snap of (await Bridge.teamSnapshots()) ?? []) {
      runs.set(snap.id, snap);
      live.applySnapshot(snap);
    }
  } else if (import.meta.env.DEV) {
    // A plain browser: the drafts' team, to look at the screen without the app.
    const demo = await import("./demo");
    // No desktop behind a browser tab: stand one in, so the glass has something to show.
    document.documentElement.classList.add("demo");
    dir = demo.demoFiles.dir;
    files = demo.demoFiles.files;
    agents = demo.demoAgents;
    if (!runs.has("shop")) {
      const snap = demo.demoSnapshot();
      runs.set("shop", snap);
      live.applySnapshot(snap);
      tab = "monitor";
      demo.demoStream(live.applyPatch, (next) => {
        runs.set(next.id, next);
        live.applySnapshot(next);
        if (tab === "monitor") render();
      }, snap);
    }
  }
  if (!selected || !files.some((f) => f.file === selected)) {
    // The team that is running, else the first.
    const first = files.find((f) => f.config && runs.get(f.config.id)?.status === "running")?.file ?? files[0]?.file ?? null;
    if (first) select(first);
    else selected = null;
  } else if (!unsaved) {
    // The file may have been edited outside; an untouched form follows it.
    const again = files.find((f) => f.file === selected);
    editing = again?.config ? structuredClone(again.config) : null;
  }
  render();
}

async function start() {
  live.setSaid(said);
  await onEvent<Snapshot>("team-changed", (snap) => {
    runs.set(snap.id, snap);
    live.applySnapshot(snap);
    // Typing in the form is not interrupted by a team at work behind it.
    if (tab === "monitor" || !unsaved) render();
  });
  // Files dragged onto the window go with the next instruction to the team on screen.
  await onDragDrop((e) => {
    if (e.type !== "drop" || !e.paths?.length || tab !== "monitor") return;
    const file = files.find((f) => f.file === selected);
    const team = file?.config ? runs.get(file.config.id) : undefined;
    if (!team || team.status === "finished") return;
    for (const path of e.paths) {
      const name = path.split(/[\\/]/).pop() ?? path;
      void attach(team.id, async () => ({ path: await Bridge.teamAttachPath(team.id, path), name, preview: null }));
    }
  });
  // Each member's screen, as it happens: no redraw, just the lines.
  await onEvent<ScreenPatch>("team-screen", live.applyPatch);
  // Agents may have been added in the settings window meanwhile.
  await onEvent<{ agents: AgentProfile[] }>("settings-changed", (s) => {
    agents = s.agents ?? agents;
    if (!unsaved) render();
  });

  // The browser's own right-click menu belongs to no app: only fields and
  // selected text keep it, for copy and paste.
  document.addEventListener("contextmenu", (e) => {
    const target = e.target as HTMLElement;
    const editing = target.closest("input, textarea, [contenteditable]");
    if (!editing && !window.getSelection()?.toString()) e.preventDefault();
  });

  // The page is the title bar: drag it by its header, double-click to maximize.
  root.addEventListener("mousedown", (e) => {
    const target = e.target as HTMLElement;
    if (e.button === 0 && e.detail === 1 && target.hasAttribute("data-drag")) void Bridge.teamWindow("drag");
  });
  root.addEventListener("dblclick", (e) => {
    if ((e.target as HTMLElement).hasAttribute("data-drag")) void Bridge.teamWindow("maximize");
  });

  // "18 minutes" has to move on its own — but only while someone can see it:
  // a hidden window keeps no timer.
  let tick = 0;
  const watch = () => {
    window.clearInterval(tick);
    if (document.hidden) return;
    tick = window.setInterval(() => {
      if (tab === "monitor" && [...runs.values()].some((r) => r.status === "running")) render();
    }, 30_000);
  };
  document.addEventListener("visibilitychange", () => {
    watch();
    // Shown again: the team files may have been edited meanwhile.
    if (!document.hidden) void load();
  });
  watch();
  await load();
}

void start();
