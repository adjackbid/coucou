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
import { linksScreen, logScreen, openThread, type Page } from "./screens";
import { companyName, Office, setCompanyName } from "./office/office";
import { LARGE_FROM, THEME_LABELS } from "./office/scene";
import { savedWorld, saveWorld, WORLD_IDS, WORLDS } from "./office/battle/worlds";
import { ambientMotion, battleTempo, saveAmbientMotion, saveBattleTempo, saveCompanyFps, type Tempo } from "./office/battle/session";
import { costPage, fmtMoney, fmtTokens, refreshSoon, usageSummary, type CostHost } from "./cost";
import { onStep as secretaryStep, secretaryAttachPaths, secretaryName, secretaryPage, secretaryTitle, setSecretaryName, type SecretaryHost } from "./secretary";
import { constitutionPage } from "./constitution";
import { isImage, openImage, thumbImg, thumbsFor } from "./images";
import { agentLabel, agentSource, agentsPage, baseOf, loadTeamAgents, sourceSwitch, teamAgents, teamProfiles, type AgentsHost } from "./agents";
import { addPaths as addKnowledge, dropTarget, knowledgeChanged, knowledgePanel, setDragging, type KnowledgeHost } from "./knowledge";
import type { Danger, Deliverable, FeedItem, MemberStatus, MemberView, ScreenPatch, SecretaryStep, Snapshot, Task, TeamConfig, TeamFile } from "./types";

const root = document.getElementById("team-root")!;

/**
 * 玻璃濃度 (0–100): how dark a sheet lies over the system's blur. Windows
 * draws the blur itself and its radius cannot be set; how much of the
 * desktop shows through it can. Windows 11's acrylic is tinted already, so
 * it starts bare; Windows 10's classic blur is not, so it starts at half.
 */
const WIN10 = !!(window as unknown as { __coucouWin10?: boolean }).__coucouWin10;
const SHEET_DEFAULT = WIN10 ? 50 : 0;
function sheet(): number {
  try {
    const v = Number(localStorage.getItem("coucou.window.sheet"));
    if (localStorage.getItem("coucou.window.sheet") !== null && Number.isFinite(v)) return Math.max(0, Math.min(100, v));
  } catch {
    /* the default */
  }
  return SHEET_DEFAULT;
}
function applySheet(value = sheet()) {
  document.documentElement.classList.toggle("win10", WIN10);
  document.documentElement.style.setProperty("--sheet", String(value / 100));
}
function saveSheet(value: number) {
  try {
    localStorage.setItem("coucou.window.sheet", String(value));
  } catch {
    /* this session only */
  }
}
applySheet();

let dir = "";
let files: TeamFile[] = [];
/** The agents of Settings → Agents: what a member can run as. */
let agents: AgentProfile[] = [];
/** The latest snapshot of each team, by team id. */
const runs = new Map<string, Snapshot>();
/** The team file being looked at, and which of its screens. */
let selected: string | null = null;
let tab: "setup" | "links" | "monitor" | "log" = "setup";
/** 檢查代理 results, while the setup tab shows them. */
let doctor: import("../core/state").AgentCheck[] | "running" | string | null = null;
/** The little gear beside 秘書 or 公司總覽: which panel is open, and where. */
let sidePop: { which: "secretary" | "company"; top: number } | null = null;
/** The monitor as a board, or as the team's office. */
let monitorMode: "board" | "office" = "board";
/** The company map instead of one team; or the office of a team that has no file here (示範資料). */
let place: "team" | "company" | "office" | "cost" | "secretary" | "law" | "agents" = "team";
let officeTeam: string | null = null;
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
/** Each agent's own folder (agent id, path); asked once. */
let agentFolders: [string, string][] | null = null;
/** Members whose 進階設定 is open, by id. */
const advancedOpen = new Set<string>();
/** The members panel's help, opened by its ? button. */
let memberHelp = false;
/** The sidebar's 已封存 section, open or not. */
let showArchived = import.meta.env.DEV && typeof location !== "undefined" && new URLSearchParams(location.search).get("archived") === "open";
const ICON_COPY = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>';
const ICON_ARCHIVE = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13h4"/></svg>';
const ICON_UNARCHIVE = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M12 18v-6M9.5 14.5 12 12l2.5 2.5"/></svg>';
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

/** A team's state in words: one the person ended reads as such, not as done. */
function teamStatus(snap: Snapshot): string {
  return snap.status === "finished" && snap.ended ? "已結束" : TEAM_STATUS[snap.status];
}

/** The team whose 結束團隊 has been pressed once, and until when it waits for the second press. */
let ending: { team: string; until: number } | null = null;

/** 結束團隊: pressed twice, since what is under way is cut short. */
function endButton(snap: Snapshot): HTMLElement {
  const armed = ending?.team === snap.id && ending.until > Date.now();
  return h(
    "button",
    {
      class: `btn ${armed ? "danger" : "plain"} end-team`,
      type: "button",
      title: "結束這個團隊:正在做的這一輪會被打斷,所有成員的代理都會停掉,未完成的任務就停在現在的樣子。做好的檔案都留著;之後再傳指示,團隊會重新開工。",
      onClick: () => {
        if (!armed) {
          ending = { team: snap.id, until: Date.now() + 5000 };
          render();
          window.setTimeout(() => {
            if (ending?.team === snap.id && ending.until <= Date.now()) {
              ending = null;
              render();
            }
          }, 5100);
          return;
        }
        ending = null;
        void act(() => Bridge.teamEnd(snap.id));
      },
    },
    armed ? "確定結束?再按一次" : "結束團隊",
  );
}

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
    [/^Ended by the user\.$/, () => "由你結束,未完成的任務停在原處"],
    [/^(.+) reached its limit: (.+?)\.( Raise the limit in the team's setup and save, then resume\.)?$/, (m) => `${m[1]} 已達用量上限(${m[2]}),團隊先暫停。${m[3] ? "請先到團隊設定提高上限並儲存,再按繼續。" : "到團隊設定提高上限並儲存後,可以按繼續。"}`],
    [/^The team has used its (\d+) turns\.$/, (m) => `已用完 ${m[1]} 回合的上限`],
    [/^(TASK-\d+) was sent back (\d+) times\.$/, (m) => `${m[1]} 已被退回 ${m[2]} 次`],
    [/^Coucou was closed while the team was running\.$/, () => "團隊執行中時 Coucou 被關閉"],
    [/^interrupted$/, () => "被中斷"],
    // Why a team cannot start.
    [/^The work folder (.+) does not exist\.$/, (m) => `工作資料夾 ${m[1]} 不存在`],
    [/^The work folder must be a full path\.$/, () => "還沒有選擇工作資料夾"],
    [/^(.+) runs as agent '(.*)', which is not in Settings → Agents( or Teamwork → Agent 設定)?\.$/, (m) => `${m[1]} 還沒有選擇代理${m[2] ? `(「${m[2]}」不在 設定 → Agents 或 Agent 設定 裡)` : ""}`],
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
  place = "team";
  trouble = "";
  const picked = files.find((f) => f.file === file);
  editing = picked?.config ? structuredClone(picked.config) : null;
  unsaved = false;
  const run = picked?.config ? runs.get(picked.config.id) : undefined;
  tab = run && run.status !== "idle" ? "monitor" : "setup";
}

function sidebar(): HTMLElement {
  const list = h("div", { class: "team-list" });
  const row = (file: TeamFile, away: boolean): HTMLElement => {
    const run = file.config ? runs.get(file.config.id) : undefined;
    const busy = !!run && run.status !== "finished" && !run.detached;
    const state = run ? teamStatus(run) : file.problems.length ? "尚未設定完成" : "可以啟動";
    const needsYou = run?.members.some((m) => m.status === "waitingYou" || m.status === "lost") ?? false;
    return (
      h(
        "div",
        { class: `team-row${file.file === selected && place === "team" ? " on" : ""}${away ? " away" : ""}` },
        h(
          "button",
          {
            class: `team-item${file.file === selected && place === "team" ? " on" : ""}`,
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
          // Putting away keeps the file: the team leaves the list and the company map, nothing is lost.
          h("button", {
            class: "icon-btn",
            type: "button",
            title: away ? "取消封存:放回團隊清單和公司總覽" : busy ? "團隊執行中,先停下才能封存" : "封存(不刪除):不再顯示在團隊清單和公司總覽,可以在「已封存」找回",
            "aria-label": away ? "取消封存" : "封存這個團隊",
            disabled: !away && busy,
            html: away ? ICON_UNARCHIVE : ICON_ARCHIVE,
            onClick: () =>
              void act(async () => {
                await Bridge.teamArchive(file.file, !away);
                await load();
              }),
          }),
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
                title: busy ? "團隊執行中,先停下才能刪除" : "刪除這個團隊",
                "aria-label": "刪除這個團隊",
                disabled: busy,
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
      )
    );
  };
  const inUse = files.filter((f) => !f.config?.archived);
  const away = files.filter((f) => f.config?.archived);
  for (const file of inUse) list.append(row(file, false));
  if (!inUse.length) list.append(h("p", { class: "hint", text: away.length ? "團隊都已封存。" : "還沒有團隊。" }));
  // Teams put away: a quiet section at the end of the list, closed until asked for.
  if (away.length) {
    list.append(
      h(
        "button",
        { class: `archive-toggle${showArchived ? " on" : ""}`, type: "button", "aria-expanded": String(showArchived), onClick: () => ((showArchived = !showArchived), render()) },
        h("span", { html: ICON_ARCHIVE }),
        `已封存 ${away.length}`,
        h("i", { "aria-hidden": "true", text: showArchived ? "▾" : "▸" }),
      ),
    );
    if (showArchived) for (const file of away) list.append(row(file, true));
  }

  // A small gear on the row: the panel beside it holds the quieter settings.
  const gear = (which: "secretary" | "company", label: string) =>
    h("span", {
      class: "team-gear", role: "button", tabindex: "0", title: label, "aria-label": label,
      html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>',
      onClick: (e: Event) => {
        e.stopPropagation();
        const at = (e.currentTarget as HTMLElement).getBoundingClientRect();
        sidePop = sidePop?.which === which ? null : { which, top: Math.min(at.top, window.innerHeight - 280) };
        render();
      },
    });
  const pop = !sidePop
    ? null
    : h(
        "div",
        { class: "side-pop", role: "dialog", "aria-label": sidePop.which === "secretary" ? "秘書設定" : "公司設定", style: `top:${sidePop.top}px` },
        h("div", { class: "side-pop-head" },
          h("b", { text: sidePop.which === "secretary" ? "秘書設定" : "公司設定" }),
          h("button", { class: "side-pop-close", type: "button", "aria-label": "關閉", onClick: () => { sidePop = null; render(); } }, "✕")),
        sidePop.which === "secretary"
          ? h("div", { class: "side-pop-body" },
              h("label", { text: "秘書名稱" }),
              h("input", {
                value: secretaryName(), placeholder: "秘書",
                onChange: (e: Event) => { setSecretaryName((e.target as HTMLInputElement).value); render(); },
              }),
              h("p", { class: "hint", text: "想叫它什麼都可以;改完馬上生效。" }),
              h("label", { text: "開團隊使用的 Agent" }),
              sourceSwitch(() => render()),
              h("p", { class: "hint" }, agentSource() === "team"
                ? "秘書開團隊、你新增團隊成員時,只從 "
                : "秘書開團隊、你新增團隊成員時,用 設定 → Agents 的原生 Agent。切到「團隊定義的 Agent」就只從 ",
                h("button", { class: "link", type: "button", onClick: () => { sidePop = null; place = "agents"; render(); } }, "Agent 設定"),
                " 裡挑,秘書會照每個 Agent 的說明選人。已經設定好的團隊照舊能啟動。"))
          : h("div", { class: "side-pop-body" },
              h("label", { text: "公司名稱" }),
              h("input", {
                value: companyName(), placeholder: "我的公司",
                onChange: (e: Event) => { setCompanyName((e.target as HTMLInputElement).value); render(); },
              }),
              h("label", { text: "戰鬥動畫流暢度(中二模式)" }),
              h("div", { class: "segmented" },
                ...[20, 30, 60].map((n) =>
                  h("button", {
                    type: "button", class: office.companyFps === n ? "on" : "",
                    onClick: () => { office.companyFps = n; saveCompanyFps(n); render(); },
                  }, `${n} FPS`))),
              h("p", { class: "hint", text: "公司總覽裡每間辦公室戰鬥動畫的更新頻率。團隊多的時候調低比較省效能,只有一兩個團隊時可以調高。" }),
              h("label", { text: "玻璃濃度" }),
              (() => {
                const shown = h("b", { class: "sheet-value", text: `${sheet()}%` });
                const slider = h("input", {
                  type: "range", min: "0", max: "100", step: "1", value: String(sheet()), class: "sheet-slider",
                  "aria-label": "玻璃濃度",
                  // Dragging previews at once — the window itself is the preview.
                  onInput: (e: Event) => {
                    const v = Number((e.target as HTMLInputElement).value);
                    applySheet(v);
                    shown.textContent = `${v}%`;
                  },
                  onChange: (e: Event) => saveSheet(Number((e.target as HTMLInputElement).value)),
                }) as HTMLInputElement;
                const preset = (label: string, v: number) =>
                  h("button", { type: "button", onClick: () => { slider.value = String(v); applySheet(v); saveSheet(v); shown.textContent = `${v}%`; } }, label);
                return h("div", { class: "sheet-row" },
                  h("div", { class: "sheet-line" }, slider, shown),
                  h("div", { class: "segmented" }, preset("玻璃", SHEET_DEFAULT), preset("加深", 80), preset("不透明", 100)));
              })(),
              h("p", { class: "hint", text: "越低,模糊的桌面透出越多;越高越接近實色。模糊本身的強度由 Windows 決定,無法調整。拖動時視窗會即時變化。" }),
              h("label", { text: "戰鬥節奏(中二模式)" }),
              h("div", { class: "segmented" },
                ...([["calm", "平靜"], ["normal", "一般"], ["fierce", "激烈"]] as [Tempo, string][]).map(([v, label]) =>
                  h("button", { type: "button", class: battleTempo() === v ? "on" : "", onClick: () => { saveBattleTempo(v); render(); } }, label))),
              h("p", { class: "hint", text: "AI 在工作時,英雄多久出手試探一次、魔王多常反擊。只是演出:不扣血、不出卡片,HP 只看真實的任務驗收。" }),
              h("label", { class: "side-pop-check" },
                h("input", { type: "checkbox", checked: ambientMotion(), onChange: (e: Event) => { saveAmbientMotion((e.target as HTMLInputElement).checked); render(); } }),
                "場地微動(中二模式)"),
              h("p", { class: "hint", text: "戰場上的餘燼、雪花、落葉、電花、星塵。只是氣氛,減少動態時一律停止。" })),
      );
  return h(
    "aside",
    { class: "sidebar pane" },
    h("div", { class: "brand", "data-drag": "" }, teamMark(30), h("span", { text: "Teamwork" })),
    pop,
    h(
      "button",
      {
        class: `team-item company${place === "secretary" ? " on" : ""}`,
        type: "button",
        onClick: () => {
          place = "secretary";
          render();
        },
      },
      h("span", { class: "team-item-name", text: secretaryName() }),
      h("span", { class: "team-item-state", text: "需要時叫我:查現況、開團隊" }),
      gear("secretary", "秘書設定"),
    ),
    h(
      "button",
      {
        class: `team-item company${place === "company" ? " on" : ""}`,
        type: "button",
        onClick: () => {
          place = "company";
          render();
        },
      },
      h("span", { class: "team-item-name", text: "公司總覽" }),
      h("span", { class: "team-item-state", text: office.demo ? "示範資料" : "所有團隊的辦公室" }),
      gear("company", "公司設定"),
    ),
    h(
      "button",
      {
        class: `team-item company${place === "cost" ? " on" : ""}`,
        type: "button",
        onClick: () => {
          place = "cost";
          render();
        },
      },
      h("span", { class: "team-item-name", text: "成本與用量" }),
      h("span", { class: "team-item-state", text: "Token 用量與預估費用" }),
    ),
    h(
      "button",
      {
        class: `team-item company${place === "law" ? " on" : ""}`,
        type: "button",
        onClick: () => {
          place = "law";
          render();
        },
      },
      h("span", { class: "team-item-name", text: "憲法" }),
      h("span", { class: "team-item-state", text: "所有成員都要遵守的規則" }),
    ),
    h(
      "button",
      {
        class: `team-item company${place === "agents" ? " on" : ""}`,
        type: "button",
        onClick: () => {
          place = "agents";
          render();
        },
      },
      h("span", { class: "team-item-name", text: "Agent 設定" }),
      h("span", { class: "team-item-state", text: agentSource() === "team" ? "團隊 Agent · 使用中" : "團隊專用的 Agent" }),
    ),
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

/**
 * Folders besides the work folder where safe steps also go without asking:
 * each member's own agent folder, and any the person adds. Nothing is
 * trusted until it is chosen here.
 */
function trustedFolders(config: TeamConfig): HTMLElement {
  if (agentFolders === null) {
    agentFolders = [];
    void (async () => {
      agentFolders = IS_TAURI
        ? ((await Bridge.teamAgentFolders()) ?? [])
        : [["copilot", "C:\\Users\\you\\.copilot\\session-state"], ["cg", "C:\\Users\\you\\.copilot\\session-state"], ["codex", "C:\\Users\\you\\.codex\\generated_images"], ["agy", "C:\\Users\\you\\.gemini\\antigravity\\brain"]];
      render();
    })();
  }
  const used = new Set(config.members.map((m) => m.agent));
  // One line a folder, with every agent of the team that keeps its files there.
  const byPath = new Map<string, string[]>();
  for (const [agent, path] of agentFolders ?? []) {
    if (used.has(agent)) byPath.set(path, [...(byPath.get(path) ?? []), allAgents().find((a) => a.id === agent)?.name ?? agent]);
  }
  const own = [...byPath.entries()].map(([path, who]) => [path, who.join("、")] as const);
  const dirs = config.trustedDirs ?? [];
  const toggle = h("input", { type: "checkbox", checked: !!config.agentFolders, disabled: !own.length }) as HTMLInputElement;
  toggle.addEventListener("change", () => {
    config.agentFolders = toggle.checked || undefined;
    unsaved = true;
    render();
  });
  return h(
    "div",
    { class: "trusted" },
    h("label", { text: "也可以自動批准的資料夾" }),
    h(
      "label",
      { class: "trusted-check" },
      toggle,
      h(
        "span",
        {},
        h("b", { text: "代理自己的暫存資料夾" }),
        own.length
          ? h("span", { class: "trusted-paths" }, ...own.map(([path, who]) => h("span", {}, h("span", { class: "mono", text: path }), h("small", { text: ` · ${who}` }))))
          : h("span", { class: "hint", text: "這個團隊用到的代理沒有已知的暫存資料夾。" }),
      ),
    ),
    ...dirs.map((d, i) =>
      h(
        "div",
        { class: "trusted-dir" },
        h("span", { class: "mono", text: d }),
        h(
          "button",
          {
            class: "link",
            type: "button",
            onClick: () => {
              config.trustedDirs = dirs.filter((_, k) => k !== i);
              if (!config.trustedDirs.length) config.trustedDirs = undefined;
              unsaved = true;
              render();
            },
          },
          "移除",
        ),
      ),
    ),
    h(
      "div",
      { class: "row" },
      button("新增資料夾…", "plain", () =>
        void act(async () => {
          const picked = await Bridge.pickFolder(config.workDir, "選擇也可以自動批准的資料夾");
          if (picked && !dirs.some((d) => d.toLowerCase() === picked.toLowerCase())) {
            config.trustedDirs = [...dirs, picked];
            unsaved = true;
          }
        }),
      ),
    ),
    h("p", { class: "hint", text: "預設都不勾。勾選或加入的資料夾,會和工作資料夾一樣:改檔、建置不會問你;刪資料夾、安裝、對外發送仍然會問。改了以後,團隊下次啟動時生效。" }),
  );
}

/** What each field of a member means, for whoever sets a team up the first time. */
function memberHelpCard(): HTMLElement {
  const item = (term: string, text: string, example = "") =>
    h("div", { class: "help-item" }, h("dt", { text: term }), h("dd", {}, text, example ? h("span", { class: "help-eg", text: `例:${example}` }) : null));
  return h(
    "div",
    { class: "member-help", id: "member-help", role: "note" },
    h(
      "dl",
      {},
      item("名稱", "畫面上和隊友之間稱呼這位成員的名字。", "AI 1、設計師"),
      item("角色", "2～6 個字的職稱。全隊都看得到,Leader 依它決定任務派給誰;工位和 Office 的標籤也顯示它。", "網站開發、圖片生成、測試"),
      item("代理", "這位成員用哪個 AI 工具工作。每位成員可以用不同的代理;要新增或修改代理,到「設定 → Agents」。"),
      item("模型", "留空就用代理自己的預設模型。也可以指定一個:點這一欄會列出這個代理提供的模型。"),
      item("職責", "一兩句只寫給這位成員的工作說明:負責什麼、交付什麼、不碰什麼。隊友看不到;空著也可以,它就只依角色和 Leader 派的任務做事。", "依需求產生商品圖,存到 public/images 交給網站開發;不改程式碼"),
      item("Leader", "每個團隊一位。負責把目標拆成任務、派給隊友、驗收成果,最後向你回報。建議交給能力較強的代理或模型。"),
      item("移除", "至少要留一位成員。團隊已經在執行時,要加人請到「工作監控」按「＋ 加人手」。"),
    ),
    h("p", { class: "hint", text: "成員之間誰把成果交給誰、能不能直接對話,在「協作關係」設定。" }),
  );
}

/**
 * A member's 進階設定: limits on what it may use in a run. Empty is no
 * limit (the default); past a limit the team pauses and the member's turn
 * is stopped, until the limit is raised (it holds at once, even mid-run).
 */
function advanced(config: TeamConfig, m: TeamConfig["members"][number], at: number): HTMLElement {
  const isOpen = advancedOpen.has(m.id);
  const limits = [m.maxTokens ? `${fmtTokens(m.maxTokens)} tokens` : "", m.maxCostUsd ? `$${m.maxCostUsd}` : ""].filter(Boolean);
  const toggle = h(
    "button",
    { class: "link member-adv-toggle", type: "button", "aria-expanded": String(isOpen), onClick: () => (isOpen ? advancedOpen.delete(m.id) : advancedOpen.add(m.id), render()) },
    `${isOpen ? "▾" : "▸"} 進階設定`,
    limits.length ? h("span", { class: "chip", text: `上限 ${limits.join(" · ")}` }) : null,
  );
  if (!isOpen) return toggle;
  const number = (key: string, value: number | undefined, set: (v: number | undefined) => void, attrs: Record<string, string>) =>
    bound("input", `m${at}.${key}`, value ? String(value) : "", (v) => set(Number(v) > 0 ? Number(v) : undefined), { type: "number", min: "0", class: "field narrow member-limit", ...attrs });
  const used = runs.get(config.id)?.members.find((x) => x.id === m.id)?.usage ?? [];
  const now = used.length ? usageSummary(used, () => render()) : null;
  return h(
    "div",
    { class: "member-adv" },
    toggle,
    h(
      "div",
      { class: "member-adv-body" },
      h("label", { text: "這一輪最多用" }),
      h("div", { class: "row nowrap" }, number("maxTokens", m.maxTokens, (v) => (m.maxTokens = v), { placeholder: "不限制", step: "100000" }), h("span", { class: "hint", text: "tokens(含快取)" })),
      h("label", { text: "費用上限" }),
      h("div", { class: "row nowrap" }, h("span", { class: "hint", text: "US$" }), number("maxCostUsd", m.maxCostUsd, (v) => (m.maxCostUsd = v), { placeholder: "不限制", step: "0.5" }), h("span", { class: "hint", text: "依「成本與用量」的價格表估算" })),
      now ? h("p", { class: "hint", text: `這一輪目前已用 ${fmtTokens(now.tokens)} tokens${now.usd != null ? ` · ${fmtMoney(now.usd)}` : ""}。` }) : null,
      h("p", { class: "hint", text: "留空就不限制(預設)。到達上限時,團隊會先暫停並中斷這位成員正在做的這一輪;提高上限並儲存後就生效(執行中也是),再按「繼續」。" }),
    ),
  );
}

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
  // New members take their agent from where the secretary's switch says.
  const first = agentSource() === "team" ? teamProfiles(agents)[0] : agents[0];
  config.members.push({ id, name: `AI ${id.slice(2)}`, role: "", duty: "", agent: first?.id ?? "", color: "" });
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
    config.autoApprove ? trustedFolders(config) : null,
    h("label", { text: "辦公室風格" }),
    h(
      "div",
      { class: "segmented wrap" },
      ...[["", "自動"], ...Object.entries(THEME_LABELS)].map(([key, label]) =>
        h("button", { type: "button", class: (config.officeTheme ?? "") === key ? "on" : "", onClick: () => ((config.officeTheme = key || undefined), (unsaved = true), render()) }, label),
      ),
    ),
    h("p", { class: "hint", text: `Office 檢視裡這個團隊的辦公室長什麼樣子。自動:${LARGE_FROM} 位成員以上用高級辦公室(在公司總覽佔較大的格子),其他依團隊固定挑一種。` }),
    h("label", { text: "中二模式戰場" }),
    h(
      "div",
      { class: "segmented wrap" },
      ...WORLD_IDS.map((id) =>
        h("button", { type: "button", class: savedWorld(config.id) === id ? "on" : "", title: WORLDS[id].label, onClick: () => { saveWorld(config.id, id); office.worldChanged(config.id); } }, WORLDS[id].label),
      ),
    ),
    h("p", { class: "hint", text: "中二模式下這個團隊在哪個場地討伐哪隻魔王。只改變畫面,不影響工作、任務或 HP;改了馬上生效,不用儲存。" }),
    h("label", { text: "回合上限" }),
    h("div", { class: "row nowrap" }, bound("input", "maxTurns", String(config.maxTurns), (v) => (config.maxTurns = Math.max(1, Math.min(500, Number(v) || 60))), { type: "number", min: "1", max: "500", class: "field narrow" }), h("span", { class: "hint", text: "整個團隊用完這麼多回合後會暫停,等你決定要不要繼續。" })),
  );

  // ── Right: who is in it ──
  const members = h("div", { class: "member-rows" });
  config.members.forEach((m, at) => {
    const kindOf = (a: AgentProfile) => (a.protocol === "codex" ? "Codex" : a.protocol === "claude" ? "Claude Code" : a.protocol === "agy" ? "Antigravity" : a.command);
    // The switch (秘書設定 / Agent 設定) says which agents a member is chosen from.
    const teamMode = agentSource() === "team";
    const hintOf = (a: AgentProfile) => {
      const own = teamAgents().find((t) => t.id === a.id);
      if (own) return `團隊 Agent · 基底 ${agents.find((n) => n.id === own.base)?.name ?? own.base}`;
      return kindOf(a) !== a.name ? kindOf(a) : undefined;
    };
    const pool = teamMode ? teamProfiles(agents) : agents;
    const agentChoices = pool.map((a) => ({ value: a.id, label: a.name, hint: hintOf(a) }));
    if (m.agent && !pool.some((a) => a.id === m.agent)) {
      // Set up before the switch moved: still runs, still shown.
      const other = allAgents().find((a) => a.id === m.agent);
      agentChoices.unshift(
        other
          ? { value: m.agent, label: other.name, hint: teamMode ? "原生 Agent(既有設定,照樣能啟動)" : "團隊 Agent(既有設定,照樣能啟動)" }
          : { value: m.agent, label: `${m.agent}(不存在)`, hint: "不在 設定 → Agents 或 Agent 設定 裡" },
      );
    }
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
    const profile = allAgents().find((a) => a.id === m.agent);
    // A team agent offers its base's models: asked of the base, with the base's key.
    const lister = baseOf(m.agent, agents);
    const known = lister ? modelLists.get(lister.id) : undefined;
    const model = bound("input", `m${at}.model`, m.model ?? "", (v) => (m.model = v.trim()), {
      placeholder: profile?.model ? `模型:${profile.model}(代理預設)` : "模型:代理預設",
      title: typeof known === "string" ? known : "留空就用代理自己的預設模型",
      autocomplete: "off",
    });
    suggest(model, () => {
      const got = lister ? modelLists.get(lister.id) : "這個代理不在 設定 → Agents 裡";
      if (got === undefined) return "讀取這個代理提供的模型…";
      return Array.isArray(got) ? got.map((c) => ({ value: c.id, label: c.id, hint: c.label !== c.id ? c.label : undefined })) : got;
    });
    // The list is asked for the first time the field is used: a handshake
    // with the agent, nothing spent.
    model.addEventListener("focus", () => {
      if (!lister || modelLists.has(lister.id)) return;
      modelLists.set(lister.id, "載入中…");
      Bridge.agentModels(lister)
        .then((found) => modelLists.set(lister.id, found))
        .catch((err) => modelLists.set(lister.id, String(err).replace(/^Error:\s*/, "")))
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
            bound("input", `m${at}.role`, m.role, (v) => (m.role = v), { placeholder: "角色,例如:網站開發", title: "全隊看得到的短職稱,Leader 依它派工" }),
            agent,
          ),
          h("div", { class: "row nowrap" }, model),
          bound("input", `m${at}.duty`, m.duty, (v) => (m.duty = v), { placeholder: "職責:這位成員負責什麼、交付什麼(只給它自己看)", title: "只寫給這位成員的工作說明" }),
          advanced(config, m, at),
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
    h(
      "div",
      { class: "panel-head" },
      h("h2", {}, "團隊成員", h("span", { class: "count", text: String(config.members.length) })),
      h(
        "button",
        {
          type: "button",
          class: `help-toggle${memberHelp ? " on" : ""}`,
          "aria-expanded": String(memberHelp),
          "aria-controls": "member-help",
          title: memberHelp ? "收起說明" : "每一欄怎麼填",
          onClick: () => {
            memberHelp = !memberHelp;
            render();
          },
        },
        h("b", { "aria-hidden": "true", text: "?" }),
        memberHelp ? "收起說明" : "怎麼填",
      ),
    ),
    memberHelp ? memberHelpCard() : null,
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
      ? h("p", { class: "hint" }, "代理在 ", h("button", { class: "link", type: "button", onClick: () => void Bridge.openSettingsWindow() }, "設定 → Agents"), " 裡新增與修改", agentSource() === "team" ? h("span", {}, ";現在只列 ", h("button", { class: "link", type: "button", onClick: () => { place = "agents"; render(); } }, "Agent 設定"), " 裡的團隊 Agent") : null, "。 ",
          h("button", { class: "link", type: "button", disabled: doctor === "running", title: "逐一確認每個代理的 CLI 找不找得到、能不能回答版本;找得到就等於重新定位成功", onClick: () => {
            doctor = "running";
            render();
            Bridge.agentsDoctor(agents).then((r) => { doctor = r; render(); }, (e) => { doctor = String(e); render(); });
          } }, doctor === "running" ? "檢查中…" : "檢查代理"))
      : h("p", { class: "problem" }, "還沒有任何代理。請先到 ", h("button", { class: "link", type: "button", onClick: () => void Bridge.openSettingsWindow() }, "設定 → Agents"), " 建立。"),
    Array.isArray(doctor)
      ? h("div", { class: "agent-doctor" }, ...doctor.map((c) =>
          h("p", { class: c.error ? "problem" : "hint" },
            h("b", { text: c.name }), " ",
            c.error ? `✕ ${c.error}` : `✓ ${c.version || "有回應"} · ${c.found ?? ""} · ${c.tookMs} ms`)))
      : typeof doctor === "string" && doctor !== "running"
        ? h("p", { class: "problem", text: `檢查代理失敗:${doctor}` })
        : null,
  );

  const stops = unsaved ? [] : file.problems;
  return h(
    "div",
    { class: "setup" },
    h(
      "div",
      { class: "setup-grid" },
      h("div", { class: "setup-col" }, goal, knowledgePanel(config.id, config.members.find((m) => m.id === config.leader)?.name ?? "", running, knowledgeHost)),
      team,
    ),
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
  // Planning and reviewing are kinds of work, said as such.
  const status = m.phase ? { ...STATUS[m.status], label: m.phase === "planning" ? "規劃中" : "審核中" } : STATUS[m.status];
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

  // The things that wait for the person, answered right on the card.
  el.append(...asks(snap, m));
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
      otherModel(m),
      spend(m.usage, `${m.name} 這一輪用掉的 token`),
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
      h("span", { class: "chip agent", title: `使用的代理與模型 · 已進行的回合數\n${agentLabel(m.agent)}${m.model ? ` · ${m.model}` : ""} · ${m.turns} 回合`, text: `${agentLabel(m.agent)}${m.model ? ` · ${m.model}` : ""} · ${m.turns} 回合` }),
    ),
  );
  return el;
}

/**
 * What a member waits on the person for — a permission card, a question —
 * answered right there: on its desk, in the Office's drawer, on the company map.
 */
function asks(snap: Snapshot, m: MemberView): HTMLElement[] {
  const out: HTMLElement[] = [];
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
    out.push(
      h(
        "div",
        { class: "ask" },
        h("div", { class: "ask-why", text: p.rule ? `憲法要你批准:${p.rule}` : p.danger ? `要你批准:${DANGER[p.danger]}` : "要你批准" }),
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
    out.push(
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
  return out;
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
  ended: "由你結束",
  joined: "加入團隊",
  reopened: "再次開工",
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
        // The pictures it is about: named in the words, or handed in for its task.
        item.kind === "task" ? null : thumbsFor(snap.id, item.text, ...(item.task && /delivered|accepted|rejected/.test(item.kind) ? snap.deliverables.filter((d) => d.task === item.task).slice(-1).map((d) => d.locator) : [])),
      ),
    );
  }
  if (!items.length) list.append(h("p", { class: "dim", text: "還沒有任何協作紀錄。" }));
  return h("section", { class: "panel feed-panel" }, h("h2", { text: "最新協作" }), list);
}

function deliverables(snap: Snapshot): HTMLElement {
  const row = h("div", { class: "deliverables" });
  const icon = (d: Deliverable) => (d.locator.startsWith("http") ? "↗" : /image|圖/.test(d.kind) ? "▣" : /source|code|原始/.test(d.kind) ? "</>" : "▤");
  const pictures = [...snap.deliverables].reverse().map((d) => d.locator).filter(isImage);
  for (const d of [...snap.deliverables].reverse()) {
    const task = snap.tasks.find((t) => t.id === d.task);
    const picture = isImage(d.locator);
    row.append(
      h(
        "button",
        {
          class: `deliverable${picture ? " picture" : ""}`,
          type: "button",
          title: picture ? `看 ${d.locator}` : `開啟 ${d.locator}`,
          // A picture opens large in the window; anything else in Explorer.
          onClick: () => (picture ? openImage(snap.id, pictures, pictures.indexOf(d.locator)) : void act(() => Bridge.teamOpen(snap.id, d.locator))),
        },
        h("span", { class: "deliverable-icon", text: icon(d) }, picture ? thumbImg(snap.id, d.locator) : null),
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
  // A finished team is not closed: new words start it again, the leader first.
  const hint = snap.status === "finished" && snap.ended
    ? "團隊已由你結束。要接著做,寫在這裡送出,Leader 會從現在的進度繼續,團隊會重新開工"
    : snap.status === "finished"
    ? "團隊已完成。對成果不滿意或有新需求,寫在這裡送出,Leader 會接著處理,團隊會繼續工作"
    : "傳送新指示…可貼上、拖進或附上圖片(對方這一輪結束後才會讀到)";
  const input = field(`instruct:${snap.id}`, hint, (t) => send(t));
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
  // The board and the Office read progress from the same calculation.
  const shared = office.main.progress(snap.id);
  const percent = shared.percent ?? 0;
  const minutes = Math.max(0, Math.floor(((snap.finishedAt || Date.now()) - snap.startedAt) / 60_000));

  return h(
    "div",
    { class: "monitor" },
    h(
      "div",
      { class: "progress" },
      h("span", { class: "progress-label", text: "整體進度" }),
      h("span", { class: "progress-number", text: shared.percent === null ? "尚未派工" : `${percent}%` }),
      h("div", { class: "meter", role: "progressbar", "aria-valuenow": percent, "aria-valuemin": 0, "aria-valuemax": 100 }, h("i", { style: `width:${percent}%` })),
      h("span", { class: "dim", text: `已驗收 ${snap.done} / ${snap.total} 項任務` }),
      h("span", { class: "dim", text: `${snap.totalTurns} / ${snap.maxTurns} 回合` }),
      h("span", { class: "dim", text: `已執行 ${minutes} 分鐘` }),
      spend(snap.members.flatMap((m) => m.usage ?? []), "全隊這一輪用掉的 token"),
    ),
    stage(snap),
    h("div", { class: "split" }, board(snap), feed(snap)),
    deliverables(snap),
    composer(snap),
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
      endButton(snap),
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
    actions.append(endButton(snap));
  }
  return h(
    "header",
    { class: "top", "data-drag": "" },
    h(
      "div",
      { class: "top-title", "data-drag": "" },
      h("h1", { "data-drag": "" }, name, snap ? h("span", { class: `state ${snap.status}${snap.ended ? " ended" : ""}`, text: teamStatus(snap) }) : null),
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
    item("工作監控", "monitor", true, ""),
    item("溝通紀錄", "log", !!snap, snap ? "" : "啟動後"),
    tab === "monitor"
      ? h(
          "div",
          { class: "office-switch", role: "group", "aria-label": "看板或辦公室" },
          h("button", { class: monitorMode === "board" ? "on" : "", type: "button", "aria-pressed": String(monitorMode === "board"), disabled: !snap, title: snap ? "" : "團隊啟動後才有看板", onClick: () => { monitorMode = "board"; render(); } }, "看板"),
          h("button", { class: monitorMode === "office" ? "on" : "", type: "button", "aria-pressed": String(monitorMode === "office"), onClick: () => { monitorMode = "office"; render(); } }, "Office"),
        )
      : null,
  );
}

function main(): HTMLElement {
  if (place === "agents") {
    return h(
      "main",
      { class: "main pane" },
      h("header", { class: "top", "data-drag": "" }, h("nav", { class: "crumbs", "data-drag": "", "aria-label": "位置" }, h("b", { text: "Agent 設定" })), windowButtons()),
      h("div", { class: "scroll" }, agentsPage(agentsHost)),
    );
  }
  if (place === "law") {
    return h(
      "main",
      { class: "main pane" },
      h("header", { class: "top", "data-drag": "" }, h("nav", { class: "crumbs", "data-drag": "", "aria-label": "位置" }, h("b", { text: "憲法" })), windowButtons()),
      h("div", { class: "scroll" }, constitutionPage({ render: () => render() })),
    );
  }
  if (place === "secretary") {
    return h(
      "main",
      { class: "main pane" },
      h("header", { class: "top", "data-drag": "" }, h("nav", { class: "crumbs", "data-drag": "", "aria-label": "位置" }, secretaryTitle(secretaryHost)), windowButtons()),
      secretaryPage(secretaryHost),
    );
  }
  if (place === "cost") {
    return h(
      "main",
      { class: "main pane" },
      h("header", { class: "top", "data-drag": "" }, h("nav", { class: "crumbs", "data-drag": "", "aria-label": "位置" }, h("b", { text: "成本與用量" })), windowButtons()),
      h("div", { class: "scroll" }, costPage(costHost)),
    );
  }
  if (place === "company" || (place === "office" && officeTeam)) {
    const team = place === "office" ? office.store.team(officeTeam!) : undefined;
    return h(
      "main",
      { class: "main pane" },
      h(
        "header",
        { class: "top", "data-drag": "" },
        h(
          "nav",
          { class: "crumbs", "data-drag": "", "aria-label": "位置" },
          place === "office"
            ? h("button", { class: "link", type: "button", onClick: () => { place = "company"; render(); } }, "公司總覽")
            : h("b", { text: "公司總覽" }),
          team ? h("span", { class: "dim", text: ` › ${team.name}` }) : null,
        ),
        windowButtons(),
      ),
      h("div", { class: "scroll" }, place === "office" ? office.team(officeTeam!) : office.company()),
    );
  }
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
    tab === "monitor" && (monitorMode === "office" || !snap) && file.config ? office.team(file.config.id)
    : tab === "monitor" && snap ? monitor(snap)
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

/** The secretary's page: it may add a team, and point at one. */
const secretaryHost: SecretaryHost = {
  render: () => render(),
  reload: () => load(),
  openTeam: (id) => {
    const file = files.find((f) => f.config?.id === id);
    if (file) {
      select(file.file);
      render();
    }
  },
};

/** A team's 知識庫 panel, in its setup. */
const knowledgeHost: KnowledgeHost = { render: () => render() };

/** The Agent 設定 page: team agents built on Settings → Agents. */
const agentsHost: AgentsHost = {
  render: () => render(),
  natives: () => agents,
  usedBy: (id) => files.filter((f) => f.config?.members.some((m) => m.agent === id)).map((f) => f.config!.name || f.file),
  openSettings: () => void Bridge.openSettingsWindow(),
};

/** Every agent a member may name, for names and default models: native and team. */
function allAgents(): AgentProfile[] {
  return [...agents, ...teamProfiles(agents).filter((t) => !agents.some((a) => a.id === t.id))];
}

/** The 成本與用量 page draws inside this window, with its agents' names. */
const costHost: CostHost = {
  render: () => render(),
  agents: () => allAgents(),
  openSecretary: () => {
    place = "secretary";
    render();
  },
};

/** The model a member was given, when the calls it made used another (as the meter saw them). */
function otherModel(m: MemberView): HTMLElement | null {
  // An alias ("sonnet") or an effort suffix ("-high") still names the same model.
  const norm = (x: string) => x.toLowerCase().replace(/\[.*\]$/, "").replace(/\./g, "-").trim();
  const same = (a: string, b: string) => norm(a).includes(norm(b)) || norm(b).includes(norm(a));
  const ran = (m.usage ?? []).map((u) => u.model).filter(Boolean);
  if (!m.model || !ran.length || ran.some((r) => same(r, m.model))) return null;
  return h("span", { class: "chip warn", title: `指定的模型是 ${m.model},但實際送出的請求用的是 ${ran.join("、")}。請檢查這個代理的設定。`, text: `實際:${ran.join("、")}` });
}

/** Tokens and cost beside a member or a team at work: "182K tokens · $0.04". */
function spend(usage: MemberView["usage"], title: string): HTMLElement | null {
  const s = usageSummary(usage, () => render());
  if (!s.tokens) return null;
  const text = `${fmtTokens(s.tokens)} tokens${s.usd != null ? ` · ${s.priced ? "" : "≥ "}${fmtMoney(s.usd)}` : ""}`;
  return h("span", { class: "chip spend", title: `${title}。預估成本依「成本與用量」的價格表計算。`, text });
}

/** The Office: the same record as the board, as rooms. `?office=mock` in a browser shows the spec's demo company. */
const office = new Office(
  {
    render: () => render(),
    dragEnded: () => {
      if (renderWaiting) {
        renderWaiting = false;
        render();
      }
    },
    showBoard: () => {
      monitorMode = "board";
      render();
    },
    openTeam: (teamId) => {
      const file = files.find((f) => f.config?.id === teamId);
      if (file) {
        select(file.file);
        tab = "monitor";
        monitorMode = "office";
      } else {
        place = "office";
        officeTeam = teamId;
      }
      render();
    },
    openTask: (teamId, taskId) => {
      const file = files.find((f) => f.config?.id === teamId);
      if (!file) return;
      if (selected !== file.file) select(file.file);
      openThread(teamId, taskId);
      tab = "log";
      render();
    },
    openArtifact: (teamId, ref) => (isImage(ref) ? openImage(teamId, ref) : void act(() => Bridge.teamOpen(teamId, ref))),
    preview: IS_TAURI ? (teamId, ref) => Bridge.teamPreview(teamId, ref) : undefined,
    // A plain browser (`npm run dev`) shows one made-up earlier run of the demo team.
    history: IS_TAURI ? (teamId) => Bridge.teamHistory(teamId) : import.meta.env.DEV ? async (teamId) => (teamId === "shop" ? (await import("./demo")).demoHistory() : []) : undefined,
    past: IS_TAURI ? (teamId, at) => Bridge.teamPast(teamId, at) : import.meta.env.DEV ? async () => (await import("./demo")).demoPast() : undefined,
    openSetup: (teamId) => {
      const file = files.find((f) => f.config?.id === teamId);
      if (file) select(file.file);
      tab = "setup";
      render();
    },
    pause: (teamId) => Bridge.teamPause(teamId),
    resume: (teamId) => Bridge.teamResume(teamId),
    instruct: (teamId, text, request) => Bridge.teamInstruct(teamId, "", text, request),
    asks: (teamId, memberId) => {
      const snap = runs.get(teamId);
      const m = snap?.members.find((x) => x.id === memberId);
      return snap && m ? asks(snap, m) : [];
    },
    trouble: () => trouble,
  },
  { demo: !IS_TAURI && new URLSearchParams(location.search).get("office") === "mock" },
);
// Development only: the office, to drive its scenes from the console.
if (import.meta.env.DEV && !IS_TAURI) Object.assign(window, { __office: office });

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
  // …and while a finger or the mouse is still on the 星域: rebuilding the page would drop the drag.
  if (menuOpen() || office.dragging()) {
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
  // Nodes kept across redraws (the 星域, its rings) were detached and put back: give them their focus back.
  if (active && active !== document.body && active.isConnected && document.activeElement !== active) active.focus({ preventScroll: true });
  live.afterRender();
  office.afterRender();
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
    await loadTeamAgents(() => {}, agents, true);
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
    await loadTeamAgents(() => {}, agents);
    if (!runs.has("shop")) {
      const snap = demo.demoSnapshot();
      runs.set("shop", snap);
      live.applySnapshot(snap);
      tab = "monitor";
      // `?view=office` / `?view=company` open the Office straight away, to look at it.
      const view = new URLSearchParams(location.search).get("view");
      if (view === "office") monitorMode = "office";
      const member = new URLSearchParams(location.search).get("member");
      if (member) office.sel = { teamId: "shop", memberId: member };
      demo.demoStream(live.applyPatch, (next) => {
        runs.set(next.id, next);
        live.applySnapshot(next);
        if (tab === "monitor") render();
      }, snap);
      // `&battle=play` plays a whole raid on the demo team, to look at 中二模式.
      if (new URLSearchParams(location.search).get("battle") === "play") {
        (await import("./battle-demo")).playBattle(snap, (next) => {
          runs.set(next.id, next);
          live.applySnapshot(next);
          office.feed(files, runs);
          render();
        });
      }
      // `&pose=combo_trinity:700` holds one move still, to look at it; `&calm=1` is 減少動態.
      const pose = new URLSearchParams(location.search).get("pose");
      if (pose) window.setTimeout(async () => (await import("./battle-demo")).poseBattle(office, "shop", pose), 800);
      const bpose = new URLSearchParams(location.search).get("bpose");
      if (bpose) window.setTimeout(async () => (await import("./battle-demo")).poseBossMove(office, "shop", bpose), 800);
      if (new URLSearchParams(location.search).get("calm") === "1") office.calm = true;
    }
  }
  office.feed(files, runs);
  if (!selected || !files.some((f) => f.file === selected)) {
    // The team that is running, else the first one not put away.
    const first = files.find((f) => f.config && runs.get(f.config.id)?.status === "running")?.file ?? (files.find((f) => !f.config?.archived) ?? files[0])?.file ?? null;
    if (first) select(first);
    else selected = null;
  } else if (!unsaved) {
    // The file may have been edited outside; an untouched form follows it.
    const again = files.find((f) => f.file === selected);
    editing = again?.config ? structuredClone(again.config) : null;
  }
  // A browser opened at `?view=company` starts on the company map.
  if (import.meta.env.DEV && !IS_TAURI && firstLoad && new URLSearchParams(location.search).get("view") === "company") place = "company";
  if (import.meta.env.DEV && !IS_TAURI && firstLoad && new URLSearchParams(location.search).get("view") === "cost") place = "cost";
  if (import.meta.env.DEV && !IS_TAURI && firstLoad && new URLSearchParams(location.search).get("view") === "secretary") place = "secretary";
  if (import.meta.env.DEV && !IS_TAURI && firstLoad && new URLSearchParams(location.search).get("view") === "setup") {
    tab = "setup";
    // `&adv=ai1` opens that member's 進階設定, to look at it.
    const adv = new URLSearchParams(location.search).get("adv");
    if (adv) advancedOpen.add(adv);
  }
  if (import.meta.env.DEV && !IS_TAURI && firstLoad && new URLSearchParams(location.search).get("view") === "law") place = "law";
  firstLoad = false;
  render();
}
let firstLoad = true;

async function start() {
  live.setSaid(said);
  await onEvent<Snapshot>("team-changed", (snap) => {
    const had = runs.get(snap.id);
    if (had && had.startedAt === snap.startedAt && snap.seq < had.seq) return;
    runs.set(snap.id, snap);
    live.applySnapshot(snap);
    office.feed(files, runs);
    // New tokens may have come in: the cost page asks again, a little later.
    if (place === "cost") refreshSoon(costHost);
    // Typing in the form is not interrupted by a team at work behind it.
    if (tab === "monitor" || !unsaved) render();
  });
  // Files dragged onto the window: into the knowledge base of the team being
  // set up, or with the next instruction to the team on screen.
  await onDragDrop((e) => {
    const target = dropTarget(place, tab);
    if (target === "knowledge") {
      const team = files.find((f) => f.file === selected)?.config?.id;
      if (!team) return;
      if (e.type === "enter" || e.type === "over") setDragging(true, knowledgeHost);
      else setDragging(false, knowledgeHost);
      if (e.type === "drop" && e.paths?.length) void addKnowledge(team, e.paths, knowledgeHost);
      return;
    }
    if (target === "secretary") {
      if (e.type === "drop" && e.paths?.length) void secretaryAttachPaths(e.paths, secretaryHost);
      return;
    }
    if (e.type !== "drop" || !e.paths?.length || target !== "attachment") return;
    const file = files.find((f) => f.file === selected);
    const team = file?.config ? runs.get(file.config.id) : undefined;
    if (!team) return;
    for (const path of e.paths) {
      const name = path.split(/[\\/]/).pop() ?? path;
      void attach(team.id, async () => ({ path: await Bridge.teamAttachPath(team.id, path), name, preview: null }));
    }
  });
  // What the secretary is doing while it works on a request.
  await onEvent<SecretaryStep>("secretary-step", (step) => secretaryStep(step, secretaryHost));
  // Each member's screen, as it happens: no redraw, just the lines.
  await onEvent<ScreenPatch>("team-screen", live.applyPatch);
  // A team's documents changed: here, by its leader sharing one, or by the secretary.
  await onEvent<{ team: string }>("team-knowledge-changed", ({ team }) => knowledgeChanged(team, knowledgeHost));
  // Team agents saved: what teams can start with may have changed.
  await onEvent("team-agents-changed", () => {
    void load().then(() => {
      if (!unsaved) render();
    });
  });
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
    if (e.button === 0 && e.detail === 1 && target.hasAttribute("data-drag")) {
      // The webview must not start a selection or its own drag while the
      // native move loop runs: on some machines the two fight and the
      // window jumps around.
      e.preventDefault();
      void Bridge.teamWindow("drag");
    }
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
